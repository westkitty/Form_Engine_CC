import * as THREE from 'three';
import type { EditableMesh } from '../geometry/EditableMesh';

export type BrushType = 'draw' | 'inflate' | 'clay' | 'smooth' | 'grab' | 'flatten' | 'pinch' | 'crease' | 'mask';
export type FalloffType = 'smooth' | 'sphere' | 'linear' | 'sharp' | 'constant';

export interface BrushSettings {
  /** World-space radius. Converted to object-local space per stroke. */
  radius: number;
  /** 0..1 */
  strength: number;
  falloff: FalloffType;
  /** Dab spacing as a fraction of the radius. */
  spacing: number;
  invert: boolean;
  /** Use pen pressure to scale strength (when the device reports it). */
  pressure: boolean;
  /** Smooth-boundary protection: open boundary vertices only relax along the boundary. */
  protectBoundary: boolean;
}

export const BRUSH_INFO: Record<BrushType, { label: string; key?: string; summary: string }> = {
  draw: { label: 'Draw', key: 'D', summary: 'Pushes the surface along the brush area normal.' },
  inflate: { label: 'Inflate', key: 'I', summary: 'Pushes each vertex along its own smooth normal — swells forms.' },
  clay: { label: 'Clay Build', key: 'C', summary: 'Builds toward an offset plane — layers flat-topped clay.' },
  smooth: { label: 'Smooth', key: 'S', summary: 'Laplacian relaxation toward neighbour averages.' },
  grab: { label: 'Grab', key: 'G', summary: 'Drags a region along with the pointer.' },
  flatten: { label: 'Flatten', key: 'F', summary: 'Projects vertices toward the local average plane.' },
  pinch: { label: 'Pinch', key: 'P', summary: 'Pulls vertices toward the brush centre in the tangent plane.' },
  crease: { label: 'Crease', key: 'E', summary: 'Pinch plus inward push — cuts sharp grooves.' },
  mask: { label: 'Mask', key: 'M', summary: 'Paints protection weights; masked vertices resist all brushes.' },
};

export function defaultSettings(type: BrushType): BrushSettings {
  const base: BrushSettings = { radius: 0.25, strength: 0.5, falloff: 'smooth', spacing: 0.15, invert: false, pressure: true, protectBoundary: true };
  switch (type) {
    case 'smooth': return { ...base, strength: 0.6 };
    case 'grab': return { ...base, radius: 0.35, strength: 1 };
    case 'clay': return { ...base, strength: 0.4, falloff: 'sphere' };
    case 'flatten': return { ...base, strength: 0.5 };
    case 'pinch': return { ...base, strength: 0.4 };
    case 'crease': return { ...base, radius: 0.15, strength: 0.4, falloff: 'sharp' };
    case 'mask': return { ...base, strength: 0.8, falloff: 'sphere' };
    default: return base;
  }
}

/** Falloff weight for normalised distance t in [0,1]. */
export function falloff(t: number, type: FalloffType): number {
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  switch (type) {
    case 'constant': return 1;
    case 'linear': return 1 - t;
    case 'sharp': return (1 - t) * (1 - t);
    case 'sphere': return Math.sqrt(1 - t * t);
    case 'smooth': default: { const s = 1 - t; return s * s * (3 - 2 * s); }
  }
}

/** Area-weighted centre + normal of the brush footprint. */
export function areaFrame(mesh: EditableMesh, verts: number[], center: THREE.Vector3, radius: number, type: FalloffType, outC: THREE.Vector3, outN: THREE.Vector3) {
  const p = mesh.positions, n = mesh.normals;
  let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0, ws = 0;
  for (const v of verts) {
    const i = v * 3;
    const d = Math.hypot(p[i] - center.x, p[i + 1] - center.y, p[i + 2] - center.z) / radius;
    const w = falloff(d, type) + 1e-6;
    cx += p[i] * w; cy += p[i + 1] * w; cz += p[i + 2] * w;
    nx += n[i] * w; ny += n[i + 1] * w; nz += n[i + 2] * w;
    ws += w;
  }
  if (ws === 0) { outC.copy(center); outN.set(0, 1, 0); return; }
  outC.set(cx / ws, cy / ws, cz / ws);
  outN.set(nx, ny, nz);
  if (outN.lengthSq() < 1e-12) outN.set(0, 1, 0); else outN.normalize();
}

export interface DabInput {
  mesh: EditableMesh;
  type: BrushType;
  verts: number[];
  center: THREE.Vector3;
  radius: number;
  /** Effective strength after pressure, 0..1 */
  strength: number;
  invert: boolean;
  falloff: FalloffType;
  protectBoundary: boolean;
  /** Called before a canonical vertex is modified for the first time in a stroke. */
  touch: (c: number) => void;
}

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
let scratch = new Float32Array(0);

/**
 * Apply one brush dab. Each brush is a distinct operation:
 *  draw    p += N_area * r * s * k * w
 *  inflate p += n_v    * r * s * k * w
 *  clay    plane = C_area + N_area * r * s * 0.25; vertices below the plane rise toward it (one-sided)
 *  flatten plane = (C_area, N_area); p -= N * dist * s * w (two-sided projection)
 *  smooth  Jacobi Laplacian: p += (mean(neighbours) - p) * s * w
 *  pinch   p += tangential(C - p) * s * w * 0.5
 *  crease  pinch + p -= N_area * r * s * k * w (inverse with invert)
 *  mask    m = clamp(m ± s * w)
 * Displacement is multiplied by (1 - mask).
 */
