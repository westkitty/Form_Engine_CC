/**
 * Provider-neutral image → mesh reconstruction contract. A provider talks to a real service (directly or
 * through a bridge). Nothing here fabricates progress or results: `poll` returns exactly what the service
 * reported, and success is only declared by the job runner after a mesh is downloaded and validated.
 */
export type ReconMode = 'single' | 'multi';
export type ViewLabel = 'front' | 'right' | 'back' | 'left' | 'top' | 'other';

export interface SourceImage {
  id: string;
  name: string;
  view: ViewLabel;
  mime: string;
  width: number;
  height: number;
  /** Prepared (cropped/rotated/downscaled) bytes that would be uploaded. */
  blob: Blob;
}

export interface ProviderCapabilities {
  provider: string;
  modes: ReconMode[];
  maxImages: number;
  /** 'percent' when the service reports real percentages, 'discrete' when only states. */
  progress: 'percent' | 'discrete';
  /** What cancel can actually do upstream. */
  cancel: 'pending-only' | 'any' | 'none';
  outputFormats: string[];
  retentionNote?: string;
  pricingNote?: string;
}

export interface Estimate {
  /** Unverified unless the provider returned it. */
  costNote: string;
  dataSharing: string;
}

export type RemoteState = 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'expired';

export interface RemoteStatus {
  state: RemoteState;
  /** Only present when the provider reports a real number. */
  progress?: number;
  queuePosition?: number;
  error?: string;
  expiresAt?: number;
}

export interface ProviderError {
  code: 'needs-auth' | 'rate-limited' | 'offline' | 'bad-input' | 'insufficient-credits' | 'not-found' | 'server' | 'aborted' | 'unknown';
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface ReconstructionProvider {
  readonly id: string;
  readonly label: string;
  /** 'test-fixture' providers are never offered in the product UI. */
  readonly kind: 'remote-bridge' | 'local-bridge' | 'test-fixture';
  capabilities(signal?: AbortSignal): Promise<ProviderCapabilities>;
  estimate(images: SourceImage[], mode: ReconMode): Promise<Estimate>;
  prepareInput(images: SourceImage[], mode: ReconMode): Promise<{ mode: ReconMode; images: string[]; views: ViewLabel[] }>;
  submit(prepared: { mode: ReconMode; images: string[]; views: ViewLabel[] }, options: Record<string, unknown>, signal?: AbortSignal): Promise<{ remoteId: string }>;
  poll(remoteId: string, signal?: AbortSignal): Promise<RemoteStatus>;
  cancel(remoteId: string): Promise<{ canceled: boolean; note: string }>;
  retrieveMesh(remoteId: string, signal?: AbortSignal): Promise<{ data: ArrayBuffer; fileName: string }>;
  getError(e: unknown): ProviderError;
}

export class ProviderFailure extends Error {
  constructor(readonly info: ProviderError) { super(info.message); }
}
