import * as THREE from 'three';

/**
 * On-device single-view reconstruction geometry ("depth shell").
 *
 * Input: a relative depth map from a monocular depth model (larger = nearer) and a subject mask.
 * Output: a closed, watertight, editable mesh:
 *  - front surface: the estimated depth, inside the subject silhouette;
 *  - back surface: inferred (a flattened mirror of the front; nothing about the back is observed);
 *  - side walls joining both along the silhouette.
 * A rounded profile (thickness rising from the rim toward the interior) keeps the silhouette from looking
 * like a cut-out. Width is normalised to 1 unit; the result faces +Z (towards a front-view camera).
 */
export interface DepthShellOptions {
  /** Grid cells along the longer side. */
  resolution: number;
  /** Depth relief relative to width. */
  depthStrength: number;
  /** Base thickness (front + back) relative to width, before depth relief. */
  thickness: number;
  /** Back surface depth as a fraction of the front's relief (inferred). */
  backRatio: number;
  /** Rim thickness as a fraction of full thickness (silhouette edge). */
  rim: number;
  /** Box-blur passes on the depth map (estimated depth is noisy). */
  smooth: number;
}

export const DEFAULT_DEPTH_SHELL: DepthShellOptions = { resolution: 160, depthStrength: 0.35, thickness: 0.22, backRatio: 0.55, rim: 0.12, smooth: 2 };

export interface Field { data: Float32Array; width: number; height: number }

/** Bilinear sample of a field at normalised coordinates (u right, v down). */
export function sample(f: Field, u: number, v: number) {
  const x = Math.min(f.width - 1, Math.max(0, u * (f.width - 1)));
  const y = Math.min(f.height - 1, Math.max(0, v * (f.height - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(f.width - 1, x0 + 1), y1 = Math.min(f.height - 1, y0 + 1);
  const tx = x - x0, ty = y - y0, d = f.data, w = f.width;
  return (d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx) * (1 - ty) + (d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx) * ty;
}

/** Otsu threshold of values in [0,1] (used to separate a near subject from its background in a depth map). */
export function otsu(values: Float32Array): number {
  const bins = new Float64Array(256);
  for (const v of values) bins[Math.min(255, Math.max(0, Math.round(v * 255)))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * bins[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let i = 0; i < 256; i++) {
    wB += bins[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * bins[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = i; }
  }
  return (thr + 0.5) / 255;
}

/** Keep only the largest 4-connected component of a binary grid; fill its interior holes. */
export function largestComponent(mask: Uint8Array, w: number, h: number): Uint8Array {
  const label = new Int32Array(w * h).fill(-1);
  let bestLabel = -1, bestSize = 0, next = 0;
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    let size = 0;
    label[i] = next; stack.push(i);
    while (stack.length) {
      const p = stack.pop()!; size++;
      const x = p % w, y = (p - x) / w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && mask[q] && label[q] < 0) { label[q] = next; stack.push(q); }
      }
    }
    if (size > bestSize) { bestSize = size; bestLabel = next; }
    next++;
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = label[i] === bestLabel ? 1 : 0;
  // fill holes: background reachable from the border stays background
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i - x) / w;
    if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && !out[i] && !outside[i]) {
      outside[i] = 1; stack.push(i);
      while (stack.length) {
        const p = stack.pop()!; const px = p % w, py = (p - px) / w;
        for (const q of [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, py > 0 ? p - w : -1, py < h - 1 ? p + w : -1]) {
          if (q >= 0 && !out[q] && !outside[q]) { outside[q] = 1; stack.push(q); }
        }
      }
    }
  }
  for (let i = 0; i < w * h; i++) if (!out[i] && !outside[i]) out[i] = 1;
  return out;
}

/** Morphological opening (erode then dilate) with a 4-neighbourhood: removes 1-cell spurs and strips. */
export function open(mask: Uint8Array, w: number, h: number): Uint8Array {
  const at = (m: Uint8Array, x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : m[y * w + x]);
  const er = new Uint8Array(w * h), di = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) er[y * w + x] = at(mask, x, y) & at(mask, x - 1, y) & at(mask, x + 1, y) & at(mask, x, y - 1) & at(mask, x, y + 1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) di[y * w + x] = at(er, x, y) | at(er, x - 1, y) | at(er, x + 1, y) | at(er, x, y - 1) | at(er, x, y + 1);
  return di;
}

/** Two-pass chamfer distance (in cells) from each inside cell to the nearest outside cell. */
export function distanceInside(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  const a = 1, b = Math.SQRT2;
  const g = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!d[i]) continue;
    d[i] = Math.min(d[i], g(x - 1, y) + a, g(x, y - 1) + a, g(x - 1, y - 1) + b, g(x + 1, y - 1) + b);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!d[i]) continue;
    d[i] = Math.min(d[i], g(x + 1, y) + a, g(x, y + 1) + a, g(x + 1, y + 1) + b, g(x - 1, y + 1) + b);
  }
  return d;
}

export interface DepthShellInput {
  /** Relative depth, larger = nearer, any range. */
  depth: Field;
  /** Subject mask in [0,1] (alpha or segmentation), same aspect as the image. Null → derived from depth (Otsu). */
  mask: Field | null;
  /** Image aspect ratio (width / height). */
  aspect: number;
}

export interface DepthShellResult {
  geometry: THREE.BufferGeometry;
  maskSource: 'alpha' | 'depth-threshold' | 'full-frame';
  coverage: number;
  grid: { nx: number; ny: number };
}

