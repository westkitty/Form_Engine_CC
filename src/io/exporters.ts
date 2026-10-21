import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import type { SceneObject } from '../scene/SceneModel';
import { analyzeGeometry, type MeshReport } from './validate';

export type ExportFormat = 'glb' | 'obj' | 'stl';
export type Units = 'm' | 'cm' | 'mm' | 'in';
export const UNIT_TO_M: Record<Units, number> = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254 };

export interface ExportOptions {
  format: ExportFormat;
  /** Keep node transforms (GLB only) or bake them into vertices. OBJ/STL always bake. */
  applyTransforms: boolean;
  /** Scene units and desired output units — positions are scaled by scene/out. */
  sceneUnits: Units;
  outUnits: Units;
  /** GLB: export each object's own material, or plain clay. */
  materials: 'own' | 'clay';
  stlBinary: boolean;
}

export const DEFAULT_EXPORT: ExportOptions = { format: 'glb', applyTransforms: false, sceneUnits: 'm', outUnits: 'm', materials: 'own', stlBinary: true };

export interface ExportResult {
  data: ArrayBuffer | string;
  mime: string;
  extension: string;
  reports: { name: string; report: MeshReport }[];
  warnings: string[];
}

/** Clean, export-only copy of an object's edited geometry (drops editor-only attributes). */
function exportGeometry(o: SceneObject, bake: boolean, unitScale: number) {
  const src = o.editable.geometry;
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'uv1', 'color']) {
    const a = src.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (a) g.setAttribute(name, new THREE.BufferAttribute((a.array as Float32Array).slice(), a.itemSize, a.normalized));
  }
  g.setIndex(new THREE.BufferAttribute((src.index!.array as Uint32Array).slice(), 1));
  for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  if (bake) {
    o.mesh.updateWorldMatrix(true, false);
    g.applyMatrix4(new THREE.Matrix4().makeScale(unitScale, unitScale, unitScale).multiply(o.mesh.matrixWorld));
    // a mirroring transform flips winding; correct it so faces stay outward
    if (o.mesh.matrixWorld.determinant() < 0) {
      const idx = g.index!.array as Uint32Array;
      for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
    }
  }
  return g;
}

function exportMaterial(o: SceneObject, mode: 'own' | 'clay'): THREE.Material | THREE.Material[] {
  if (mode === 'clay' || o.materialParams.kind === 'clay') {
    return new THREE.MeshStandardMaterial({ color: o.materialParams.color, roughness: o.materialParams.roughness, metalness: o.materialParams.metalness, name: 'FORM Clay' });
  }
  return o.baseMaterial;
}

export async function exportObjects(objects: SceneObject[], opts: ExportOptions): Promise<ExportResult> {
  if (!objects.length) throw new Error('Nothing to export: no visible objects selected.');
  const unitScale = UNIT_TO_M[opts.sceneUnits] / UNIT_TO_M[opts.outUnits];
  const bake = opts.format !== 'glb' || opts.applyTransforms;
  const warnings: string[] = [];
  const root = new THREE.Group();
  root.name = 'FORM_ENGINE_export';
  const reports: ExportResult['reports'] = [];
  const temps: THREE.BufferGeometry[] = [];
  for (const o of objects) {
    const g = exportGeometry(o, bake, unitScale);
    temps.push(g);
    const m = new THREE.Mesh(g, exportMaterial(o, opts.materials));
    m.name = o.name;
    if (!bake) {
      o.mesh.updateWorldMatrix(true, false);
      o.mesh.matrixWorld.decompose(m.position, m.quaternion, m.scale);
    }
    root.add(m);
    reports.push({ name: o.name, report: analyzeGeometry(g) });
  }
  if (!bake && unitScale !== 1) root.scale.setScalar(unitScale);
  root.updateMatrixWorld(true);

  try {
    switch (opts.format) {
      case 'glb': {
        const data = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false }) as ArrayBuffer;
        return { data, mime: 'model/gltf-binary', extension: 'glb', reports, warnings };
      }
      case 'obj': {
        warnings.push('OBJ export contains geometry, normals and UVs only. Materials (.mtl) and textures are not written.');
        const data = new OBJExporter().parse(root);
        return { data, mime: 'text/plain', extension: 'obj', reports, warnings };
      }
      case 'stl': {
        warnings.push('STL has no units, colours, UVs or materials. Values are written in ' + opts.outUnits + '.');
        for (const r of reports) {
          if (!r.report.watertight) warnings.push(`"${r.name}" is not watertight (${r.report.boundaryEdges} open edges, ${r.report.nonManifoldEdges} non-manifold) — may fail to slice for 3D printing.`);
          if (r.report.components > 1) warnings.push(`"${r.name}" has ${r.report.components} disconnected shells.`);
          if (r.report.inconsistentWinding) warnings.push(`"${r.name}" has ${r.report.inconsistentWinding} inconsistently wound edges.`);
        }
        const out = new STLExporter().parse(root, { binary: opts.stlBinary }) as DataView | string;
        const data = typeof out === 'string' ? out : (out.buffer as ArrayBuffer).slice(out.byteOffset, out.byteOffset + out.byteLength);
        return { data, mime: opts.stlBinary ? 'model/stl' : 'text/plain', extension: 'stl', reports, warnings };
      }
      default: throw new Error(`Unsupported export format ${opts.format}`);
    }
  } finally {
    for (const g of temps) g.dispose();
  }
}

export async function sha256(data: ArrayBuffer | string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Sanitise a user-provided name for use as a download file name. */
export function safeFileName(name: string, ext: string) {
  const base = name.normalize('NFKC').replace(/[^\w\- .]+/g, '_').replace(/\s+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'form-engine';
  return `${base}.${ext}`;
}

/** Trigger a real browser download; returns false if the sandbox blocks it. */
export function downloadBlob(data: BlobPart, mime: string, fileName: string): boolean {
  try {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } catch {
    return false;
  }
}
