import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { EditableMesh } from '../../src/geometry/EditableMesh';
import { makePrimitive, subdivideMidpoint, decimate } from '../../src/geometry/topology';
import { SculptStroke, applyPatch } from '../../src/sculpt/Stroke';
import { defaultSettings, type BrushType } from '../../src/sculpt/brushes';
import { History } from '../../src/history/History';

const EPS = 1e-6;
const sphere = (kind: 'sphere' | 'uvsphere' = 'sphere') => new EditableMesh(makePrimitive(kind, 2));
const top = new THREE.Vector3(0, 0.5, 0);

function stroke(mesh: EditableMesh, type: BrushType, center = top, opts: Partial<ReturnType<typeof defaultSettings>> = {}, sym = { x: false, y: false, z: false }, dabs = 5) {
  const s = { ...defaultSettings(type), ...opts };
  const st = new SculptStroke(mesh, type, s, s.radius, sym);
  for (let i = 0; i < dabs; i++) st.dab(center, 1);
  return { st, patch: st.commit() };
}

function maxDelta(a: Float32Array, b: Float32Array) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function laplacianEnergy(mesh: EditableMesh, verts: number[]) {
  const p = mesh.positions;
  let e = 0;
  for (const v of verts) {
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let a = mesh.adjStart[v]; a < mesh.adjStart[v + 1]; a++) { const u = mesh.adjList[a]; sx += p[u * 3]; sy += p[u * 3 + 1]; sz += p[u * 3 + 2]; n++; }
    e += (sx / n - p[v * 3]) ** 2 + (sy / n - p[v * 3 + 1]) ** 2 + (sz / n - p[v * 3 + 2]) ** 2;
  }
  return e;
}

function allFinite(a: Float32Array) { for (const x of a) if (!Number.isFinite(x)) return false; return true; }

describe('EditableMesh', () => {
  it('welds UV sphere seams so canonical neighbours span the seam', () => {
    const m = sphere('uvsphere');
    const s = m.stats();
    expect(s.welded).toBeLessThan(s.vertices);
    expect(s.boundaryVertices).toBe(0); // closed after welding
  });
});

