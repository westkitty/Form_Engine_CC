import * as THREE from 'three';
import type { EditableMesh } from '../geometry/EditableMesh';
import { applyDab, falloff, type BrushSettings, type BrushType } from './brushes';

export interface SymmetrySettings { x: boolean; y: boolean; z: boolean }

/** Compact undo record: canonical vertex ids with before/after positions and mask. */
export interface VertexPatch {
  kind: 'vertex-patch';
  topologyVersion: number;
  canonical: Int32Array;
  before: Float32Array;
  after: Float32Array;
  maskBefore: Float32Array;
  maskAfter: Float32Array;
}

/** Apply a patch side (positions + mask) back onto the mesh. Fails loudly if the topology changed. */
export function applyPatch(mesh: EditableMesh, patch: VertexPatch, side: 'before' | 'after') {
  if (patch.topologyVersion !== mesh.topologyVersion) throw new Error('Vertex patch is stale: topology changed since it was recorded');
  const pos = side === 'before' ? patch.before : patch.after;
  const m = side === 'before' ? patch.maskBefore : patch.maskAfter;
  for (let j = 0; j < patch.canonical.length; j++) {
    const c = patch.canonical[j];
    mesh.setCanonical(c, pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]);
    mesh.setCanonicalMask(c, m[j]);
  }
  mesh.updateNormals(patch.canonical);
  mesh.commitPositions();
  mesh.commitMask();
  mesh.finalizeBounds();
}

/** Mirror transforms for enabled symmetry axes (all combinations, identity first). */
export function mirrorSigns(sym: SymmetrySettings): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const sx of sym.x ? [1, -1] : [1]) for (const sy of sym.y ? [1, -1] : [1]) for (const sz of sym.z ? [1, -1] : [1]) out.push(new THREE.Vector3(sx, sy, sz));
  return out;
}

/**
 * One sculpt stroke transaction (begin → dab* → commit | cancel). Operates in the mesh's local space.
 * Only `commit` produces history; `cancel` restores every touched vertex exactly.
 */
export class SculptStroke {
  private touchedIds: number[] = [];
  private touchedSet = new Map<number, number>();
  private before: number[] = [];
  private maskBefore: number[] = [];
  private onPlane: number[] = []; // bitmask per touched vertex: which symmetry planes it started on
  private query: number[] = [];
  private dirtySinceNormals: number[] = [];
  readonly traversed = new Set<number>();
  private mirrors: THREE.Vector3[];
  private planeEps: number;
  // Grab state
  private grabGroups: { verts: Int32Array; weights: Float32Array; origin: Float32Array; sign: THREE.Vector3 }[] = [];
  dabCount = 0;
  lastCenter: THREE.Vector3 | null = null;

  constructor(
    readonly mesh: EditableMesh,
    readonly type: BrushType,
    readonly settings: BrushSettings,
    /** Radius in local units. */
    readonly localRadius: number,
    readonly symmetry: SymmetrySettings,
  ) {
    this.mirrors = mirrorSigns(symmetry);
    this.dirtyFlag = new Uint8Array(mesh.vertexCount);
    const bb = mesh.geometry.boundingBox!;
    this.planeEps = bb.getSize(new THREE.Vector3()).length() * 1e-5;
  }

  private dirtyFlag: Uint8Array;
  /** Called for every vertex a dab modifies: records its pre-stroke state once, and marks it dirty. */
  private touch = (c: number) => {
    if (!this.dirtyFlag[c]) { this.dirtyFlag[c] = 1; this.dirtySinceNormals.push(c); }
    if (this.touchedSet.has(c)) return;
    const p = this.mesh.positions;
    this.touchedSet.set(c, this.touchedIds.length);
    this.touchedIds.push(c);
    this.before.push(p[c * 3], p[c * 3 + 1], p[c * 3 + 2]);
    this.maskBefore.push(this.mesh.mask[c]);
    let bits = 0;
    if (this.symmetry.x && Math.abs(p[c * 3]) < this.planeEps) bits |= 1;
    if (this.symmetry.y && Math.abs(p[c * 3 + 1]) < this.planeEps) bits |= 2;
    if (this.symmetry.z && Math.abs(p[c * 3 + 2]) < this.planeEps) bits |= 4;
    this.onPlane.push(bits);
  };

  /**
   * Apply one dab at a local-space surface point (all symmetry mirrors). With `defer`, normals, BVH refit
   * and GPU upload are batched until `flush()` (used to apply all dabs of one pointer sample at once).
   */
  dab(center: THREE.Vector3, pressure = 1, defer = false) {
    const s = this.settings;
    const strength = Math.max(0, Math.min(1, s.strength * (s.pressure ? pressure : 1)));
    for (const m of this.mirrors) {
      const c = _mc.set(center.x * m.x, center.y * m.y, center.z * m.z);
      this.mesh.queryCanonical(c, this.localRadius, this.query, this.traversed);
      applyDab({
        mesh: this.mesh, type: this.type, verts: this.query, center: c, radius: this.localRadius, strength,
        invert: s.invert, falloff: s.falloff, protectBoundary: s.protectBoundary, touch: this.touch,
      });
    }
    this.snapToPlanes();
    this.dabCount++;
    this.lastCenter = center.clone();
    if (defer) this.pending = true; else this.afterEdit();
  }

  private pending = false;
  /** Apply deferred normal/BVH/GPU updates. */
  flush() { if (this.pending) this.afterEdit(); }

