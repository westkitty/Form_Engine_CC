// Run with: npx vitest run tests/unit/perf.bench.ts  (included in the normal test run as a smoke check)
import { it, expect } from 'vitest';
import * as THREE from 'three';
import { EditableMesh } from '../../src/geometry/EditableMesh';
import { SculptStroke } from '../../src/sculpt/Stroke';
import { defaultSettings, applyDab, areaFrame } from '../../src/sculpt/brushes';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function ico(detail: number) { const g = new THREE.IcosahedronGeometry(0.5, detail); g.deleteAttribute('uv'); g.deleteAttribute('normal'); const m = mergeVertices(g); m.computeVertexNormals(); return m; }

it('dab cost breakdown on ~100k-triangle sphere', () => {
  const mesh = new EditableMesh(ico(72));
  const c = new THREE.Vector3(0, 0, 0.5);
  const q: number[] = [];
  const T = { query: 0, dab: 0, normals: 0, refit: 0 };
  const traversed = new Set<number>();
  const N = 60;
  for (let i = 0; i < N; i++) {
    c.set(Math.sin(i / 10) * 0.2, Math.cos(i / 13) * 0.2, 0.45);
    let t = performance.now();
    mesh.queryCanonical(c, 0.15, q, traversed); T.query += performance.now() - t; t = performance.now();
    applyDab({ mesh, type: 'draw', verts: q, center: c, radius: 0.15, strength: 0.5, invert: false, falloff: 'smooth', protectBoundary: true, touch: () => {} }); T.dab += performance.now() - t; t = performance.now();
    mesh.updateNormals(q); T.normals += performance.now() - t; t = performance.now();
    mesh.commitPositions(traversed); traversed.clear(); T.refit += performance.now() - t;
  }
  const per = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, +(v / N).toFixed(3)]));
  console.log('tris', mesh.triangleCount, 'verts in brush', q.length, 'ms per dab', per);
  expect(mesh.triangleCount).toBeGreaterThan(100000);
  void areaFrame; void SculptStroke; void defaultSettings;
});
