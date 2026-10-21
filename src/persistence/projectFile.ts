import * as THREE from 'three';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { SceneObject, Provenance, MaterialParams } from '../scene/SceneModel';
import type { Units } from '../io/exporters';

export const PROJECT_FORMAT = 'formengine-project';
export const SCHEMA_VERSION = 1;
export const APP_VERSION = '0.1.0';

export interface ReferenceImageRecord {
  id: string;
  name: string;
  view: string;
  mime: string;
  opacity: number;
  visible: boolean;
  position: number[];
  quaternion: number[];
  scale: number[];
  /** Image bytes are stored in the zip, not in the manifest. */
  blob?: Blob;
}

export interface JobRecordLite {
  id: string;
  provider: string;
  mode: string;
  remoteId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sourceImageIds: string[];
  error?: string;
  resultObjectIds?: string[];
  consent?: { at: string; provider: string; imageCount: number };
}

export interface ProjectManifest {
  format: typeof PROJECT_FORMAT;
  schemaVersion: number;
  generator: string;
  savedAt: string;
  id: string;
  name: string;
  units: Units;
  upAxis: 'Y';
  camera?: { position: number[]; target: number[]; ortho: boolean };
  settings?: Record<string, unknown>;
  objects: {
    id: string; name: string; visible: boolean; locked: boolean;
    transform: { position: number[]; quaternion: number[]; scale: number[] };
    materialParams: MaterialParams;
    /** index into materials.json children */
    materialRef: number;
    geometry: { vertexCount: number; index: string; attributes: Record<string, { file: string; itemSize: number; normalized: boolean; type: 'f32' }>; groups: { start: number; count: number; materialIndex?: number }[] };
    provenance: Provenance;
  }[];
  references: Omit<ReferenceImageRecord, 'blob'>[];
  jobs: JobRecordLite[];
}

export interface ProjectState {
  id: string;
  name: string;
  units: Units;
  objects: SceneObject[];
  camera?: ProjectManifest['camera'];
  settings?: Record<string, unknown>;
  references: ReferenceImageRecord[];
  jobs: JobRecordLite[];
}

export interface LoadedObject {
  id: string; name: string; visible: boolean; locked: boolean;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  materialParams: MaterialParams;
  position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3;
  provenance: Provenance;
}

export interface LoadedProject {
  manifest: ProjectManifest;
  objects: LoadedObject[];
  references: ReferenceImageRecord[];
}

const bytes = (a: ArrayBufferView) => new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));

/** Serialise project state into a .formengine ZIP. */
export async function writeProject(state: ProjectState): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const matHolder = new THREE.Group();
  const placeholder = new THREE.BufferGeometry();
  const manifest: ProjectManifest = {
    format: PROJECT_FORMAT, schemaVersion: SCHEMA_VERSION, generator: `FORM//ENGINE ${APP_VERSION}`, savedAt: new Date().toISOString(),
    id: state.id, name: state.name, units: state.units, upAxis: 'Y', camera: state.camera, settings: state.settings,
    objects: [], references: [], jobs: state.jobs,
  };
  state.objects.forEach((o, i) => {
    const g = o.editable.geometry;
    const attributes: ProjectManifest['objects'][number]['geometry']['attributes'] = {};
    for (const [name, a] of Object.entries(g.attributes)) {
      const attr = a as THREE.BufferAttribute;
      const file = `geometry/${o.id}/${name}.f32`;
      files[file] = bytes(Float32Array.from(attr.array as ArrayLike<number>));
      attributes[name] = { file, itemSize: attr.itemSize, normalized: attr.normalized, type: 'f32' };
    }
    const indexFile = `geometry/${o.id}/index.u32`;
    files[indexFile] = bytes(g.index!.array as Uint32Array);
    const mesh = new THREE.Mesh(placeholder, o.baseMaterial);
    matHolder.add(mesh);
    manifest.objects.push({
      id: o.id, name: o.name, visible: o.visible, locked: o.locked,
      transform: { position: o.mesh.position.toArray(), quaternion: o.mesh.quaternion.toArray(), scale: o.mesh.scale.toArray() },
      materialParams: o.materialParams, materialRef: i,
      geometry: { vertexCount: o.editable.vertexCount, index: indexFile, attributes, groups: g.groups.map((gr) => ({ ...gr })) },
      provenance: o.provenance,
    });
  });
  // Materials (incl. textures as embedded images) via three's JSON serialiser on placeholder meshes.
  let matJSON: unknown = null;
  try { matJSON = matHolder.toJSON(); } catch (e) { console.warn('Material serialisation failed; falling back to params', e); }
  files['materials.json'] = strToU8(JSON.stringify(matJSON));
  for (const r of state.references) {
    const { blob, ...rest } = r;
    manifest.references.push(rest);
    if (blob) files[`images/${r.id}`] = new Uint8Array(await blob.arrayBuffer());
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  placeholder.dispose();
  return zipSync(files, { level: 6 });
}

