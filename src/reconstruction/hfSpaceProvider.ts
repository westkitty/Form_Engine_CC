import type { ReconstructionProvider, ProviderCapabilities, SourceImage, ReconMode, RemoteStatus, ProviderError, ViewLabel } from './types';
import { ProviderFailure } from './types';

/**
 * Free cloud reconstruction through the public TRELLIS Space on Hugging Face (MIT-licensed model,
 * runs on Hugging Face's free "ZeroGPU" hardware). No payment and no bridge server. Limits:
 *  - Hugging Face gives every visitor a small daily GPU allowance; a free Hugging Face account token
 *    (huggingface.co/settings/tokens, "read" scope) raises it. No paid plan is needed.
 *  - The Space is community-run and can be busy, sleeping or changed without notice.
 *  - Images are uploaded to the Space; Hugging Face/Space terms apply. Consent is required first.
 * API verified 2026-10-22 from /gradio_api/info: /start_session, /preprocess_image, /preprocess_images,
 * /generate_and_extract_glb(image, multiimages, seed, ss_guidance_strength, ss_sampling_steps,
 * slat_guidance_strength, slat_sampling_steps, multiimage_algo, mesh_simplify, texture_size) → [video, glb, glb].
 */
export const TRELLIS_SPACE = 'trellis-community/TRELLIS';

interface Run { stage: 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled'; position?: number; progress?: number; error?: string; glbUrl?: string; job?: { cancel: () => Promise<void> } }

export class HfSpaceProvider implements ReconstructionProvider {
  readonly id = `hf-space:${TRELLIS_SPACE}`;
  readonly label = 'TRELLIS on Hugging Face (free)';
  readonly kind = 'remote-bridge' as const;
  private runs = new Map<string, Run>();
  private seq = 0;
  constructor(private token: string | null) {}

  private async client() {
    const { Client } = await import('@gradio/client');
    try {
      return await Client.connect(TRELLIS_SPACE, this.token ? { token: this.token as `hf_${string}` } : {});
    } catch (e) {
      throw new ProviderFailure({ code: 'offline', message: `Could not reach the TRELLIS Space (${(e as Error)?.message ?? 'unknown'}). It may be sleeping, busy or offline.`, retryable: true });
    }
  }

  async capabilities(): Promise<ProviderCapabilities> {
    await this.client();
    return {
      provider: 'TRELLIS (Hugging Face Space)', modes: ['single', 'multi'], maxImages: 4, progress: 'discrete', cancel: 'any', outputFormats: ['glb'],
      retentionNote: 'Images and results are processed on a public Hugging Face Space; temporary files there are cleaned up by the Space, but you cannot delete them yourself.',
      pricingNote: 'Free. Uses Hugging Face\'s daily free GPU allowance (larger with a free account token). No payment possible or needed.',
    };
  }

  async estimate(images: SourceImage[], mode: ReconMode) {
    return {
      costNote: 'Free. Counts against Hugging Face\'s daily free GPU allowance (about 2 minutes of GPU per job).',
      dataSharing: `${mode === 'multi' ? images.length : 1} image(s) will be uploaded to the public Hugging Face Space ${TRELLIS_SPACE}.`,
    };
  }

  async prepareInput(images: SourceImage[], mode: ReconMode) {
    const list = mode === 'single' ? images.slice(0, 1) : images.slice(0, 4);
    // Images are passed as blobs through an object-URL-free path: keep them as data for submit().
    const urls = await Promise.all(list.map((i) => blobToDataURL(i.blob)));
    return { mode, images: urls, views: list.map((i) => i.view) as ViewLabel[] };
  }

