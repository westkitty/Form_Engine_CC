import * as THREE from 'three';

/**
 * Mode 5 — 2.5D relief. Builds a closed slab whose front surface is displaced by image luminance (or
 * alpha silhouette). This is NOT 3D reconstruction: there is no inferred back or side geometry. The
 * result is real, editable geometry and is labelled as relief everywhere.
 */
export interface ReliefOptions {
  /** Grid resolution along the longer image side. */
  resolution: number;
  /** Relief depth relative to width. */
  depth: number;
  /** Base slab thickness relative to width. */
  base: number;
  source: 'luminance' | 'alpha' | 'luminance-in-alpha';
  invert: boolean;
  /** Box-blur passes applied to the height map. */
  smooth: number;
}

export const DEFAULT_RELIEF: ReliefOptions = { resolution: 160, depth: 0.12, base: 0.03, source: 'luminance-in-alpha', invert: false, smooth: 1 };

export function heightMapFromImageData(data: Uint8ClampedArray, w: number, h: number, nx: number, ny: number, o: ReliefOptions): Float32Array {
  const out = new Float32Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const px = Math.min(w - 1, Math.round((i / nx) * (w - 1)));
      const py = Math.min(h - 1, Math.round((j / ny) * (h - 1)));
      const k = (py * w + px) * 4;
      const lum = (0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2]) / 255;
      const a = data[k + 3] / 255;
      let v = o.source === 'alpha' ? a : o.source === 'luminance' ? lum : lum * a;
      if (o.invert) v = o.source === 'alpha' ? 1 - v : (1 - lum) * (o.source === 'luminance-in-alpha' ? a : 1);
      out[j * (nx + 1) + i] = v;
    }
  }
  for (let s = 0; s < o.smooth; s++) {
    const copy = out.slice();
    for (let j = 1; j < ny; j++) for (let i = 1; i < nx; i++) {
      const id = j * (nx + 1) + i;
      out[id] = (copy[id] * 4 + copy[id - 1] + copy[id + 1] + copy[id - nx - 1] + copy[id + nx + 1]) / 8;
    }
  }
  // edges stay at zero so the slab closes cleanly
  for (let i = 0; i <= nx; i++) { out[i] = 0; out[ny * (nx + 1) + i] = 0; }
  for (let j = 0; j <= ny; j++) { out[j * (nx + 1)] = 0; out[j * (nx + 1) + nx] = 0; }
  return out;
}

/** Closed watertight slab: displaced front grid, flat back grid, four side walls. Width = 1 unit. */
export function buildRelief(heights: Float32Array, nx: number, ny: number, aspect: number, o: ReliefOptions): THREE.BufferGeometry {
  const W = 1, H = W / aspect;
  const front = (nx + 1) * (ny + 1);
  const pos = new Float32Array(front * 2 * 3);
  const uv = new Float32Array(front * 2 * 2);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const id = j * (nx + 1) + i;
    const x = (i / nx - 0.5) * W, y = (0.5 - j / ny) * H;
    pos.set([x, y, o.base + heights[id] * o.depth * W], id * 3);
    pos.set([x, y, 0], (front + id) * 3);
    uv.set([i / nx, 1 - j / ny], id * 2);
    uv.set([i / nx, 1 - j / ny], (front + id) * 2);
  }
  const idx: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx.push(a, c, b, b, c, d); // front faces +z
    idx.push(front + a, front + b, front + c, front + b, front + d, front + c); // back faces -z
  }
  const wall = (a: number, b: number) => idx.push(a, front + a, b, b, front + a, front + b);
  for (let i = 0; i < nx; i++) { wall(i + 1, i); wall(ny * (nx + 1) + i, ny * (nx + 1) + i + 1); }
  for (let j = 0; j < ny; j++) { wall(j * (nx + 1), (j + 1) * (nx + 1)); wall((j + 1) * (nx + 1) + nx, j * (nx + 1) + nx); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  g.computeVertexNormals();
  return g;
}

export async function reliefFromImage(bitmap: ImageBitmap | HTMLCanvasElement, o: ReliefOptions = DEFAULT_RELIEF) {
  const w = bitmap.width, h = bitmap.height;
  const scale = Math.min(1, 1024 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch).data;
  const aspect = cw / ch;
  const nx = aspect >= 1 ? o.resolution : Math.max(8, Math.round(o.resolution * aspect));
  const ny = aspect >= 1 ? Math.max(8, Math.round(o.resolution / aspect)) : o.resolution;
  return buildRelief(heightMapFromImageData(data, cw, ch, nx, ny, o), nx, ny, aspect, o);
}
