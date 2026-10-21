import * as THREE from 'three';
import { EditableMesh } from '../geometry/EditableMesh';

export interface Provenance {
  source: 'primitive' | 'import' | 'reconstruction' | 'relief' | 'project';
  detail?: string;
  /** For reconstruction: provider id, job id, source image ids. Never secrets. */
  provider?: string;
  jobId?: string;
  sourceImages?: string[];
  inferredWarning?: string;
  createdAt: string;
}

export interface MaterialParams {
  kind: 'clay' | 'imported';
  color: string;
  roughness: number;
  metalness: number;
}

export interface SceneObject {
  id: string;
  name: string;
  mesh: THREE.Mesh;
  editable: EditableMesh;
  visible: boolean;
  locked: boolean;
  /** The material the object owns (clay or imported). View modes swap the displayed material only. */
  baseMaterial: THREE.Material | THREE.Material[];
  materialParams: MaterialParams;
  provenance: Provenance;
}

export const CLAY_COLOR = '#c9b8a3';

export function makeClayMaterial(color = CLAY_COLOR) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.0, name: 'FORM Clay' });
}

let counter = 0;
export function newId(prefix = 'obj') {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rnd}${(counter++).toString(36)}`;
}

/** Ordered list of sculptable objects plus selection; renderer-agnostic. */
export class SceneModel {
  readonly root = new THREE.Group();
  objects: SceneObject[] = [];
  selectedId: string | null = null;
  private listeners = new Set<() => void>();

  constructor() { this.root.name = 'FORM//ENGINE scene'; }

  create(geometry: THREE.BufferGeometry, opts: { name: string; material?: THREE.Material | THREE.Material[]; materialParams?: MaterialParams; provenance: Provenance; id?: string }): SceneObject {
    const editable = new EditableMesh(geometry);
    const material = opts.material ?? makeClayMaterial();
    const mesh = new THREE.Mesh(editable.geometry, material);
    mesh.name = opts.name;
    const obj: SceneObject = {
      id: opts.id ?? newId(), name: opts.name, mesh, editable, visible: true, locked: false, baseMaterial: material,
      materialParams: opts.materialParams ?? { kind: 'clay', color: CLAY_COLOR, roughness: 0.62, metalness: 0 },
      provenance: opts.provenance,
    };
    mesh.userData.objectId = obj.id;
    return obj;
  }

  add(obj: SceneObject, index = this.objects.length) {
    this.objects.splice(index, 0, obj);
    this.root.add(obj.mesh);
    this.emit();
  }

  remove(id: string): { obj: SceneObject; index: number } | null {
    const index = this.objects.findIndex((o) => o.id === id);
    if (index < 0) return null;
    const [obj] = this.objects.splice(index, 1);
    this.root.remove(obj.mesh);
    if (this.selectedId === id) this.selectedId = null;
    this.emit();
    return { obj, index };
  }

  get(id: string | null) { return id ? this.objects.find((o) => o.id === id) ?? null : null; }
  get selected() { return this.get(this.selectedId); }
  select(id: string | null) { this.selectedId = id; this.emit(); }

  setVisible(id: string, v: boolean) { const o = this.get(id); if (o) { o.visible = v; o.mesh.visible = v; this.emit(); } }
  setLocked(id: string, v: boolean) { const o = this.get(id); if (o) { o.locked = v; this.emit(); } }
  rename(id: string, name: string) { const o = this.get(id); if (o) { o.name = name; o.mesh.name = name; this.emit(); } }

  totals() {
    let tris = 0, verts = 0;
    for (const o of this.objects) { tris += o.editable.triangleCount; verts += o.editable.vertexCount; }
    return { objects: this.objects.length, triangles: tris, vertices: verts };
  }

  /** Dispose GPU resources of an object that will never come back (history no longer references it). */
  static dispose(obj: SceneObject) {
    obj.editable.geometry.dispose();
    const mats = Array.isArray(obj.baseMaterial) ? obj.baseMaterial : [obj.baseMaterial];
    for (const m of mats) disposeMaterial(m);
  }

  clear() {
    for (const o of this.objects) { this.root.remove(o.mesh); SceneModel.dispose(o); }
    this.objects = [];
    this.selectedId = null;
    this.emit();
  }

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const l of this.listeners) l(); }
}

export function disposeMaterial(m: THREE.Material) {
  for (const v of Object.values(m)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
  m.dispose();
}