  async submit(prepared: { mode: ReconMode; images: string[]; views: ViewLabel[] }, _options: Record<string, unknown>) {
    const { handle_file } = await import('@gradio/client');
    const c = await this.client();
    const id = `trellis-${Date.now().toString(36)}-${++this.seq}`;
    const run: Run = { stage: 'queued' };
    this.runs.set(id, run);
    const blobs = await Promise.all(prepared.images.map(async (u) => (await fetch(u)).blob()));
    try { await c.predict('/start_session', {}); } catch { /* older revisions have no session endpoint */ }
    let image: unknown, multi: unknown[] = [];
    try {
      if (prepared.mode === 'multi' && blobs.length > 1) {
        const pre = await c.predict('/preprocess_images', { images: blobs.map((b) => ({ image: handle_file(b), caption: null })) });
        multi = (pre.data as unknown[][])[0] ?? []; // [{ image, caption }, …]
        image = (multi[0] as { image?: unknown })?.image;
      } else {
        const pre = await c.predict('/preprocess_image', { image: handle_file(blobs[0]) });
        image = (pre.data as unknown[])[0];
      }
    } catch (e) { throw this.toFailure(e); }
    const job = c.submit('/generate_and_extract_glb', {
      image, multiimages: multi, seed: 0, ss_guidance_strength: 7.5, ss_sampling_steps: 12, slat_guidance_strength: 3, slat_sampling_steps: 12,
      multiimage_algo: 'stochastic', mesh_simplify: 0.95, texture_size: 1024,
    });
    run.job = job as unknown as Run['job'];
    (async () => {
      try {
        for await (const msg of job as AsyncIterable<any>) {
          if (msg.type === 'status') {
            if (msg.stage === 'pending') { run.stage = 'queued'; run.position = typeof msg.position === 'number' ? msg.position : undefined; }
            else if (msg.stage === 'generating') run.stage = 'processing';
            else if (msg.stage === 'error') { run.stage = 'failed'; run.error = humanError(msg.message); }
            const pd = msg.progress_data?.[0];
            run.progress = pd && typeof pd.index === 'number' && typeof pd.length === 'number' && pd.length > 0 ? Math.round((pd.index / pd.length) * 100) : undefined;
          } else if (msg.type === 'data') {
            const d = msg.data as any[];
            const glb = d?.[1]?.url ?? d?.[2]?.url;
            if (glb) { run.glbUrl = glb; run.stage = 'succeeded'; } else { run.stage = 'failed'; run.error = 'The Space finished without returning a GLB.'; }
          }
        }
      } catch (e) { run.stage = 'failed'; run.error = humanError((e as Error)?.message); }
      if (run.stage !== 'succeeded' && run.stage !== 'canceled' && run.stage !== 'failed') { run.stage = 'failed'; run.error ??= 'The Space closed the connection without a result.'; }
    })();
    return { remoteId: id };
  }

  async poll(remoteId: string): Promise<RemoteStatus> {
    const r = this.runs.get(remoteId);
    if (!r) throw new ProviderFailure({ code: 'not-found', message: 'This free-cloud job cannot be resumed after a reload; submit it again.', retryable: false });
    if (r.stage === 'failed' && r.error && /quota/i.test(r.error)) throw new ProviderFailure({ code: 'rate-limited', message: r.error, retryable: false });
    return { state: r.stage, progress: r.progress, queuePosition: r.position, error: r.error };
  }

  async cancel(remoteId: string) {
    const r = this.runs.get(remoteId);
    if (!r) return { canceled: false, note: 'Job not found in this session.' };
    try { await r.job?.cancel(); } catch { /* best effort */ }
    r.stage = 'canceled';
    return { canceled: true, note: 'Cancelled at the Space. Free jobs cost nothing either way.' };
  }

  async retrieveMesh(remoteId: string) {
    const r = this.runs.get(remoteId);
    if (!r?.glbUrl) throw new ProviderFailure({ code: 'not-found', message: 'No result URL.', retryable: false });
    let res: Response;
    try { res = await fetch(r.glbUrl, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} }); } catch { throw new ProviderFailure({ code: 'offline', message: 'Could not download the result from the Space.', retryable: true }); }
    if (res.status === 404 || res.status === 410) throw new ProviderFailure({ code: 'not-found', message: 'The Space already deleted the result file.', retryable: false });
    if (!res.ok) throw new ProviderFailure({ code: 'server', message: `Result download failed (${res.status}).`, retryable: true });
    const data = await res.arrayBuffer();
    if (data.byteLength > 300 * 1024 * 1024) throw new ProviderFailure({ code: 'bad-input', message: 'Returned model exceeds 300 MB.', retryable: false });
    return { data, fileName: `${remoteId}.glb` };
  }

  getError(e: unknown): ProviderError {
    if (e instanceof ProviderFailure) return e.info;
    return this.toFailure(e).info;
  }

  private toFailure(e: unknown) {
    const msg = humanError((e as Error)?.message ?? String(e));
    if (/quota/i.test(msg)) return new ProviderFailure({ code: 'rate-limited', message: msg, retryable: false });
    if (/token|unauthor|401|403/i.test(msg)) return new ProviderFailure({ code: 'needs-auth', message: msg, retryable: false });
    return new ProviderFailure({ code: 'server', message: msg, retryable: false });
  }
}

function humanError(m: string | undefined) {
  const s = String(m ?? 'Unknown error from the Space').slice(0, 400);
  if (/ZeroGPU quota/i.test(s)) return `Hugging Face's free GPU allowance is used up for now: ${s} Add a free Hugging Face token in the connection settings for a larger allowance, or use On-device 3D (no limits).`;
  return s;
}

function blobToDataURL(b: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
}
