import type { ReconstructionProvider, ReconMode, SourceImage, RemoteStatus, ProviderError } from './types';
import { ProviderFailure } from './types';

export type JobState =
  | 'idle' | 'validating' | 'ready' | 'awaiting-consent' | 'submitting' | 'queued' | 'processing'
  | 'downloading' | 'verifying' | 'ready-to-edit'
  | 'failed' | 'canceled' | 'expired' | 'offline' | 'needs-auth';

/** Allowed transitions. Anything else is a programming error and throws. */
export const TRANSITIONS: Record<JobState, JobState[]> = {
  'idle': ['validating'],
  'validating': ['ready', 'failed'],
  'ready': ['awaiting-consent', 'canceled'],
  'awaiting-consent': ['submitting', 'canceled', 'ready'],
  'submitting': ['queued', 'processing', 'failed', 'offline', 'needs-auth', 'canceled'],
  'queued': ['queued', 'processing', 'downloading', 'failed', 'canceled', 'expired', 'offline', 'needs-auth'],
  'processing': ['processing', 'downloading', 'failed', 'canceled', 'expired', 'offline', 'needs-auth'],
  'downloading': ['verifying', 'failed', 'expired', 'offline', 'canceled'],
  'verifying': ['ready-to-edit', 'failed'],
  'ready-to-edit': [],
  'failed': ['ready'],
  'canceled': ['ready'],
  'expired': ['ready'],
  // offline / needs-auth can resume polling (if a remote id exists) or go back to ready
  'offline': ['queued', 'processing', 'downloading', 'ready', 'canceled', 'failed'],
  'needs-auth': ['ready', 'queued', 'processing', 'canceled'],
};

export const TERMINAL: JobState[] = ['ready-to-edit', 'failed', 'canceled', 'expired'];

export interface JobRecord {
  id: string;
  providerId: string;
  mode: ReconMode;
  state: JobState;
  remoteId?: string;
  /** Real provider-reported progress only. */
  progress?: number;
  queuePosition?: number;
  sourceImageIds: string[];
  history: { state: JobState; at: string; note?: string }[];
  error?: ProviderError;
  consent?: { at: string; provider: string; imageCount: number; text: string };
  createdAt: string;
  updatedAt: string;
  result?: { fileName: string; bytes: number };
}

export function newJob(id: string, providerId: string, mode: ReconMode, images: SourceImage[]): JobRecord {
  const now = new Date().toISOString();
  return { id, providerId, mode, state: 'idle', sourceImageIds: images.map((i) => i.id), history: [{ state: 'idle', at: now }], createdAt: now, updatedAt: now };
}

export function transition(job: JobRecord, to: JobState, note?: string): JobRecord {
  if (!TRANSITIONS[job.state].includes(to)) throw new Error(`Illegal job transition ${job.state} → ${to}`);
  const at = new Date().toISOString();
  return { ...job, state: to, updatedAt: at, history: [...job.history, { state: to, at, note }] };
}

export interface RunnerHooks {
  onUpdate(job: JobRecord): void;
  /** Called with the downloaded bytes; must parse + validate and throw on failure. */
  verify(data: ArrayBuffer, fileName: string): Promise<void>;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  now?(): number;
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});

/**
 * Drives one job through the lifecycle. Key guarantees:
 *  - `submit` is called at most once per run; poll/download failures never re-submit (no duplicate charges).
 *  - Polling honours Retry-After and backs off; network loss → 'offline' and the job can be resumed by id.
 *  - 'ready-to-edit' is only reached after the mesh bytes were downloaded and `verify` succeeded.
 */
export class JobRunner {
  private ac = new AbortController();
  job: JobRecord;
  private bytes: ArrayBuffer | null = null;
  private fileName = '';
  constructor(private provider: ReconstructionProvider, job: JobRecord, private hooks: RunnerHooks, private opts = { pollMs: 4000, maxPollMs: 30000, maxPollErrors: 6, timeoutMs: 30 * 60_000 }) {
    this.job = job;
  }

  private set(to: JobState, patch: Partial<JobRecord> = {}, note?: string) {
    this.job = { ...transition(this.job, to, note), ...patch };
    this.hooks.onUpdate(this.job);
  }

  get resultBytes() { return this.bytes; }
  get resultFileName() { return this.fileName; }

