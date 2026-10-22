import type { Field } from './depthMesh';

/**
 * On-device monocular depth estimation with Depth Anything V2 Small (Apache-2.0) via transformers.js.
 * Free and private: the image never leaves the device. The model (~27 MB, int8) and the ONNX Runtime
 * WebAssembly files are downloaded once from Hugging Face / jsDelivr and cached by the browser.
 * transformers.js is imported lazily so the editor itself does not pay for it.
 */
export const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small';
export const DEPTH_MODEL_LICENSE = 'Apache-2.0';
export const DEPTH_MODEL_SIZE_MB = 27;

export interface DepthProgress { phase: 'loading-library' | 'downloading' | 'running' | 'done'; file?: string; loaded?: number; total?: number }

let pipePromise: Promise<any> | null = null;

/** True where this build can reach the model hosts (the Claude Artifact sandbox cannot). */
export const ON_DEVICE_AVAILABLE = import.meta.env?.MODE !== 'artifact';

async function getPipeline(onProgress: (p: DepthProgress) => void) {
  if (!pipePromise) {
    pipePromise = (async () => {
      onProgress({ phase: 'loading-library' });
      const tf = await import('@huggingface/transformers');
      tf.env.allowLocalModels = false;
      const bytes = new Map<string, { loaded: number; total: number }>();
      return tf.pipeline('depth-estimation', DEPTH_MODEL, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: (e: any) => {
          if (e?.status === 'progress' && e.file) {
            bytes.set(e.file, { loaded: e.loaded ?? 0, total: e.total ?? 0 });
            let loaded = 0, total = 0;
            for (const v of bytes.values()) { loaded += v.loaded; total += v.total; }
            onProgress({ phase: 'downloading', file: e.file, loaded, total });
          }
        },
      });
    })();
    pipePromise.catch(() => { pipePromise = null; }); // allow retry after a failed download
  }
  return pipePromise;
}

/** Estimate relative depth (larger = nearer) for an image canvas. */
export async function estimateDepth(canvas: HTMLCanvasElement, onProgress: (p: DepthProgress) => void = () => {}): Promise<Field> {
  const pipe = await getPipeline(onProgress);
  onProgress({ phase: 'running' });
  const { RawImage } = await import('@huggingface/transformers');
  const image = RawImage.fromCanvas(canvas);
  const out = await pipe(image);
  const t = out.predicted_depth;
  const dims: number[] = t.dims;
  const [height, width] = dims.slice(-2);
  const data = Float32Array.from(t.data as ArrayLike<number>);
  onProgress({ phase: 'done' });
  return { data, width, height };
}

/** Alpha channel of a canvas as a mask field, or null when the image is fully opaque. */
export function alphaMask(canvas: HTMLCanvasElement): Field | null {
  const s = Math.min(1, 512 / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * s)), h = Math.max(1, Math.round(canvas.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h);
  let transparent = 0;
  for (let i = 0; i < w * h; i++) { data[i] = d[i * 4 + 3] / 255; if (d[i * 4 + 3] < 128) transparent++; }
  return transparent > w * h * 0.02 ? { data, width: w, height: h } : null;
}