describe('brushes', () => {
  it('Draw moves vertices only within the radius; invert reverses', () => {
    const m = sphere();
    const before = m.positions.slice();
    const { patch } = stroke(m, 'draw');
    expect(patch).not.toBeNull();
    const delta = maxDelta(before, m.positions);
    expect(delta).toBeGreaterThan(1e-3);
    // vertices outside the radius untouched
    for (let v = 0; v < m.vertexCount; v++) {
      const d = Math.hypot(before[v * 3] - top.x, before[v * 3 + 1] - top.y, before[v * 3 + 2] - top.z);
      if (d > 0.25 + EPS) expect(Math.abs(m.positions[v * 3 + 1] - before[v * 3 + 1])).toBeLessThan(EPS);
    }
    // top vertex moved outward (+y)
    const yMaxAfter = Math.max(...Array.from({ length: m.vertexCount }, (_, i) => m.positions[i * 3 + 1]));
    expect(yMaxAfter).toBeGreaterThan(0.5 + 1e-3);
    const m2 = sphere();
    stroke(m2, 'draw', top, { invert: true });
    const yMax2 = Math.max(...Array.from({ length: m2.vertexCount }, (_, i) => m2.positions[i * 3 + 1]));
    expect(yMax2).toBeLessThan(0.5 - 1e-3);
  });

  it('Smooth reduces Laplacian energy of a roughened region without NaNs', () => {
    const m = sphere();
    // roughen deterministically
    const verts = m.queryCanonical(top, 0.3, []).slice();
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
    for (const v of verts) m.setCanonical(v, m.positions[v * 3] + rnd(), m.positions[v * 3 + 1] + rnd(), m.positions[v * 3 + 2] + rnd());
    m.updateNormals(verts); m.commitPositions();
    const e0 = laplacianEnergy(m, verts);
    stroke(m, 'smooth', top, { radius: 0.3 });
    const e1 = laplacianEnergy(m, verts);
    expect(e1).toBeLessThan(e0 * 0.6);
    expect(allFinite(m.positions)).toBe(true);
  });

  it('Grab displaces coherently along the drag and leaves distant vertices alone', () => {
    const m = sphere();
    const before = m.positions.slice();
    const s = defaultSettings('grab');
    const st = new SculptStroke(m, 'grab', s, s.radius, { x: false, y: false, z: false });
    st.beginGrab(top);
    st.updateGrab(new THREE.Vector3(0.2, 0, 0));
    st.commit();
    let moved = 0, wrongDir = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      const dx = m.positions[v * 3] - before[v * 3];
      if (Math.abs(dx) > 1e-4) { moved++; if (dx < 0) wrongDir++; }
      if (before[v * 3 + 1] < 0) expect(dx).toBe(0);
    }
    expect(moved).toBeGreaterThan(5);
    expect(wrongDir).toBe(0);
  });

  it('Flatten moves the footprint closer to its plane', () => {
    const m = sphere();
    const verts = m.queryCanonical(top, 0.25, []).slice();
    const dev = () => { const ys = verts.map((v) => m.positions[v * 3 + 1]); const mean = ys.reduce((a, b) => a + b, 0) / ys.length; return ys.reduce((a, y) => a + (y - mean) ** 2, 0); };
    const d0 = dev();
    stroke(m, 'flatten');
    expect(dev()).toBeLessThan(d0 * 0.7);
  });

  it('Clay is distinct from Draw (flat-topped build vs. normal push)', () => {
    const a = sphere(), b = sphere();
    stroke(a, 'draw'); stroke(b, 'clay');
    expect(maxDelta(a.positions, b.positions)).toBeGreaterThan(1e-3);
    const yb = Math.max(...Array.from({ length: b.vertexCount }, (_, i) => b.positions[i * 3 + 1]));
    expect(yb).toBeGreaterThan(0.5); // built up
  });

  it('Pinch contracts toward the centre in the tangent plane and differs from Draw/Smooth', () => {
    const m = sphere();
    const verts = m.queryCanonical(top, 0.2, []).slice();
    const spread = () => verts.reduce((s, v) => s + Math.hypot(m.positions[v * 3], m.positions[v * 3 + 2]), 0);
    const s0 = spread();
    stroke(m, 'pinch', top, { radius: 0.25 });
    expect(spread()).toBeLessThan(s0 * 0.95);
    const d = sphere(); stroke(d, 'draw', top, { radius: 0.25 });
    const sm = sphere(); stroke(sm, 'smooth', top, { radius: 0.25 });
    expect(maxDelta(m.positions, d.positions)).toBeGreaterThan(1e-3);
    expect(maxDelta(m.positions, sm.positions)).toBeGreaterThan(1e-3);
  });

  it('Crease cuts inward', () => {
    const m = sphere();
    stroke(m, 'crease', top, { radius: 0.2, strength: 0.8 });
    let minTop = Infinity;
    for (let v = 0; v < m.vertexCount; v++) if (Math.hypot(m.positions[v * 3], m.positions[v * 3 + 2]) < 0.02) minTop = Math.min(minTop, m.positions[v * 3 + 1]);
    expect(minTop).toBeLessThan(0.5 - 1e-3);
  });

  it('Inflate pushes along per-vertex normals (radially on a sphere)', () => {
    const m = sphere();
    const side = new THREE.Vector3(0.5, 0, 0);
    stroke(m, 'inflate', side);
    let rMax = 0;
    for (let v = 0; v < m.vertexCount; v++) rMax = Math.max(rMax, Math.hypot(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]));
    expect(rMax).toBeGreaterThan(0.5 + 1e-3);
  });

  it('X symmetry mirrors a stroke exactly on a symmetric mesh', () => {
    const m = sphere();
    const c = new THREE.Vector3(0.3, 0.3, 0.3).normalize().multiplyScalar(0.5);
    stroke(m, 'draw', c, {}, { x: true, y: false, z: false });
    // for each moved vertex find its mirror and compare
    const p = m.positions;
    const lookup = new Map<string, number>();
    const orig = new EditableMesh(makePrimitive('sphere', 2)).positions;
    for (let v = 0; v < m.vertexCount; v++) lookup.set(`${orig[v * 3].toFixed(5)},${orig[v * 3 + 1].toFixed(5)},${orig[v * 3 + 2].toFixed(5)}`, v);
    let checked = 0, maxErr = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      if (Math.abs(p[v * 3 + 1] - orig[v * 3 + 1]) < 1e-5) continue;
      const mv = lookup.get(`${(-orig[v * 3]).toFixed(5)},${orig[v * 3 + 1].toFixed(5)},${orig[v * 3 + 2].toFixed(5)}`);
      if (mv === undefined) continue;
      maxErr = Math.max(maxErr, Math.abs(p[mv * 3] + p[v * 3]), Math.abs(p[mv * 3 + 1] - p[v * 3 + 1]), Math.abs(p[mv * 3 + 2] - p[v * 3 + 2]));
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
    expect(maxErr).toBeLessThan(1e-4);
  });

  it('Masked vertices do not move while neighbours do', () => {
    const m = sphere();
    // mask the +x half of the footprint fully
    const verts = m.queryCanonical(top, 0.25, []).slice();
    const masked = verts.filter((v) => m.positions[v * 3] > 0.02);
    for (const v of masked) m.setCanonicalMask(v, 1);
    const before = m.positions.slice();
    stroke(m, 'draw');
    for (const v of masked) for (let k = 0; k < 3; k++) expect(m.positions[v * 3 + k]).toBe(before[v * 3 + k]);
    const free = verts.filter((v) => m.positions[v * 3] < -0.02);
    expect(free.some((v) => Math.abs(m.positions[v * 3 + 1] - before[v * 3 + 1]) > 1e-4)).toBe(true);
  });

  it('Mask brush paints weights and is undoable', () => {
    const m = sphere();
    const { patch } = stroke(m, 'mask');
    expect(patch).not.toBeNull();
    expect(Math.max(...m.mask)).toBeGreaterThan(0.5);
    applyPatch(m, patch!, 'before');
    expect(Math.max(...m.mask)).toBe(0);
  });
});

