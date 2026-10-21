import * as THREE from 'three';

export interface MeshReport {
  vertices: number;
  triangles: number;
  nonFinite: number;
  indexOutOfRange: number;
  degenerate: number;
  thinTriangles: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  inconsistentWinding: number;
  components: number;
  bounds: { min: number[]; max: number[]; size: number[] };
  hasUV: boolean;
  hasColor: boolean;
  watertight: boolean;
  issues: string[];
}

export const LIMITS = {
  maxFileBytes: 512 * 1024 * 1024,
  maxTriangles: 6_000_000,
  warnTriangles: 500_000,
  maxCoordinate: 1e7,
  maxImagePixels: 50_000_000,
  maxImageBytes: 40 * 1024 * 1024,
};

/**
 * Topology and numeric diagnostics on welded positions. Pure (no DOM); used for imports, generated
 * meshes, the "Anatomy of a Mesh" view and export validation.
 */
export function analyzeGeometry(g: THREE.BufferGeometry): MeshReport {
  const pos = g.attributes.position;
  const n = pos.count;
  const idx = g.index ? g.index.array : null;
  const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(n / 3);
  const at = (t: number, k: number) => (idx ? idx[t * 3 + k] : t * 3 + k);
  const issues: string[] = [];

  let nonFinite = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = pos.getComponent(i, k);
      if (!Number.isFinite(v) || Math.abs(v) > LIMITS.maxCoordinate) { nonFinite++; continue; }
      if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v;
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const diag = Math.hypot(size[0], size[1], size[2]) || 1;

  // weld by quantised position
  const q = 1 / (diag * 1e-6);
  const map = new Map<string, number>();
  const weld = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`;
    let c = map.get(key);
    if (c === undefined) { c = map.size; map.set(key, c); }
    weld[i] = c;
  }
  const W = map.size;

  let indexOutOfRange = 0, degenerate = 0, thin = 0;
  const edges = new Map<number, number>(); // undirected count
  const directed = new Map<number, number>();
  const parent = new Int32Array(W); for (let i = 0; i < W; i++) parent[i] = i;
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const i0 = at(t, 0), i1 = at(t, 1), i2 = at(t, 2);
    if (i0 >= n || i1 >= n || i2 >= n || i0 < 0 || i1 < 0 || i2 < 0) { indexOutOfRange++; continue; }
    const w = [weld[i0], weld[i1], weld[i2]];
    if (w[0] === w[1] || w[1] === w[2] || w[0] === w[2]) { degenerate++; continue; }
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    const area2 = b.clone().sub(a).cross(c.clone().sub(a)).length();
    const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    if (area2 < 1e-14 * diag * diag) { degenerate++; continue; }
    if (area2 / (longest * longest) < 0.01) thin++;
    for (let k = 0; k < 3; k++) {
      const u = w[k], v = w[(k + 1) % 3];
      const key = u < v ? u * W + v : v * W + u;
      edges.set(key, (edges.get(key) ?? 0) + 1);
      const dk = u * W + v;
      directed.set(dk, (directed.get(dk) ?? 0) + 1);
      const ru = find(u), rv = find(v); if (ru !== rv) parent[ru] = rv;
    }
  }
  let boundary = 0, nonManifold = 0, inconsistent = 0;
  for (const [, cnt] of edges) { if (cnt === 1) boundary++; else if (cnt > 2) nonManifold++; }
  for (const [dk, cnt] of directed) { if (cnt > 1) inconsistent += cnt - 1; void dk; }
  const roots = new Set<number>();
  const used = new Uint8Array(W);
  for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) { const i = at(t, k); if (i < n) used[weld[i]] = 1; }
  for (let i = 0; i < W; i++) if (used[i]) roots.add(find(i));

  if (nonFinite) issues.push(`${nonFinite} non-finite or out-of-range coordinates`);
  if (indexOutOfRange) issues.push(`${indexOutOfRange} triangles reference missing vertices`);
  if (degenerate) issues.push(`${degenerate} degenerate (zero-area) triangles`);
  if (boundary) issues.push(`${boundary} open boundary edges (not watertight)`);
  if (nonManifold) issues.push(`${nonManifold} non-manifold edges (shared by >2 triangles)`);
  if (inconsistent) issues.push(`${inconsistent} edges with inconsistent winding (possible flipped faces)`);
  if (roots.size > 1) issues.push(`${roots.size} disconnected shells`);
  if (thin > triCount * 0.05) issues.push(`${thin} very thin triangles (may sculpt unevenly)`);
  if (triCount > LIMITS.warnTriangles) issues.push(`${triCount.toLocaleString()} triangles — sculpting may be slow; consider decimating`);

  return {
    vertices: n, triangles: triCount, nonFinite, indexOutOfRange, degenerate, thinTriangles: thin,
    boundaryEdges: boundary, nonManifoldEdges: nonManifold, inconsistentWinding: inconsistent, components: roots.size,
    bounds: { min: min.map((v) => (Number.isFinite(v) ? v : 0)), max: max.map((v) => (Number.isFinite(v) ? v : 0)), size: size.map((v) => (Number.isFinite(v) ? v : 0)) },
    hasUV: !!g.attributes.uv, hasColor: !!g.attributes.color,
    watertight: boundary === 0 && nonManifold === 0 && triCount > 0,
    issues,
  };
}

/** Hard failures that must block adding a mesh to the scene. */
export function blockingProblems(r: MeshReport): string[] {
  const out: string[] = [];
  if (r.triangles === 0) out.push('Mesh has no triangles.');
  if (r.nonFinite > 0) out.push(`Mesh has ${r.nonFinite} non-finite / absurd coordinates.`);
  if (r.indexOutOfRange > 0) out.push(`Mesh index references ${r.indexOutOfRange} missing vertices.`);
  if (r.triangles > LIMITS.maxTriangles) out.push(`Mesh has ${r.triangles.toLocaleString()} triangles; the limit is ${LIMITS.maxTriangles.toLocaleString()}.`);
  return out;
}

/** Remove triangles whose index is out of range or that are degenerate. Returns removed count. */
export function dropBadTriangles(g: THREE.BufferGeometry): number {
  if (!g.index) return 0;
  const idx = g.index.array, n = g.attributes.position.count;
  const keep: number[] = [];
  let removed = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a >= n || b >= n || c >= n || a === b || b === c || a === c) { removed++; continue; }
    keep.push(a, b, c);
  }
  if (removed) g.setIndex(new THREE.BufferAttribute(new Uint32Array(keep), 1));
  return removed;
}

/** Remove disconnected shells below a fraction of the largest shell's triangle count ("debris"). */
export function removeDebris(g: THREE.BufferGeometry, minFraction = 0.02): { geometry: THREE.BufferGeometry; removedShells: number } {
  const idx = g.index!.array, pos = g.attributes.position, n = pos.count;
  const parent = new Int32Array(n); for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  // weld positions so seams connect
  const map = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = `${pos.getX(i).toFixed(6)},${pos.getY(i).toFixed(6)},${pos.getZ(i).toFixed(6)}`;
    const c = map.get(key); if (c === undefined) map.set(key, i); else parent[find(i)] = find(c);
  }
  for (let t = 0; t < idx.length; t += 3) { const a = find(idx[t]), b = find(idx[t + 1]), c = find(idx[t + 2]); parent[a] = b; parent[find(c)] = find(b); }
  const triCount = new Map<number, number>();
  for (let t = 0; t < idx.length; t += 3) { const r = find(idx[t]); triCount.set(r, (triCount.get(r) ?? 0) + 1); }
  const largest = Math.max(...triCount.values());
  const keepRoot = new Set([...triCount].filter(([, c]) => c >= largest * minFraction).map(([r]) => r));
  const keep: number[] = [];
  for (let t = 0; t < idx.length; t += 3) if (keepRoot.has(find(idx[t]))) keep.push(idx[t], idx[t + 1], idx[t + 2]);
  const out = g.clone();
  out.setIndex(new THREE.BufferAttribute(new Uint32Array(keep), 1));
  return { geometry: out, removedShells: triCount.size - keepRoot.size };
}

/** Flip triangle winding (repair for inside-out meshes). */
export function flipWinding(g: THREE.BufferGeometry) {
  const idx = g.index!.array as Uint32Array;
  for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  g.index!.needsUpdate = true;
  const nrm = g.attributes.normal;
  if (nrm) { const a = nrm.array as Float32Array; for (let i = 0; i < a.length; i++) a[i] = -a[i]; nrm.needsUpdate = true; }
}
