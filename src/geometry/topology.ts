import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';

export type PrimitiveKind = 'sphere' | 'uvsphere' | 'cube' | 'cylinder' | 'torus' | 'plane';

export const PRIMITIVE_LABELS: Record<PrimitiveKind, string> = {
  sphere: 'Clay sphere (ico)', uvsphere: 'UV sphere', cube: 'Cube', cylinder: 'Cylinder', torus: 'Torus', plane: 'Plane',
};

/** Build a sculpt-ready primitive. `detail` 0..4 scales density. */
export function makePrimitive(kind: PrimitiveKind, detail = 2): THREE.BufferGeometry {
  const d = Math.max(0, Math.min(5, detail));
  let g: THREE.BufferGeometry;
  switch (kind) {
    case 'sphere': {
      // Icosphere gives uniform triangle density; three builds it non-indexed, so weld it.
      const ico = new THREE.IcosahedronGeometry(0.5, [8, 22, 32, 48, 72, 100][d]); // ≈1.6k, 10.6k, 21.8k, 48k, 107k, 204k tris
      ico.deleteAttribute('uv');
      ico.deleteAttribute('normal');
      g = mergeVertices(ico);
      g.computeVertexNormals();
      break;
    }
    case 'uvsphere': g = new THREE.SphereGeometry(0.5, [32, 64, 128, 192, 256, 360][d], [16, 32, 64, 96, 128, 180][d]); break;
    case 'cube': { const s = [8, 16, 32, 48, 64, 96][d]; g = new THREE.BoxGeometry(0.8, 0.8, 0.8, s, s, s); break; }
    case 'cylinder': g = new THREE.CylinderGeometry(0.35, 0.35, 1, [32, 64, 96, 128, 192, 256][d], [16, 32, 64, 96, 128, 160][d]); break;
    case 'torus': g = new THREE.TorusGeometry(0.35, 0.14, [24, 48, 64, 96, 128, 160][d], [64, 128, 192, 256, 360, 480][d]); break;
    case 'plane': { const s = [32, 64, 128, 192, 256, 384][d]; g = new THREE.PlaneGeometry(1.2, 1.2, s, s); g.rotateX(-Math.PI / 2); break; }
  }
  return g;
}

/**
 * Midpoint subdivision: every triangle → 4. New vertices are created at edge midpoints and every
 * per-vertex attribute (uv, color, mask, normal) is interpolated. No smoothing is applied (shape is
 * preserved exactly); follow with Smooth if a rounder result is wanted. Seams are preserved because
 * edges are keyed by real vertex ids, not welded positions.
 */
export function subdivideMidpoint(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = src.index!.array;
  const vCount = src.attributes.position.count;
  const triCount = index.length / 3;
  const edgeMap = new Map<number, number>();
  const pairs: number[] = [];
  const key = (a: number, b: number) => (a < b ? a * vCount + b : b * vCount + a);
  const newIndex = new Uint32Array(triCount * 12);
  let next = vCount;
  const mid = (a: number, b: number) => {
    const k = key(a, b);
    let m = edgeMap.get(k);
    if (m === undefined) { m = next++; edgeMap.set(k, m); pairs.push(a, b); }
    return m;
  };
  for (let t = 0; t < triCount; t++) {
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    newIndex.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], t * 12);
  }
  const total = next;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const size = a.itemSize;
    const arr = new Float32Array(total * size);
    const srcArr = a.array as Float32Array;
    arr.set(srcArr.subarray(0, vCount * size));
    for (let e = 0; e < pairs.length / 2; e++) {
      const i = pairs[e * 2], j = pairs[e * 2 + 1], o = (vCount + e) * size;
      for (let k = 0; k < size; k++) arr[o + k] = (srcArr[i * size + k] + srcArr[j * size + k]) * 0.5;
    }
    if (name === 'normal') {
      for (let v = vCount; v < total; v++) {
        const o = v * 3; const l = Math.hypot(arr[o], arr[o + 1], arr[o + 2]) || 1;
        arr[o] /= l; arr[o + 1] /= l; arr[o + 2] /= l;
      }
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size, a.normalized));
  }
  out.setIndex(new THREE.BufferAttribute(newIndex, 1));
  for (const gr of src.groups) out.addGroup(gr.start * 4, gr.count * 4, gr.materialIndex);
  return out;
}

/**
 * Decimate with three.js SimplifyModifier (meshoptimizer quadric simplifier, attribute-aware).
 * `ratio` is the fraction of triangles to keep. Material groups are not preserved by the simplifier,
 * so multi-group meshes are rejected rather than silently losing material assignments.
 */
export async function decimate(src: THREE.BufferGeometry, ratio: number): Promise<THREE.BufferGeometry> {
  if (src.groups.length > 1) throw new Error('Decimation is disabled for meshes with multiple material groups (groups would be lost).');
  const r = Math.min(1, Math.max(0.02, ratio));
  const g = src.clone();
  g.deleteAttribute('aMask');
  const remove = Math.floor(g.attributes.position.count * (1 - r));
  const out = await new SimplifyModifier().modify(g, remove);
  out.computeVertexNormals();
  return out;
}