describe('history', () => {
  it('commit → undo → redo restores exact positions; cancel rolls back', () => {
    const m = sphere();
    const h = new History();
    const p0 = m.positions.slice();
    const { patch } = stroke(m, 'draw');
    const p1 = m.positions.slice();
    expect(maxDelta(p0, p1)).toBeGreaterThan(1e-3);
    h.push({ label: 'draw', bytes: 0, undo: () => applyPatch(m, patch!, 'before'), redo: () => applyPatch(m, patch!, 'after') });
    h.undo();
    expect(maxDelta(p0, m.positions)).toBe(0);
    h.redo();
    expect(maxDelta(p1, m.positions)).toBe(0);
    // cancel
    const s = defaultSettings('draw');
    const st = new SculptStroke(m, 'draw', s, s.radius, { x: false, y: false, z: false });
    st.dab(top); st.dab(top);
    expect(maxDelta(p1, m.positions)).toBeGreaterThan(0);
    st.cancel();
    expect(maxDelta(p1, m.positions)).toBe(0);
  });

  it('patches refuse to apply after a topology change', () => {
    const m = sphere();
    const { patch } = stroke(m, 'draw');
    m.replaceGeometry(subdivideMidpoint(m.geometry));
    expect(() => applyPatch(m, patch!, 'before')).toThrow(/stale/);
  });
});

describe('topology', () => {
  it('midpoint subdivision creates real new vertices and 4x triangles', () => {
    const m = sphere();
    const t0 = m.triangleCount, v0 = m.vertexCount;
    m.replaceGeometry(subdivideMidpoint(m.geometry));
    expect(m.triangleCount).toBe(t0 * 4);
    expect(m.vertexCount).toBeGreaterThan(v0);
    expect(allFinite(m.positions)).toBe(true);
  });

  it('decimation reduces triangle count', async () => {
    const m = sphere();
    const t0 = m.triangleCount;
    m.replaceGeometry(await decimate(m.geometry, 0.5));
    expect(m.triangleCount).toBeLessThan(t0 * 0.7);
    expect(m.triangleCount).toBeGreaterThan(t0 * 0.2);
  });
});

describe('normals', () => {
  it('stay consistent with geometry after many overlapping dabs (re-touched vertices are refreshed)', () => {
    const m = sphere();
    const s = defaultSettings('draw');
    const st = new SculptStroke(m, 'draw', s, s.radius, { x: true, y: false, z: false });
    for (let i = 0; i < 12; i++) { st.dab(new THREE.Vector3(Math.sin(i) * 0.05, 0.5, Math.cos(i) * 0.05), 1, i % 3 !== 0); }
    st.commit();
    const stored = m.normals.slice();
    const all: number[] = [];
    for (let v = 0; v < m.vertexCount; v++) if (m.weldOf[v] === v) all.push(v);
    const region = all.filter((v) => m.positions[v * 3 + 1] > 0.2);
    m.updateNormals(region);
    let worst = 0;
    for (const v of region) worst = Math.max(worst, Math.abs(stored[v * 3] - m.normals[v * 3]), Math.abs(stored[v * 3 + 1] - m.normals[v * 3 + 1]), Math.abs(stored[v * 3 + 2] - m.normals[v * 3 + 2]));
    expect(worst).toBeLessThan(1e-5);
  });
});

describe('local/world mapping', () => {
  it('a world-space dab on a translated/rotated/scaled object edits exactly the vertices under it', () => {
    const m = sphere();
    const obj = new THREE.Mesh(m.geometry);
    obj.position.set(3, -1, 2); obj.rotation.set(0.4, 1.1, -0.3); obj.scale.setScalar(2.5);
    obj.updateMatrixWorld(true);
    // world hit point = transformed local vertex 0's position region
    const localTarget = new THREE.Vector3(0, 0.5, 0);
    const worldHit = localTarget.clone().applyMatrix4(obj.matrixWorld);
    const worldRadius = 0.5; // world units
    const scale = Math.cbrt(Math.abs(obj.matrixWorld.determinant()));
    const local = obj.worldToLocal(worldHit.clone());
    const before = m.positions.slice();
    const st = new SculptStroke(m, 'draw', defaultSettings('draw'), worldRadius / scale, { x: false, y: false, z: false });
    st.dab(local); st.commit();
    let moved = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      const d = Math.hypot(m.positions[v * 3] - before[v * 3], m.positions[v * 3 + 1] - before[v * 3 + 1], m.positions[v * 3 + 2] - before[v * 3 + 2]);
      if (d < 1e-7) continue;
      moved++;
      const w = new THREE.Vector3(before[v * 3], before[v * 3 + 1], before[v * 3 + 2]).applyMatrix4(obj.matrixWorld);
      expect(w.distanceTo(worldHit)).toBeLessThanOrEqual(worldRadius + 1e-5);
    }
    expect(moved).toBeGreaterThan(10);
  });
});
