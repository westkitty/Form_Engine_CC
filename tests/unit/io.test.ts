import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { writeFileSync, mkdirSync } from 'node:fs';
import { SceneModel } from '../../src/scene/SceneModel';
import { makePrimitive } from '../../src/geometry/topology';
import { SculptStroke } from '../../src/sculpt/Stroke';
import { defaultSettings } from '../../src/sculpt/brushes';
import { exportObjects, DEFAULT_EXPORT } from '../../src/io/exporters';
import { parseModel, sniffFormat, ImportError } from '../../src/io/importers';
import { writeProject, readProject, ProjectError, migrateManifest } from '../../src/persistence/projectFile';
import { analyzeGeometry } from '../../src/io/validate';

// GLTFExporter (binary) uses FileReader, which Node lacks. Minimal faithful polyfill.
beforeAll(() => {
  if (typeof (globalThis as any).FileReader === 'undefined') {
    (globalThis as any).FileReader = class {
      result: ArrayBuffer | string | null = null; onloadend: (() => void) | null = null; onload: (() => void) | null = null;
      readAsArrayBuffer(b: Blob) { b.arrayBuffer().then((r) => { this.result = r; this.onload?.(); this.onloadend?.(); }); }
      readAsDataURL(b: Blob) { b.arrayBuffer().then((r) => { this.result = `data:${b.type};base64,${Buffer.from(r).toString('base64')}`; this.onload?.(); this.onloadend?.(); }); }
    };
  }
});

/** Asymmetric test sculpture: sphere with a Draw bump at +x+y and a Grab pull at -z. */
function makeSculpture() {
  const scene = new SceneModel();
  const obj = scene.create(makePrimitive('sphere', 2), { name: 'Asymmetric Sculpture', provenance: { source: 'primitive', createdAt: new Date().toISOString() } });
  scene.add(obj);
  const s = defaultSettings('draw');
  const st = new SculptStroke(obj.editable, 'draw', { ...s, strength: 1 }, 0.2, { x: false, y: false, z: false });
  const c = new THREE.Vector3(0.3, 0.3, 0).normalize().multiplyScalar(0.5);
  for (let i = 0; i < 8; i++) st.dab(c);
  st.commit();
  const g = new SculptStroke(obj.editable, 'grab', defaultSettings('grab'), 0.3, { x: false, y: false, z: false });
  g.beginGrab(new THREE.Vector3(0, 0, -0.5));
  g.updateGrab(new THREE.Vector3(0, 0, -0.25));
  g.commit();
  obj.mesh.position.set(0.5, 0.25, -0.1);
  obj.mesh.rotation.set(0.2, 0.4, 0);
  obj.mesh.scale.set(1.5, 1.5, 1.5);
  obj.mesh.updateMatrixWorld(true);
  return { scene, obj };
}

/** Bake an object's world positions for comparison. */
function worldPositions(geom: THREE.BufferGeometry, m: THREE.Matrix4) {
  const g = geom.clone(); g.applyMatrix4(m); return g.attributes.position.array as Float32Array;
}

