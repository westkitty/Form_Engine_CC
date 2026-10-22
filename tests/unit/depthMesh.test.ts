import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildDepthShell, otsu, type Field } from '../../src/reconstruction/depthMesh';
import { analyzeGeometry } from '../../src/io/validate';
import { EditableMesh } from '../../src/geometry/EditableMesh';
import { SculptStroke } from '../../src/sculpt/Stroke';
import { defaultSettings } from '../../src/sculpt/brushes';

/** Synthetic "photo": a near dome (subject) on a far flat background, like a depth model's output. */
function domeDepth(w = 200, h = 150): Field {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - w * 0.45) / (h * 0.35), dy = (y - h * 0.5) / (h * 0.35);
    const r2 = dx * dx + dy * dy;
    data[y * w + x] = r2 < 1 ? 0.6 + 0.4 * Math.sqrt(1 - r2) : 0.1 + 0.02 * Math.sin(x * 0.3); // near subject, far noisy bg
  }
  return { data, width: w, height: h };
}

describe('depth shell (on-device single-view reconstruction geometry)', () => {
  it('Otsu separates near subject from far background', () => {
    const t = otsu(Float32Array.from([0.1, 0.12, 0.11, 0.9, 0.85, 0.95]));
    expect(t).toBeGreaterThan(0.12);
    expect(t).toBeLessThan(0.85);
  });

  it('builds a closed, manifold, single-shell mesh from depth alone (mask by depth threshold)', () => {
    const r = buildDepthShell({ depth: domeDepth(), mask: null, aspect: 200 / 150 });
    expect(r.maskSource).toBe('depth-threshold');
    const rep = analyzeGeometry(r.geometry);
    expect(rep.triangles).toBeGreaterThan(5000);
    expect(rep.nonFinite).toBe(0);
    expect(rep.watertight).toBe(true);
    expect(rep.nonManifoldEdges).toBe(0);
    expect(rep.inconsistentWinding).toBe(0);
    expect(rep.components).toBe(1);
    // subject only: coverage roughly the dome's share of the frame, not the full frame
    expect(r.coverage).toBeGreaterThan(0.2);
    expect(r.coverage).toBeLessThan(0.6);
  });

  it('front follows estimated depth: the dome centre protrudes more than its rim', () => {
    const r = buildDepthShell({ depth: domeDepth(), mask: null, aspect: 200 / 150 });
    const p = r.geometry.attributes.position.array as Float32Array;
    let maxZ = -Infinity, minZ = Infinity;
    for (let i = 2; i < p.length; i += 3) { maxZ = Math.max(maxZ, p[i]); minZ = Math.min(minZ, p[i]); }
    expect(maxZ).toBeGreaterThan(0.1);
    expect(minZ).toBeLessThan(0); // has a (inferred) back
    expect(maxZ).toBeGreaterThan(-minZ); // back is flatter than front (backRatio < 1)
  });

  it('uses a provided alpha mask, including concave (L-shaped) silhouettes', () => {
    const w = 120, h = 120, m = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = (x > 20 && x < 100 && y > 20 && y < 50) || (x > 20 && x < 50 && y > 20 && y < 100) ? 1 : 0;
    const flat = { data: new Float32Array(w * h).fill(0.5), width: w, height: h };
    const r = buildDepthShell({ depth: flat, mask: { data: m, width: w, height: h }, aspect: 1 });
    expect(r.maskSource).toBe('alpha');
    const rep = analyzeGeometry(r.geometry);
    expect(rep.watertight).toBe(true);
    expect(rep.components).toBe(1);
  });

  it('result enters the normal editable pipeline and can be sculpted', () => {
    const r = buildDepthShell({ depth: domeDepth(), mask: null, aspect: 200 / 150 });
    const mesh = new EditableMesh(r.geometry);
    const before = mesh.positions.slice();
    const s = defaultSettings('draw');
    const st = new SculptStroke(mesh, 'draw', s, 0.1, { x: false, y: false, z: false });
    const box = new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position as THREE.BufferAttribute);
    st.dab(new THREE.Vector3(-0.05, 0, box.max.z));
    expect(st.commit()).not.toBeNull();
    let m = 0;
    for (let i = 0; i < before.length; i++) m = Math.max(m, Math.abs(before[i] - mesh.positions[i]));
    expect(m).toBeGreaterThan(1e-4);
  });
});