  /** User consented: submit once, then poll to completion. */
  async submitAndRun(images: SourceImage[], options: Record<string, unknown>, consentText: string) {
    this.set('submitting', { consent: { at: new Date().toISOString(), provider: this.provider.id, imageCount: images.length, text: consentText } });
    let remoteId: string;
    try {
      const prepared = await this.provider.prepareInput(images, this.job.mode);
      ({ remoteId } = await this.provider.submit(prepared, options, this.ac.signal));
    } catch (e) {
      return this.fail(this.provider.getError(e));
    }
    this.set('queued', { remoteId }, `remote task ${remoteId}`);
    return this.pollLoop();
  }

  /** Resume polling an existing remote task (after reload/offline). Never re-submits. */
  async resume() {
    if (!this.job.remoteId) throw new Error('No remote task to resume');
    if (this.job.state === 'offline' || this.job.state === 'needs-auth') this.set('queued', {}, 'resumed');
    return this.pollLoop();
  }

  private async pollLoop(): Promise<JobRecord> {
    const sleep = this.hooks.sleep ?? defaultSleep;
    const now = this.hooks.now ?? (() => Date.now());
    const started = now();
    let delay = this.opts.pollMs, errors = 0;
    while (true) {
      if (now() - started > this.opts.timeoutMs) return this.fail({ code: 'server', message: 'Gave up waiting for the provider (timeout). The remote task may still finish; resume by task id later.', retryable: true });
      let st: RemoteStatus;
      try {
        st = await this.provider.poll(this.job.remoteId!, this.ac.signal);
        errors = 0;
      } catch (e) {
        const err = this.provider.getError(e);
        if (err.code === 'aborted') return this.job;
        if (err.code === 'needs-auth') { this.set('needs-auth', { error: err }); return this.job; }
        if (err.code === 'offline') { this.set('offline', { error: err }); return this.job; }
        if (!err.retryable || ++errors > this.opts.maxPollErrors) return this.fail(err);
        delay = Math.min(this.opts.maxPollMs, Math.max(err.retryAfterMs ?? 0, delay * 2));
        try { await sleep(delay, this.ac.signal); } catch { return this.job; }
        continue;
      }
      if (st.state === 'failed') return this.fail({ code: 'server', message: st.error || 'Provider reported failure.', retryable: false });
      if (st.state === 'canceled') { this.set('canceled', {}, 'canceled upstream'); return this.job; }
      if (st.state === 'expired') { this.set('expired', {}, 'result expired'); return this.job; }
      if (st.state === 'succeeded') return this.download();
      const next = st.state === 'queued' ? 'queued' : 'processing';
      this.set(next, { progress: st.progress, queuePosition: st.queuePosition });
      try { await sleep(delay, this.ac.signal); } catch { return this.job; }
      delay = Math.min(this.opts.maxPollMs, delay * 1.25);
    }
  }

  private async download(): Promise<JobRecord> {
    this.set('downloading', { progress: 100 });
    try {
      const { data, fileName } = await this.provider.retrieveMesh(this.job.remoteId!, this.ac.signal);
      this.bytes = data; this.fileName = fileName;
    } catch (e) {
      const err = this.provider.getError(e);
      if (err.code === 'offline') { this.set('offline', { error: err }); return this.job; }
      if (err.code === 'not-found') { this.set('expired', { error: err }, 'result URL expired or missing'); return this.job; }
      return this.fail(err);
    }
    this.set('verifying');
    try {
      await this.hooks.verify(this.bytes!, this.fileName);
    } catch (e) {
      return this.fail({ code: 'bad-input', message: `Returned model failed validation: ${(e as Error).message}`, retryable: false });
    }
    this.set('ready-to-edit', { result: { fileName: this.fileName, bytes: this.bytes!.byteLength } });
    return this.job;
  }

  private fail(err: ProviderError): JobRecord {
    if (err.code === 'aborted') return this.job;
    if (err.code === 'needs-auth' && TRANSITIONS[this.job.state].includes('needs-auth')) { this.set('needs-auth', { error: err }); return this.job; }
    if (err.code === 'offline' && TRANSITIONS[this.job.state].includes('offline')) { this.set('offline', { error: err }); return this.job; }
    this.set('failed', { error: err }, err.message);
    return this.job;
  }

  /** Stop local polling and ask the provider to cancel. Honest about what upstream allowed. */
  async cancel(): Promise<string> {
    this.ac.abort();
    let note = 'Local polling stopped.';
    if (this.job.remoteId) {
      try { const r = await this.provider.cancel(this.job.remoteId); note = r.note; } catch (e) { note = `Remote cancel failed: ${this.provider.getError(e).message}`; }
    }
    if (TRANSITIONS[this.job.state].includes('canceled')) this.set('canceled', {}, note);
    return note;
  }

  dispose() { this.ac.abort(); }
}

export function isFailure(e: unknown): e is ProviderFailure { return e instanceof ProviderFailure; }
