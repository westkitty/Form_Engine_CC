import type { ReconstructionProvider, ProviderCapabilities, SourceImage, ReconMode, RemoteStatus, ProviderError, ViewLabel } from './types';
import { ProviderFailure } from './types';

/**
 * Talks the FORM Bridge v1 protocol (see docs/PROVIDERS.md). The bridge is a small server the user runs
 * (server/reconstruction-proxy.mjs → Meshy, or any local private inference server implementing the same
 * five routes). Provider API keys live only on the bridge; the browser may hold an optional bridge access
 * token in memory (never persisted to projects, storage, URLs or logs).
 */
export class BridgeProvider implements ReconstructionProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: 'remote-bridge' | 'local-bridge';
  constructor(readonly baseUrl: string, private token: string | null, opts: { label?: string; local?: boolean } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.kind = opts.local ? 'local-bridge' : 'remote-bridge';
    this.id = `bridge:${this.baseUrl}`;
    this.label = opts.label ?? `Bridge @ ${this.baseUrl}`;
  }

  private async req(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, { ...init, headers, signal, credentials: 'omit', mode: 'cors', redirect: 'error' });
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') throw new ProviderFailure({ code: 'aborted', message: 'Aborted', retryable: false });
      throw new ProviderFailure({ code: 'offline', message: `Cannot reach the bridge at ${this.baseUrl} (offline, wrong URL, or CORS not allowed for this origin).`, retryable: true });
    }
    if (res.ok) return res;
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.clone().json(); if (j?.error) msg = String(j.error).slice(0, 400); } catch { /* not JSON */ }
    const ra = res.headers.get('Retry-After');
    const retryAfterMs = ra ? (Number.isFinite(+ra) ? +ra * 1000 : Math.max(0, Date.parse(ra) - Date.now())) : undefined;
    const map: Record<number, ProviderError['code']> = { 401: 'needs-auth', 403: 'needs-auth', 402: 'insufficient-credits', 400: 'bad-input', 404: 'not-found', 410: 'not-found', 429: 'rate-limited' };
    const code = map[res.status] ?? (res.status >= 500 ? 'server' : 'unknown');
    throw new ProviderFailure({ code, message: msg, retryable: code === 'rate-limited' || code === 'server', retryAfterMs });
  }

  async capabilities(signal?: AbortSignal): Promise<ProviderCapabilities> {
    const r = await this.req('/v1/capabilities', {}, signal);
    const j = await r.json();
    return {
      provider: String(j.provider ?? 'unknown'), modes: Array.isArray(j.modes) ? j.modes.filter((m: string) => m === 'single' || m === 'multi') : ['single'],
      maxImages: Math.max(1, Math.min(16, Number(j.maxImages) || 1)), progress: j.progress === 'percent' ? 'percent' : 'discrete',
      cancel: ['pending-only', 'any', 'none'].includes(j.cancel) ? j.cancel : 'none', outputFormats: Array.isArray(j.outputFormats) ? j.outputFormats.map(String) : ['glb'],
      retentionNote: j.retentionNote ? String(j.retentionNote).slice(0, 300) : undefined, pricingNote: j.pricingNote ? String(j.pricingNote).slice(0, 300) : undefined,
    };
  }

  async estimate(images: SourceImage[], mode: ReconMode) {
    let caps: ProviderCapabilities | null = null;
    try { caps = await this.capabilities(); } catch { /* shown as unknown */ }
    return {
      costNote: caps?.pricingNote ?? 'Cost unknown — check your provider account. A submitted job may consume paid credits.',
      dataSharing: `${images.length} image(s) (${mode === 'multi' ? 'multi-view' : 'single view'}) will be sent to the bridge at ${this.baseUrl}${caps ? ` and forwarded to ${caps.provider}` : ''}. ${caps?.retentionNote ?? 'Provider retention terms apply.'}`,
    };
  }

  async prepareInput(images: SourceImage[], mode: ReconMode) {
    const list = mode === 'single' ? images.slice(0, 1) : images;
    const urls = await Promise.all(list.map((i) => blobToDataURL(i.blob)));
    return { mode, images: urls, views: list.map((i) => i.view) as ViewLabel[] };
  }

  async submit(prepared: { mode: ReconMode; images: string[]; views: ViewLabel[] }, options: Record<string, unknown>, signal?: AbortSignal) {
    const r = await this.req('/v1/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: prepared.mode, images: prepared.images, views: prepared.views, options }) }, signal);
    const j = await r.json();
    if (!j?.id || typeof j.id !== 'string') throw new ProviderFailure({ code: 'server', message: 'Bridge did not return a task id.', retryable: false });
    return { remoteId: j.id };
  }

  async poll(remoteId: string, signal?: AbortSignal): Promise<RemoteStatus> {
    const r = await this.req(`/v1/jobs/${encodeURIComponent(remoteId)}`, {}, signal);
    const j = await r.json();
    const states = ['queued', 'processing', 'succeeded', 'failed', 'canceled', 'expired'];
    if (!states.includes(j.status)) throw new ProviderFailure({ code: 'server', message: `Unknown status "${String(j.status).slice(0, 40)}"`, retryable: false });
    return {
      state: j.status, progress: typeof j.progress === 'number' ? Math.max(0, Math.min(100, j.progress)) : undefined,
      queuePosition: typeof j.queuePosition === 'number' ? j.queuePosition : undefined, error: j.error ? String(j.error).slice(0, 400) : undefined,
      expiresAt: typeof j.expiresAt === 'number' ? j.expiresAt : undefined,
    };
  }

  async cancel(remoteId: string) {
    const r = await this.req(`/v1/jobs/${encodeURIComponent(remoteId)}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    return { canceled: !!j.canceled, note: String(j.note ?? (j.canceled ? 'Canceled at provider.' : 'Provider did not confirm cancellation; the task may still run and consume credits.')).slice(0, 300) };
  }

  async retrieveMesh(remoteId: string, signal?: AbortSignal) {
    const r = await this.req(`/v1/jobs/${encodeURIComponent(remoteId)}/model?format=glb`, {}, signal);
    const len = Number(r.headers.get('Content-Length') ?? 0);
    if (len > 300 * 1024 * 1024) throw new ProviderFailure({ code: 'bad-input', message: 'Returned model exceeds 300 MB.', retryable: false });
    const data = await r.arrayBuffer();
    if (data.byteLength < 20) throw new ProviderFailure({ code: 'bad-input', message: 'Returned model is empty.', retryable: false });
    return { data, fileName: `reconstruction_${remoteId.replace(/[^\w-]/g, '').slice(0, 24)}.glb` };
  }

  getError(e: unknown): ProviderError {
    if (e instanceof ProviderFailure) return e.info;
    if ((e as DOMException)?.name === 'AbortError') return { code: 'aborted', message: 'Aborted', retryable: false };
    return { code: 'unknown', message: String((e as Error)?.message ?? e).slice(0, 400), retryable: false };
  }
}

export function blobToDataURL(b: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
}