export function buildDepthShell(input: DepthShellInput, o: DepthShellOptions = DEFAULT_DEPTH_SHELL): DepthShellResult {
  const aspect = input.aspect;
  const nx = aspect >= 1 ? o.resolution : Math.max(16, Math.round(o.resolution * aspect));
  const ny = aspect >= 1 ? Math.max(16, Math.round(o.resolution / aspect)) : o.resolution;
  const W = nx + 1, H = ny + 1, N = W * H;

  // 1. depth on the vertex grid, normalised with robust percentiles
  let dep = new Float32Array(N);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) dep[j * W + i] = sample(input.depth, i / nx, j / ny);
  const sorted = Float32Array.from(dep).sort();
  const lo = sorted[Math.floor(N * 0.02)], hi = sorted[Math.floor(N * 0.98)];
  const span = hi - lo || 1;
  for (let k = 0; k < N; k++) dep[k] = Math.min(1, Math.max(0, (dep[k] - lo) / span));
  for (let s = 0; s < o.smooth; s++) {
    const c = dep.slice();
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) { const k = j * W + i; dep[k] = (c[k] * 4 + c[k - 1] + c[k + 1] + c[k - W] + c[k + W]) / 8; }
  }

  // 2. subject mask on the grid
  let maskSource: DepthShellResult['maskSource'];
  let mask: Uint8Array = new Uint8Array(N);
  if (input.mask) {
    maskSource = 'alpha';
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) mask[j * W + i] = sample(input.mask, i / nx, j / ny) > 0.5 ? 1 : 0;
  } else {
    maskSource = 'depth-threshold';
    const t = otsu(dep);
    for (let k = 0; k < N; k++) mask[k] = dep[k] > t ? 1 : 0;
  }
  // the outermost ring stays outside so the shell has a rim
  for (let i = 0; i < W; i++) { mask[i] = 0; mask[(H - 1) * W + i] = 0; }
  for (let j = 0; j < H; j++) { mask[j * W] = 0; mask[j * W + W - 1] = 0; }
  mask = largestComponent(open(mask, W, H), W, H);
  let inside = 0;
  for (let k = 0; k < N; k++) inside += mask[k];
  if (inside < N * 0.01) {
    // no usable subject: fall back to the whole frame (minus the rim)
    maskSource = 'full-frame';
    mask.fill(0);
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) mask[j * W + i] = 1;
    inside = (W - 2) * (H - 2);
  }

  // 3. rounded profile from the silhouette
  const dist = distanceInside(mask, W, H);
  let maxD = 0;
  for (let k = 0; k < N; k++) if (dist[k] > maxD) maxD = dist[k];
  const R = Math.max(1, maxD * 0.55);
  // depth relative to the subject's own far plane
  let dMin = Infinity;
  for (let k = 0; k < N; k++) if (mask[k] && dep[k] < dMin) dMin = dep[k];

  // 4. vertices: front grid + back grid
  const Wd = 1, Hd = Wd / aspect;
  const pos = new Float32Array(N * 2 * 3), uv = new Float32Array(N * 2 * 2);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    const x = (i / nx - 0.5) * Wd, y = (0.5 - j / ny) * Hd;
    const t = Math.min(1, dist[k] / R);
    const profile = o.rim + (1 - o.rim) * Math.sin((t * Math.PI) / 2);
    const rel = mask[k] ? Math.max(0, dep[k] - dMin) : 0;
    const half = (o.thickness * Wd) / 2;
    const zf = profile * (half + o.depthStrength * Wd * rel);
    const zb = -profile * (half + o.depthStrength * Wd * rel * o.backRatio);
    pos.set([x, y, zf], k * 3);
    pos.set([x, y, zb], (N + k) * 3);
    uv.set([i / nx, 1 - j / ny], k * 2);
    uv.set([i / nx, 1 - j / ny], (N + k) * 2);
  }

  // 5. faces: quads whose four corners are inside
  const idx: number[] = [];
  const quadIn = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && mask[j * W + i] && mask[j * W + i + 1] && mask[(j + 1) * W + i] && mask[(j + 1) * W + i + 1];
  const front = new Set<number>(); // directed front edges, key a*N2+b
  const N2 = 2 * N;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!quadIn(i, j)) continue;
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    idx.push(a, c, b, b, c, d);
    idx.push(N + a, N + b, N + c, N + b, N + d, N + c);
    for (const [u, v] of [[a, c], [c, b], [b, a], [b, c], [c, d], [d, b]]) front.add(u * N2 + v);
  }
  // 6. side walls along boundary edges (directed front edge without its reverse)
  for (const key of front) {
    const u = Math.floor(key / N2), v = key - u * N2;
    if (front.has(v * N2 + u)) continue;
    idx.push(v, u, N + u, v, N + u, N + v);
  }

  // 7. compact unused vertices
  const remap = new Int32Array(N2).fill(-1);
  let n = 0;
  for (const i of idx) if (remap[i] < 0) remap[i] = n++;
  const P = new Float32Array(n * 3), U = new Float32Array(n * 2);
  for (let v = 0; v < N2; v++) {
    const r = remap[v]; if (r < 0) continue;
    P[r * 3] = pos[v * 3]; P[r * 3 + 1] = pos[v * 3 + 1]; P[r * 3 + 2] = pos[v * 3 + 2];
    U[r * 2] = uv[v * 2]; U[r * 2 + 1] = uv[v * 2 + 1];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx, (i) => remap[i]), 1));
  g.computeVertexNormals();
  return { geometry: g, maskSource, coverage: inside / N, grid: { nx, ny } };
}