export class ProjectError extends Error {}

type Migration = (m: any) => any;
/** schemaVersion N → N+1 migrations. Empty for v1. */
const MIGRATIONS: Record<number, Migration> = {};

export function migrateManifest(m: any): ProjectManifest {
  if (!m || m.format !== PROJECT_FORMAT) throw new ProjectError('Not a FORM//ENGINE project file.');
  if (typeof m.schemaVersion !== 'number') throw new ProjectError('Project manifest has no schema version.');
  if (m.schemaVersion > SCHEMA_VERSION) throw new ProjectError(`This project was saved by a newer FORM//ENGINE (schema ${m.schemaVersion}; this build reads ≤ ${SCHEMA_VERSION}). Nothing was changed.`);
  let cur = m;
  for (let v = cur.schemaVersion; v < SCHEMA_VERSION; v++) {
    const mig = MIGRATIONS[v];
    if (!mig) throw new ProjectError(`No migration from schema ${v}.`);
    cur = { ...mig(cur), schemaVersion: v + 1 };
  }
  return cur as ProjectManifest;
}

/** Parse a .formengine ZIP. Throws ProjectError on any structural problem without side effects. */
export async function readProject(data: Uint8Array): Promise<LoadedProject> {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(data); } catch (e) { throw new ProjectError(`Project archive is corrupted: ${(e as Error).message}`); }
  const mf = files['manifest.json'];
  if (!mf) throw new ProjectError('Project archive has no manifest.json.');
  let raw: unknown;
  try { raw = JSON.parse(strFromU8(mf)); } catch { throw new ProjectError('Project manifest is not valid JSON.'); }
  const manifest = migrateManifest(raw);

  let materials: THREE.Material[] = [];
  try {
    const mj = files['materials.json'] ? JSON.parse(strFromU8(files['materials.json'])) : null;
    if (mj) {
      const root = await new THREE.ObjectLoader().parseAsync(mj);
      materials = root.children.map((c) => (c as THREE.Mesh).material as THREE.Material);
    }
  } catch (e) { console.warn('Could not restore materials; using params', e); }

  const objects: LoadedObject[] = manifest.objects.map((o) => {
    const g = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(o.geometry.attributes)) {
      const buf = files[a.file];
      if (!buf) throw new ProjectError(`Missing geometry buffer ${a.file}`);
      const arr = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      if (arr.length !== o.geometry.vertexCount * a.itemSize) throw new ProjectError(`Geometry buffer ${a.file} has wrong length.`);
      for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) throw new ProjectError(`Geometry buffer ${a.file} contains non-finite values.`);
      g.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
    }
    const ib = files[o.geometry.index];
    if (!ib) throw new ProjectError(`Missing index buffer for ${o.name}`);
    const index = new Uint32Array(ib.buffer.slice(ib.byteOffset, ib.byteOffset + ib.byteLength));
    for (let i = 0; i < index.length; i++) if (index[i] >= o.geometry.vertexCount) throw new ProjectError(`Index out of range in ${o.name}`);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    for (const gr of o.geometry.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    const p = o.materialParams;
    const material = materials[o.materialRef] ?? new THREE.MeshStandardMaterial({ color: p.color, roughness: p.roughness, metalness: p.metalness });
    return {
      id: o.id, name: o.name, visible: o.visible, locked: o.locked, geometry: g, material, materialParams: o.materialParams,
      position: new THREE.Vector3().fromArray(o.transform.position), quaternion: new THREE.Quaternion().fromArray(o.transform.quaternion), scale: new THREE.Vector3().fromArray(o.transform.scale),
      provenance: o.provenance,
    };
  });
  const references = manifest.references.map((r) => {
    const b = files[`images/${r.id}`];
    return { ...r, blob: b ? new Blob([b.slice()], { type: r.mime }) : undefined };
  });
  return { manifest, objects, references };
}