  /** Grab: capture the region under the pointer at stroke start. */
  beginGrab(center: THREE.Vector3) {
    this.grabGroups = [];
    for (const m of this.mirrors) {
      const c = _mc.set(center.x * m.x, center.y * m.y, center.z * m.z);
      const verts = this.mesh.queryCanonical(c, this.localRadius, [], this.traversed).slice();
      const p = this.mesh.positions;
      const weights = new Float32Array(verts.length);
      const origin = new Float32Array(verts.length * 3);
      verts.forEach((v, j) => {
        const d = Math.hypot(p[v * 3] - c.x, p[v * 3 + 1] - c.y, p[v * 3 + 2] - c.z) / this.localRadius;
        weights[j] = falloff(d, this.settings.falloff) * (1 - this.mesh.mask[v]);
        origin[j * 3] = p[v * 3]; origin[j * 3 + 1] = p[v * 3 + 1]; origin[j * 3 + 2] = p[v * 3 + 2];
        this.touch(v);
      });
      this.grabGroups.push({ verts: Int32Array.from(verts), weights, origin, sign: m.clone() });
    }
    this.lastCenter = center.clone();
  }

  /** Grab: set total local-space displacement since beginGrab. */
  updateGrab(delta: THREE.Vector3) {
    const st = this.settings.strength;
    const handled = new Set<number>();
    for (const g of this.grabGroups) {
      const dx = delta.x * g.sign.x, dy = delta.y * g.sign.y, dz = delta.z * g.sign.z;
      for (let j = 0; j < g.verts.length; j++) {
        const v = g.verts[j];
        if (handled.has(v)) continue; // a vertex shared by two mirrors follows the first (identity) group
        handled.add(v);
        const w = g.weights[j] * st;
        this.mesh.setCanonical(v, g.origin[j * 3] + dx * w, g.origin[j * 3 + 1] + dy * w, g.origin[j * 3 + 2] + dz * w);
      }
    }
    for (const c of this.dirtySinceNormals) this.dirtyFlag[c] = 0;
    this.dirtySinceNormals = this.grabGroups.flatMap((g) => Array.from(g.verts));
    for (const c of this.dirtySinceNormals) this.dirtyFlag[c] = 1;
    this.snapToPlanes();
    this.afterEdit();
    this.dabCount++;
  }

  private snapToPlanes() {
    if (!this.symmetry.x && !this.symmetry.y && !this.symmetry.z) return;
    const p = this.mesh.positions;
    for (let j = 0; j < this.touchedIds.length; j++) {
      const bits = this.onPlane[j];
      if (!bits) continue;
      const c = this.touchedIds[j];
      this.mesh.setCanonical(c, bits & 1 ? 0 : p[c * 3], bits & 2 ? 0 : p[c * 3 + 1], bits & 4 ? 0 : p[c * 3 + 2]);
    }
  }

  private afterEdit() {
    this.pending = false;
    if (this.type === 'mask') { this.mesh.commitMask(); return; }
    this.mesh.updateNormals(this.dirtySinceNormals);
    this.mesh.commitPositions(this.traversed, this.mesh.vertexRange(this.dirtySinceNormals));
    this.traversed.clear();
    for (const c of this.dirtySinceNormals) this.dirtyFlag[c] = 0;
    this.dirtySinceNormals.length = 0;
  }

  get touchedCount() { return this.touchedIds.length; }

  /** Finish: returns an undo patch, or null if nothing changed. */
  commit(): VertexPatch | null {
    this.flush();
    const n = this.touchedIds.length;
    if (!n) return null;
    const p = this.mesh.positions;
    const canonical = Int32Array.from(this.touchedIds);
    const after = new Float32Array(n * 3);
    const maskAfter = new Float32Array(n);
    let changed = false;
    for (let j = 0; j < n; j++) {
      const c = canonical[j];
      after[j * 3] = p[c * 3]; after[j * 3 + 1] = p[c * 3 + 1]; after[j * 3 + 2] = p[c * 3 + 2];
      maskAfter[j] = this.mesh.mask[c];
      if (!changed && (after[j * 3] !== this.before[j * 3] || after[j * 3 + 1] !== this.before[j * 3 + 1] || after[j * 3 + 2] !== this.before[j * 3 + 2] || maskAfter[j] !== this.maskBefore[j])) changed = true;
    }
    this.mesh.finalizeBounds();
    if (!changed) return null;
    return {
      kind: 'vertex-patch', topologyVersion: this.mesh.topologyVersion, canonical,
      before: Float32Array.from(this.before), after, maskBefore: Float32Array.from(this.maskBefore), maskAfter,
    };
  }

  /** Abort: restore every touched vertex to its pre-stroke state. */
  cancel() {
    this.pending = false;
    const n = this.touchedIds.length;
    if (!n) return;
    for (let j = 0; j < n; j++) {
      const c = this.touchedIds[j];
      this.mesh.setCanonical(c, this.before[j * 3], this.before[j * 3 + 1], this.before[j * 3 + 2]);
      this.mesh.setCanonicalMask(c, this.maskBefore[j]);
    }
    this.mesh.updateNormals(this.touchedIds);
    this.mesh.commitPositions();
    this.mesh.commitMask();
    this.mesh.finalizeBounds();
    this.touchedIds = [];
    this.touchedSet.clear();
  }
}

const _mc = new THREE.Vector3();

/**
 * Resample a pointer path into evenly spaced dab points (spacing in local units).
 * Returns the points between `from` (exclusive) and `to` (inclusive) and the leftover distance.
 */
export function resample(from: THREE.Vector3, to: THREE.Vector3, spacing: number, carry: number, out: THREE.Vector3[]): number {
  out.length = 0;
  const dist = from.distanceTo(to);
  if (spacing <= 0) { out.push(to.clone()); return 0; }
  let t = spacing - carry;
  while (t <= dist) {
    out.push(from.clone().lerp(to, t / dist));
    t += spacing;
  }
  return dist - (t - spacing);
}