/** Max distance from each point in A to its nearest in B (brute force with a spatial grid). */
function hausdorff(a: Float32Array, b: Float32Array) {
  const cell = 0.02, grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < b.length; i += 3) { const k = key(b[i], b[i + 1], b[i + 2]); (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); }
  let worst = 0;
  for (let i = 0; i < a.length; i += 3) {
    let best = Infinity;
    const cx = Math.floor(a[i] / cell), cy = Math.floor(a[i + 1] / cell), cz = Math.floor(a[i + 2] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) best = Math.min(best, Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

const outDir = 'test-results/roundtrip';

describe('export → re-import round trip (asymmetric sculpture)', () => {
  it('GLB keeps edited geometry and node transform', async () => {
    const { obj } = makeSculpture();
    const res = await exportObjects([obj], { ...DEFAULT_EXPORT, format: 'glb' });
    const buf = res.data as ArrayBuffer;
    expect(sniffFormat(buf)).toBe('glb');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/sculpture.glb`, Buffer.from(buf));
    const back = await parseModel(buf, 'sculpture.glb');
    expect(back.meshes).toHaveLength(1);
    const m = back.meshes[0];
    expect(m.geometry.attributes.position.count).toBe(obj.editable.vertexCount);
    const mat = new THREE.Matrix4().compose(m.position, m.quaternion, m.scale);
    const reimported = worldPositions(m.geometry, mat);
    const original = worldPositions(obj.editable.geometry, obj.mesh.matrixWorld);
    expect(hausdorff(original, reimported)).toBeLessThan(1e-4);
    // edited feature retained: the bump differs from an unedited sphere
    const plain = worldPositions(makePrimitive('sphere', 2), obj.mesh.matrixWorld);
    expect(hausdorff(reimported, plain)).toBeGreaterThan(0.05);
    for (const v of reimported) expect(Number.isFinite(v)).toBe(true);
  });

  it('OBJ (baked) keeps edited geometry', async () => {
    const { obj } = makeSculpture();
    const res = await exportObjects([obj], { ...DEFAULT_EXPORT, format: 'obj' });
    expect(typeof res.data).toBe('string');
    expect(res.warnings.join(' ')).toMatch(/mtl/i);
    writeFileSync(`${outDir}/sculpture.obj`, res.data as string);
    const back = await parseModel(new TextEncoder().encode(res.data as string).buffer as ArrayBuffer, 'sculpture.obj');
    const reimported = back.meshes[0].geometry.attributes.position.array as Float32Array;
    const original = worldPositions(obj.editable.geometry, obj.mesh.matrixWorld);
    expect(hausdorff(original, reimported)).toBeLessThan(1e-4);
    expect(back.meshes[0].report.triangles).toBe(obj.editable.triangleCount);
  });

  it('STL (binary, mm) keeps edited geometry scaled by units and warns', async () => {
    const { obj } = makeSculpture();
    const res = await exportObjects([obj], { ...DEFAULT_EXPORT, format: 'stl', outUnits: 'mm' });
    const buf = res.data as ArrayBuffer;
    writeFileSync(`${outDir}/sculpture_mm.stl`, Buffer.from(buf));
    expect(res.warnings.join(' ')).toMatch(/no units/i);
    const back = await parseModel(buf, 'sculpture.stl');
    expect(back.warnings.join(' ')).toMatch(/geometry only/i);
    const reimported = (back.meshes[0].geometry.attributes.position.array as Float32Array).map((v) => v / 1000);
    const original = worldPositions(obj.editable.geometry, obj.mesh.matrixWorld);
    expect(hausdorff(original, reimported)).toBeLessThan(1e-4);
    expect(back.meshes[0].report.watertight).toBe(true);
  });

  it('rejects malformed and empty files with remedies', async () => {
    await expect(parseModel(new TextEncoder().encode('hello world').buffer as ArrayBuffer, 'junk.glb')).rejects.toBeInstanceOf(ImportError);
    const fakeGlb = new Uint8Array(64); new DataView(fakeGlb.buffer).setUint32(0, 0x46546c67, true);
    await expect(parseModel(fakeGlb.buffer, 'broken.glb')).rejects.toBeInstanceOf(ImportError);
    const nan = 'v NaN 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
    await expect(parseModel(new TextEncoder().encode(nan).buffer as ArrayBuffer, 'nan.obj')).rejects.toThrow(/non-finite/);
  });
});

describe('.formengine project', () => {
  it('save → open preserves geometry exactly, transforms, mask, names, provenance', async () => {
    const { obj } = makeSculpture();
    obj.editable.setCanonicalMask(0, 0.75);
    const zip = await writeProject({ id: 'p1', name: 'Test', units: 'cm', objects: [obj], references: [], jobs: [] });
    writeFileSync(`${outDir}/sample.formengine`, zip);
    const back = await readProject(zip);
    expect(back.manifest.units).toBe('cm');
    const o = back.objects[0];
    expect(o.name).toBe('Asymmetric Sculpture');
    expect(o.provenance.source).toBe('primitive');
    const a = obj.editable.positions, b = o.geometry.attributes.position.array as Float32Array;
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
    expect((o.geometry.attributes.aMask.array as Float32Array)[0]).toBeCloseTo(0.75);
    expect(o.position.toArray()).toEqual(obj.mesh.position.toArray());
    expect(o.scale.x).toBeCloseTo(1.5);
    expect(Array.from(o.geometry.index!.array)).toEqual(Array.from(obj.editable.index));
  });

  it('refuses newer schema and corrupted archives without side effects', async () => {
    expect(() => migrateManifest({ format: 'formengine-project', schemaVersion: 99 })).toThrow(ProjectError);
    await expect(readProject(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(ProjectError);
  });

  it('validation reports a watertight single shell for the sculpture', () => {
    const { obj } = makeSculpture();
    const r = analyzeGeometry(obj.editable.geometry);
    expect(r.watertight).toBe(true);
    expect(r.components).toBe(1);
  });
});