export function applyDab(d: DabInput) {
  const { mesh, verts, center, radius, type } = d;
  if (!verts.length) return;
  const p = mesh.positions, nrm = mesh.normals, mask = mesh.mask;
  const sign = d.invert ? -1 : 1;
  const s = d.strength;
  const k = 0.1; // fraction of radius moved per dab at strength 1
  areaFrame(mesh, verts, center, radius, d.falloff, _c, _n);

  if (type === 'mask') {
    for (const v of verts) {
      const i = v * 3;
      const w = falloff(Math.hypot(p[i] - center.x, p[i + 1] - center.y, p[i + 2] - center.z) / radius, d.falloff);
      if (w <= 0) continue;
      d.touch(v);
      const m = Math.min(1, Math.max(0, mask[v] + sign * s * w));
      mesh.setCanonicalMask(v, m);
    }
    return;
  }

  if (type === 'smooth') {
    if (scratch.length < verts.length * 3) scratch = new Float32Array(verts.length * 3 * 2);
    // Jacobi: compute every target first, then write, so results don't depend on traversal order.
    for (let j = 0; j < verts.length; j++) {
      const v = verts[j];
      let sx = 0, sy = 0, sz = 0, cnt = 0;
      const onB = d.protectBoundary && mesh.boundary[v] === 1;
      for (let a = mesh.adjStart[v]; a < mesh.adjStart[v + 1]; a++) {
        const u = mesh.adjList[a];
        if (onB && mesh.boundary[u] !== 1) continue;
        sx += p[u * 3]; sy += p[u * 3 + 1]; sz += p[u * 3 + 2]; cnt++;
      }
      const i = v * 3;
      if (cnt === 0) { scratch[j * 3] = p[i]; scratch[j * 3 + 1] = p[i + 1]; scratch[j * 3 + 2] = p[i + 2]; continue; }
      scratch[j * 3] = sx / cnt; scratch[j * 3 + 1] = sy / cnt; scratch[j * 3 + 2] = sz / cnt;
    }
    for (let j = 0; j < verts.length; j++) {
      const v = verts[j], i = v * 3;
      const w = falloff(Math.hypot(p[i] - center.x, p[i + 1] - center.y, p[i + 2] - center.z) / radius, d.falloff) * (1 - mask[v]);
      if (w <= 0) continue;
      d.touch(v);
      const t = Math.min(1, s * w);
      mesh.setCanonical(v, p[i] + (scratch[j * 3] - p[i]) * t, p[i + 1] + (scratch[j * 3 + 1] - p[i + 1]) * t, p[i + 2] + (scratch[j * 3 + 2] - p[i + 2]) * t);
    }
    return;
  }

  // Plane for clay (offset outward) and flatten (through area centre).
  const planeOffset = type === 'clay' ? radius * s * 0.25 * sign : 0;
  const px = _c.x + _n.x * planeOffset, py = _c.y + _n.y * planeOffset, pz = _c.z + _n.z * planeOffset;

  for (const v of verts) {
    const i = v * 3;
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const w = falloff(Math.hypot(x - center.x, y - center.y, z - center.z) / radius, d.falloff) * (1 - mask[v]);
    if (w <= 0) continue;
    let dx = 0, dy = 0, dz = 0;
    switch (type) {
      case 'draw': {
        const a = sign * radius * s * k * w;
        dx = _n.x * a; dy = _n.y * a; dz = _n.z * a;
        break;
      }
      case 'inflate': {
        const a = sign * radius * s * k * w;
        dx = nrm[i] * a; dy = nrm[i + 1] * a; dz = nrm[i + 2] * a;
        break;
      }
      case 'clay': {
        const dist = (x - px) * _n.x + (y - py) * _n.y + (z - pz) * _n.z;
        // building (sign>0): only vertices below the plane move up; carving: only above move down.
        if (sign > 0 ? dist >= 0 : dist <= 0) continue;
        const a = -dist * Math.min(1, s * w);
        dx = _n.x * a; dy = _n.y * a; dz = _n.z * a;
        break;
      }
      case 'flatten': {
        const dist = (x - px) * _n.x + (y - py) * _n.y + (z - pz) * _n.z;
        const a = -dist * Math.min(1, s * w) * (d.invert ? -0.5 : 1);
        dx = _n.x * a; dy = _n.y * a; dz = _n.z * a;
        break;
      }
      case 'pinch':
      case 'crease': {
        let tx = center.x - x, ty = center.y - y, tz = center.z - z;
        const along = tx * _n.x + ty * _n.y + tz * _n.z;
        tx -= _n.x * along; ty -= _n.y * along; tz -= _n.z * along;
        const a = sign * s * w * 0.5;
        dx = tx * a; dy = ty * a; dz = tz * a;
        if (type === 'crease') {
          const b = -sign * radius * s * k * w;
          dx += _n.x * b; dy += _n.y * b; dz += _n.z * b;
        }
        break;
      }
    }
    if (dx === 0 && dy === 0 && dz === 0) continue;
    d.touch(v);
    mesh.setCanonical(v, x + dx, y + dy, z + dz);
  }
}
