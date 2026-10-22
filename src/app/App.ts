import * as THREE from 'three';
import { SceneModel, type SceneObject, type Provenance, newId, makeClayMaterial, CLAY_COLOR } from '../scene/SceneModel';
import { Viewport } from '../viewport/Viewport';
import type { ViewMode } from '../viewport/materials';
import { History, type Command } from '../history/History';
import { SculptStroke, applyPatch, mirrorSigns, resample, type SymmetrySettings, type VertexPatch } from '../sculpt/Stroke';
import { defaultSettings, type BrushSettings, type BrushType } from '../sculpt/brushes';
import { makePrimitive, subdivideMidpoint, decimate, type PrimitiveKind } from '../geometry/topology';
import { geometryFromSnapshot, type GeometrySnapshot } from '../geometry/EditableMesh';
import { importModelFiles, ImportError, parseModel, type ImportResult } from '../io/importers';
import { exportObjects, downloadBlob, safeFileName, sha256, STANDALONE_URL, type ExportOptions, type Units } from '../io/exporters';
import { analyzeGeometry, removeDebris, flipWinding } from '../io/validate';
import { writeProject, readProject, type ReferenceImageRecord, type JobRecordLite } from '../persistence/projectFile';
import * as store from '../persistence/idb';

export type Tool = 'select' | 'transform' | 'sculpt' | 'reference' | 'inspect';
export type TransformMode = 'translate' | 'rotate' | 'scale';

export interface Toast { id: number; kind: 'info' | 'ok' | 'warn' | 'error'; text: string; detail?: string[] }

interface ReferencePlane { record: ReferenceImageRecord; mesh: THREE.Mesh; texture: THREE.Texture }

/**
 * Application controller. Owns the canonical scene, history, viewport and persistence, and exposes
 * commands for the UI. UI code never mutates geometry directly.
 */
export class App {
  readonly model = new SceneModel();
  readonly history = new History();
  viewport!: Viewport;
  tool: Tool = 'sculpt';
  brush: BrushType = 'draw';
  brushSettings: Record<BrushType, BrushSettings>;
  symmetry: SymmetrySettings = { x: true, y: false, z: false };
  transformMode: TransformMode = 'translate';
  penOnlySculpt = false;
  /** False when the host blocks IndexedDB (e.g. sandboxed embeds); autosave is then skipped honestly. */
  storageOk = true;
  units: Units = 'm';
  projectId = newId('proj');
  projectName = 'Untitled sculpture';
  dirty = false;
  saveState: 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'unavailable' = 'idle';
  lastSavedAt: string | null = null;
  references: ReferencePlane[] = [];
  jobs: JobRecordLite[] = [];
  toasts: Toast[] = [];
  stroke: SculptStroke | null = null;
  lastStrokeStats = { ms: 0, dabs: 0, verts: 0 };
  readonly perf = { geometryMs: [] as number[], refitMs: 0 };
  private generation = 0;
  private saveTimer = 0;
  private listeners = new Set<(what: string) => void>();
  private toastSeq = 0;

  constructor() {
    this.brushSettings = Object.fromEntries((['draw', 'inflate', 'clay', 'smooth', 'grab', 'flatten', 'pinch', 'crease', 'mask'] as BrushType[]).map((b) => [b, defaultSettings(b)])) as Record<BrushType, BrushSettings>;
    this.history.onChange(() => { this.markDirty(); this.emit('history'); });
    this.model.onChange(() => this.emit('scene'));
  }

  mount(container: HTMLElement) {
    this.viewport = new Viewport(container, this.model);
    this.viewport.transform.addEventListener('mouseDown', () => this.beginTransform());
    this.viewport.transform.addEventListener('mouseUp', () => this.commitTransform());
    this.viewport.transform.addEventListener('objectChange', () => this.emit('transform'));
  }

  on(fn: (what: string) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what: string) { for (const l of this.listeners) l(what); }

  toast(kind: Toast['kind'], text: string, detail?: string[], ms = kind === 'error' ? 9000 : 4200) {
    const t: Toast = { id: ++this.toastSeq, kind, text, detail };
    this.toasts = [...this.toasts.slice(-4), t];
    this.emit('toast');
    if (ms > 0) setTimeout(() => this.dismissToast(t.id), ms);
    return t.id;
  }
  dismissToast(id: number) { this.toasts = this.toasts.filter((t) => t.id !== id); this.emit('toast'); }

  get selected() { return this.model.selected; }
  get settings() { return this.brushSettings[this.brush]; }

  setTool(t: Tool) {
    this.tool = t;
    this.syncTransformAttachment();
    if (t !== 'sculpt') this.viewport.placeCursor(null);
    this.emit('tool');
  }
  setBrush(b: BrushType) { this.brush = b; if (this.tool !== 'sculpt') this.setTool('sculpt'); this.emit('tool'); this.persistPrefs(); }
  updateSettings(patch: Partial<BrushSettings>) {
    const s = { ...this.settings, ...patch };
    s.radius = clamp(s.radius, 0.0005, 500); s.strength = clamp(s.strength, 0, 1); s.spacing = clamp(s.spacing, 0.02, 1);
    this.brushSettings[this.brush] = s;
    this.emit('brush');
    this.persistPrefs();
  }
  setSymmetry(patch: Partial<SymmetrySettings>) { this.symmetry = { ...this.symmetry, ...patch }; this.emit('brush'); this.persistPrefs(); }
  setTransformMode(m: TransformMode) { this.transformMode = m; this.viewport.transform.setMode(m); this.emit('tool'); }
  setViewMode(m: ViewMode) { this.viewport.setViewMode(m); this.emit('display'); }

  select(id: string | null) { this.model.select(id); this.syncTransformAttachment(); }

  private syncTransformAttachment() {
    const tc = this.viewport.transform;
    const sel = this.selected;
    if (this.tool === 'transform' && sel && !sel.locked && sel.visible) { tc.attach(sel.mesh); tc.setMode(this.transformMode); } else tc.detach();
    this.viewport.requestRender();
  }

  // ───────────────────────────── objects ─────────────────────────────

  private addObjectCommand(obj: SceneObject, label: string) {
    const index = this.model.objects.length;
    this.model.add(obj, index);
    this.history.push({
      label, bytes: obj.editable.vertexCount * 40,
      undo: () => { this.model.remove(obj.id); this.syncTransformAttachment(); },
      redo: () => { this.model.add(obj, index); },
    });
    this.select(obj.id);
    this.viewport.updateGround();
  }

  addPrimitive(kind: PrimitiveKind, detail = 2) {
    const names: Record<PrimitiveKind, string> = { sphere: 'Clay Sphere', uvsphere: 'UV Sphere', cube: 'Cube', cylinder: 'Cylinder', torus: 'Torus', plane: 'Plane' };
    const obj = this.model.create(makePrimitive(kind, detail), { name: this.uniqueName(names[kind]), provenance: { source: 'primitive', detail: kind, createdAt: new Date().toISOString() } });
    this.addObjectCommand(obj, `Add ${names[kind]}`);
    if (this.model.objects.length === 1) this.viewport.frame(obj);
    return obj;
  }

  uniqueName(base: string) {
    const names = new Set(this.model.objects.map((o) => o.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  deleteObject(id: string) {
    const r = this.model.remove(id);
    if (!r) return;
    this.syncTransformAttachment();
    this.history.push({ label: `Delete ${r.obj.name}`, bytes: 64, undo: () => this.model.add(r.obj, r.index), redo: () => { this.model.remove(id); this.syncTransformAttachment(); } });
  }

  duplicateObject(id: string) {
    const o = this.model.get(id);
    if (!o) return;
    const snap = o.editable.snapshot();
    const mat = Array.isArray(o.baseMaterial) ? o.baseMaterial.map((m) => m.clone()) : o.baseMaterial.clone();
    const copy = this.model.create(geometryFromSnapshot(snap), { name: this.uniqueName(`${o.name} copy`), material: mat, materialParams: { ...o.materialParams }, provenance: { ...o.provenance, detail: `duplicate of ${o.name}` } });
    copy.mesh.position.copy(o.mesh.position).add(new THREE.Vector3(0.15, 0, 0));
    copy.mesh.quaternion.copy(o.mesh.quaternion); copy.mesh.scale.copy(o.mesh.scale);
    this.addObjectCommand(copy, `Duplicate ${o.name}`);
  }

  renameObject(id: string, name: string) {
    const o = this.model.get(id);
    const clean = name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);
    if (!o || !clean || clean === o.name) return;
    const before = o.name;
    this.model.rename(id, clean);
    this.history.push({ label: 'Rename', bytes: 64, undo: () => this.model.rename(id, before), redo: () => this.model.rename(id, clean) });
  }

  setVisible(id: string, v: boolean) { this.model.setVisible(id, v); this.viewport.syncOverlays(); this.syncTransformAttachment(); this.markDirty(); }
  setLocked(id: string, v: boolean) { this.model.setLocked(id, v); this.syncTransformAttachment(); this.markDirty(); }

  setMaterialColor(id: string, color: string) {
    const o = this.model.get(id);
    if (!o) return;
    const before = { ...o.materialParams }, prevMat = o.baseMaterial;
    const apply = (params: typeof before, mat: THREE.Material | THREE.Material[]) => { o.materialParams = params; o.baseMaterial = mat; this.viewport.applyMaterials(); this.emit('scene'); };
    const mat = makeClayMaterial(color);
    const after = { kind: 'clay' as const, color, roughness: 0.62, metalness: 0 };
    apply(after, mat);
    this.history.push({ label: 'Material', bytes: 64, undo: () => apply(before, prevMat), redo: () => apply(after, mat) });
  }

  // ───────────────────────────── transforms ─────────────────────────────

  private transformBefore: { id: string; m: THREE.Matrix4 } | null = null;
  beginTransform() { const o = this.selected; if (o) this.transformBefore = { id: o.id, m: o.mesh.matrix.clone() }; }
  commitTransform() {
    const tb = this.transformBefore; this.transformBefore = null;
    const o = tb && this.model.get(tb.id);
    if (!tb || !o) return;
    o.mesh.updateMatrix();
    const after = o.mesh.matrix.clone();
    if (after.equals(tb.m)) return;
    this.pushTransform(o, tb.m, after);
    this.viewport.updateGround();
  }
  private pushTransform(o: SceneObject, before: THREE.Matrix4, after: THREE.Matrix4) {
    const set = (m: THREE.Matrix4) => { m.decompose(o.mesh.position, o.mesh.quaternion, o.mesh.scale); o.mesh.updateMatrixWorld(true); this.viewport.requestRender(); this.emit('transform'); };
    this.history.push({ label: `Transform ${o.name}`, bytes: 160, undo: () => set(before), redo: () => set(after) });
  }
  /** Numeric transform entry (position in scene units, rotation in degrees, scale factor). */
  setTransformNumeric(id: string, part: 'position' | 'rotation' | 'scale', axis: 0 | 1 | 2, value: number) {
    const o = this.model.get(id);
    if (!o || !Number.isFinite(value)) return;
    const before = o.mesh.matrix.clone();
    if (part === 'position') o.mesh.position.setComponent(axis, clamp(value, -1e5, 1e5));
    if (part === 'rotation') { const e = o.mesh.rotation.toArray() as number[]; e[axis] = THREE.MathUtils.degToRad(value); o.mesh.rotation.set(e[0], e[1], e[2]); }
    if (part === 'scale') o.mesh.scale.setComponent(axis, clamp(Math.abs(value) < 1e-4 ? 1e-4 : value, -1e4, 1e4));
    o.mesh.updateMatrix(); o.mesh.updateMatrixWorld(true);
    this.pushTransform(o, before, o.mesh.matrix.clone());
    this.viewport.updateGround();
    this.viewport.requestRender();
  }
  resetTransform(id: string) {
    const o = this.model.get(id);
    if (!o) return;
    const before = o.mesh.matrix.clone();
    o.mesh.position.set(0, 0, 0); o.mesh.quaternion.identity(); o.mesh.scale.set(1, 1, 1); o.mesh.updateMatrix();
    this.pushTransform(o, before, o.mesh.matrix.clone());
    this.viewport.requestRender();
  }

  // ───────────────────────────── sculpting ─────────────────────────────

  /** Average uniform scale of an object (radius conversion world → local). */
  localScale(o: SceneObject) {
    o.mesh.updateMatrixWorld();
    return Math.cbrt(Math.abs(o.mesh.matrixWorld.determinant())) || 1;
  }

  private strokeObj: SceneObject | null = null;
  private strokeLast: THREE.Vector3 | null = null;
  private strokeCarry = 0;
  private strokeStart = 0;
  private grabPlane = new THREE.Plane();
  private grabStartWorld = new THREE.Vector3();
  private grabStartLocal = new THREE.Vector3();
  private samples: THREE.Vector3[] = [];

  beginStroke(obj: SceneObject, worldPoint: THREE.Vector3, pressure: number): boolean {
    if (obj.locked || !obj.visible) return false;
    const s = this.settings;
    const localRadius = s.radius / this.localScale(obj);
    this.stroke = new SculptStroke(obj.editable, this.brush, s, localRadius, this.symmetry);
    this.strokeObj = obj;
    this.strokeStart = performance.now();
    this.viewport.setInteracting(true);
    const local = obj.mesh.worldToLocal(worldPoint.clone());
    if (this.brush === 'grab') {
      this.grabStartWorld.copy(worldPoint);
      this.grabStartLocal.copy(local);
      this.grabPlane.setFromNormalAndCoplanarPoint(this.viewport.camera.getWorldDirection(new THREE.Vector3()).negate(), worldPoint);
      this.stroke.beginGrab(local);
    } else {
      this.timeDab(() => this.stroke!.dab(local, pressure));
      this.strokeLast = local;
      this.strokeCarry = 0;
    }
    this.viewport.requestRender();
    return true;
  }

  /** Feed one pointer sample. Returns the world hit used for the cursor, if any. */
  strokeSample(clientX: number, clientY: number, pressure: number): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const st = this.stroke, obj = this.strokeObj;
    if (!st || !obj) return null;
    if (this.brush === 'grab') {
      const ray = this.viewport.rayAt(clientX, clientY);
      const hit = ray.intersectPlane(this.grabPlane, new THREE.Vector3());
      if (!hit) return null;
      const localNow = obj.mesh.worldToLocal(hit.clone());
      this.timeDab(() => st.updateGrab(localNow.sub(this.grabStartLocal)));
      this.viewport.requestRender();
      return null;
    }
    const ray = new THREE.Raycaster();
    ray.ray.copy(this.viewport.rayAt(clientX, clientY));
    (ray as any).firstHitOnly = true;
    const hits = ray.intersectObject(obj.mesh, false);
    if (!hits.length) { this.strokeLast = null; return null; }
    const local = obj.mesh.worldToLocal(hits[0].point.clone());
    if (!this.strokeLast) { this.timeDab(() => st.dab(local, pressure)); this.strokeLast = local; this.strokeCarry = 0; }
    else {
      const spacing = Math.max(1e-5, st.localRadius * this.settings.spacing);
      this.strokeCarry = resample(this.strokeLast, local, spacing, this.strokeCarry, this.samples);
      const bvh = obj.editable.bvh;
      const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 } as any;
      this.timeDab(() => {
        for (const p of this.samples) {
          // re-project interpolated points onto the surface so long jumps follow the form
          bvh.closestPointToPoint(p, target);
          st.dab(target.point, pressure, true);
        }
        st.flush();
      });
      this.strokeLast = local;
    }
    this.viewport.requestRender();
    const n = hits[0].face ? hits[0].face.normal.clone().transformDirection(obj.mesh.matrixWorld) : new THREE.Vector3(0, 1, 0);
    return { point: hits[0].point, normal: n };
  }

  private timeDab(fn: () => void) {
    const t = performance.now();
    fn();
    const dt = performance.now() - t;
    this.perf.geometryMs.push(dt);
    if (this.perf.geometryMs.length > 240) this.perf.geometryMs.shift();
  }

  endStroke() {
    const st = this.stroke, obj = this.strokeObj;
    this.stroke = null; this.strokeObj = null; this.strokeLast = null;
    this.viewport.setInteracting(false);
    if (!st || !obj) return;
    const patch = st.commit();
    this.lastStrokeStats = { ms: performance.now() - this.strokeStart, dabs: st.dabCount, verts: st.touchedCount };
    if (patch) this.pushPatch(obj, patch, `Sculpt: ${this.brush}`);
    this.viewport.requestRender();
    this.emit('stroke');
  }

  cancelStroke() {
    const st = this.stroke;
    this.stroke = null; this.strokeObj = null; this.strokeLast = null;
    this.viewport.setInteracting(false);
    st?.cancel();
    this.viewport.requestRender();
  }

  private pushPatch(obj: SceneObject, patch: VertexPatch, label: string) {
    const safe = (side: 'before' | 'after') => () => {
      try { applyPatch(obj.editable, patch, side); } catch (e) { this.toast('error', `Cannot ${side === 'before' ? 'undo' : 'redo'} ${label}: ${(e as Error).message}`); }
      this.viewport.requestRender();
    };
    this.history.push({ label, bytes: patch.canonical.length * 36, undo: safe('before'), redo: safe('after') });
  }

  /** Clear or invert the whole mask of the selected object (undoable). */
  maskAll(op: 'clear' | 'invert' | 'fill') {
    const o = this.selected;
    if (!o) return;
    const m = o.editable;
    const ids: number[] = [];
    for (let i = 0; i < m.vertexCount; i++) if (m.weldOf[i] === i) ids.push(i);
    const before = new Float32Array(ids.length), after = new Float32Array(ids.length);
    const pos = new Float32Array(ids.length * 3);
    ids.forEach((c, j) => { before[j] = m.mask[c]; after[j] = op === 'clear' ? 0 : op === 'fill' ? 1 : 1 - m.mask[c]; pos.set(m.positions.subarray(c * 3, c * 3 + 3), j * 3); });
    const patch: VertexPatch = { kind: 'vertex-patch', topologyVersion: m.topologyVersion, canonical: Int32Array.from(ids), before: pos, after: pos, maskBefore: before, maskAfter: after };
    applyPatch(m, patch, 'after');
    this.pushPatch(o, patch, `Mask ${op}`);
  }

  // ───────────────────────────── topology ─────────────────────────────

  private pushTopology(o: SceneObject, before: GeometrySnapshot, label: string) {
    const after = o.editable.snapshot();
    const set = (s: GeometrySnapshot) => { o.editable.replaceGeometry(geometryFromSnapshot(s), s.topologyVersion); this.viewport.syncOverlays(); this.viewport.requestRender(); this.emit('scene'); };
    const bytes = (s: GeometrySnapshot) => Object.values(s.attributes).reduce((a, x) => a + x.array.byteLength, 0) + s.index.byteLength;
    this.history.push({ label, bytes: bytes(before) + bytes(after), undo: () => set(before), redo: () => set(after) });
    this.emit('scene');
  }

  subdivide() {
    const o = this.selected;
    if (!o) return this.toast('warn', 'Select a mesh to subdivide.');
    if (o.editable.triangleCount * 4 > 2_000_000) return this.toast('warn', `Subdividing would create ${(o.editable.triangleCount * 4).toLocaleString()} triangles — above the 2M interactive limit.`);
    const before = o.editable.snapshot();
    o.editable.replaceGeometry(subdivideMidpoint(o.editable.geometry));
    this.pushTopology(o, before, 'Subdivide');
    this.viewport.syncOverlays();
    if (o.editable.geometry.attributes.uv) this.toast('info', 'Subdivided. UVs were interpolated linearly; textures stay aligned but seams are unchanged.');
  }

  async decimate(ratio: number) {
    const o = this.selected;
    if (!o) return this.toast('warn', 'Select a mesh to decimate.');
    const before = o.editable.snapshot();
    const t0 = o.editable.triangleCount;
    try {
      const g = await decimate(o.editable.geometry, ratio);
      o.editable.replaceGeometry(g);
    } catch (e) { return this.toast('error', `Decimation failed: ${(e as Error).message}`); }
    this.pushTopology(o, before, 'Decimate');
    this.viewport.syncOverlays();
    this.toast('ok', `Decimated ${t0.toLocaleString()} → ${o.editable.triangleCount.toLocaleString()} triangles. Mask was cleared.`);
  }

  repair(op: 'debris' | 'flip' | 'recenter') {
    const o = this.selected;
    if (!o) return;
    const before = o.editable.snapshot();
    if (op === 'debris') {
      const r = removeDebris(o.editable.geometry);
      if (!r.removedShells) return this.toast('info', 'No small disconnected shells found.');
      o.editable.replaceGeometry(r.geometry);
      this.toast('ok', `Removed ${r.removedShells} small disconnected shell(s).`);
    } else if (op === 'flip') {
      const g = geometryFromSnapshot(before); flipWinding(g); o.editable.replaceGeometry(g);
    } else {
      // move geometry so its bounds centre sits at the local origin and bottom touches y=0... keep world placement
      const g = geometryFromSnapshot(before); g.computeBoundingBox();
      const c = g.boundingBox!.getCenter(new THREE.Vector3());
      g.translate(-c.x, -c.y, -c.z);
      o.editable.replaceGeometry(g);
    }
    this.pushTopology(o, before, `Repair: ${op}`);
    this.viewport.syncOverlays();
  }

  // ───────────────────────────── undo/redo ─────────────────────────────

  undo() { if (this.stroke) return; const c = this.history.undo(); if (c) this.toast('info', `Undo: ${c.label}`, undefined, 1600); this.viewport.requestRender(); }
  redo() { if (this.stroke) return; const c = this.history.redo(); if (c) this.toast('info', `Redo: ${c.label}`, undefined, 1600); this.viewport.requestRender(); }

  // ───────────────────────────── import / export ─────────────────────────────

  async importFiles(files: File[], provenance?: Partial<Provenance>): Promise<SceneObject[]> {
    let res: ImportResult;
    try {
      res = await importModelFiles(files);
    } catch (e) {
      const err = e as ImportError;
      this.toast('error', err.message, err.remedies);
      return [];
    }
    return this.addImported(res, provenance);
  }

  addImported(res: ImportResult, provenance?: Partial<Provenance>, groupLabel = `Import ${res.fileName}`): SceneObject[] {
    const added: SceneObject[] = [];
    for (const m of res.meshes) {
      const obj = this.model.create(m.geometry, {
        name: this.uniqueName(m.name), material: m.material, materialParams: m.materialParams,
        provenance: { source: 'import', detail: `${res.fileName} (${res.format.toUpperCase()})`, createdAt: new Date().toISOString(), ...provenance },
      });
      obj.mesh.position.copy(m.position); obj.mesh.quaternion.copy(m.quaternion); obj.mesh.scale.copy(m.scale);
      added.push(obj);
    }
    const indices = added.map((_, i) => this.model.objects.length + i);
    added.forEach((o, i) => this.model.add(o, indices[i]));
    this.history.push({
      label: groupLabel, bytes: added.reduce((s, o) => s + o.editable.vertexCount * 40, 0),
      undo: () => { for (const o of added) this.model.remove(o.id); this.syncTransformAttachment(); },
      redo: () => added.forEach((o, i) => this.model.add(o, indices[i])),
    });
    this.select(added[0]?.id ?? null);
    this.viewport.syncOverlays();
    this.viewport.frame(added.length === 1 ? added[0] : null);
    if (added[0]) this.fitBrushesTo(added[0]);
    const tris = res.meshes.reduce((s, m) => s + m.report.triangles, 0);
    const issues = res.meshes.flatMap((m) => m.report.issues.map((i) => `${m.name}: ${i}`));
    this.toast(issues.length || res.warnings.length ? 'warn' : 'ok', `Imported ${res.meshes.length} mesh(es), ${tris.toLocaleString()} triangles from ${res.fileName}.`, [...res.warnings, ...issues].slice(0, 8), 7000);
    return added;
  }

  /**
   * Brush radii are world-space. When a model arrives at a very different scale than the current
   * radius suits, rescale every brush radius so the default brush covers ~12% of the object.
   */
  fitBrushesTo(o: SceneObject) {
    const size = new THREE.Box3().setFromObject(o.mesh).getSize(new THREE.Vector3()).length();
    if (!(size > 0)) return;
    const ratio = this.settings.radius / size;
    if (ratio > 0.04 && ratio < 0.4) return;
    const k = (size * 0.12) / this.settings.radius;
    for (const b of Object.keys(this.brushSettings) as BrushType[]) this.brushSettings[b] = { ...this.brushSettings[b], radius: clamp(this.brushSettings[b].radius * k, 0.0005, 500) };
    this.toast('info', `Brush radius adapted to the model size (${this.settings.radius.toPrecision(3)} ${this.units}).`, undefined, 3000);
    this.emit('brush');
  }

  exportTargets(scope: 'selected' | 'visible') {
    return scope === 'selected' ? (this.selected ? [this.selected] : []) : this.model.objects.filter((o) => o.visible);
  }

  async exportModel(scope: 'selected' | 'visible', opts: ExportOptions) {
    const objs = this.exportTargets(scope);
    if (!objs.length) { this.toast('warn', 'Nothing to export.'); return null; }
    const res = await exportObjects(objs, opts);
    const name = safeFileName(scope === 'selected' ? objs[0].name : this.projectName, res.extension);
    const hash = (await sha256(res.data)).slice(0, 16);
    const ok = downloadBlob(res.data, res.mime, name);
    const size = typeof res.data === 'string' ? res.data.length : res.data.byteLength;
    if (ok) this.toast(res.warnings.length ? 'warn' : 'ok', `Exported ${name} (${fmtBytes(size)}, sha256 ${hash}…)`, res.warnings, 8000);
    else this.toast('error', 'This embedded preview cannot save files to your device.', [`Open the standalone app to export: ${STANDALONE_URL}`]);
    (window as any).__lastExport = { name, hash, size, data: res.data };
    return { ...res, name, hash };
  }

  // ───────────────────────────── project ─────────────────────────────

  projectState() {
    const cam = this.viewport.camera, t = this.viewport.controls.target;
    return {
      id: this.projectId, name: this.projectName, units: this.units, objects: this.model.objects,
      camera: { position: cam.position.toArray(), target: t.toArray(), ortho: this.viewport.isOrtho },
      settings: { viewMode: this.viewport.viewMode, symmetry: this.symmetry, brush: this.brush },
      references: this.references.map((r) => ({ ...r.record, position: r.mesh.position.toArray(), quaternion: r.mesh.quaternion.toArray(), scale: r.mesh.scale.toArray(), visible: r.mesh.visible })),
      jobs: this.jobs,
    };
  }

  async saveProjectFile() {
    const zip = await writeProject(this.projectState());
    const ok = downloadBlob(zip as Uint8Array<ArrayBuffer>, 'application/zip', safeFileName(this.projectName, 'formengine'));
    if (ok) this.toast('ok', `Project file saved (${fmtBytes(zip.byteLength)}). Keep it as a backup — browser storage can be cleared.`);
    else this.toast('error', 'This embedded preview cannot save files to your device.', [`Open the standalone app to save projects: ${STANDALONE_URL}`]);
    await this.autosaveNow();
  }

  async openProjectFile(file: File) {
    try {
      await this.loadProjectBytes(new Uint8Array(await file.arrayBuffer()), { newId: false });
      this.toast('ok', `Opened ${file.name}`);
    } catch (e) {
      this.toast('error', `Could not open ${file.name}: ${(e as Error).message}`, ['Your current work was not changed.']);
    }
  }

  /** Replace the current project. Parses fully before touching the scene, so failures change nothing. */
  async loadProjectBytes(bytes: Uint8Array, opts: { newId: boolean }) {
    const p = await readProject(bytes);
    if (this.dirty) await this.autosaveNow();
    this.cancelStroke();
    this.clearReferences();
    this.model.clear();
    this.history.clear();
    this.projectId = opts.newId ? newId('proj') : p.manifest.id;
    this.projectName = p.manifest.name;
    this.units = p.manifest.units;
    this.jobs = p.manifest.jobs ?? [];
    for (const o of p.objects) {
      const obj = this.model.create(o.geometry, { id: o.id, name: o.name, material: o.material, materialParams: o.materialParams, provenance: o.provenance });
      obj.mesh.position.copy(o.position); obj.mesh.quaternion.copy(o.quaternion); obj.mesh.scale.copy(o.scale);
      obj.visible = o.visible; obj.mesh.visible = o.visible; obj.locked = o.locked;
      this.model.add(obj);
    }
    for (const r of p.references) if (r.blob) await this.addReference(r.blob, r, false);
    const s = p.manifest.settings as any;
    if (s?.viewMode) this.viewport.setViewMode(s.viewMode);
    if (s?.symmetry) this.symmetry = s.symmetry;
    this.viewport.syncOverlays();
    if (p.manifest.camera) {
      this.viewport.setOrthographic(!!p.manifest.camera.ortho);
      this.viewport.camera.position.fromArray(p.manifest.camera.position);
      this.viewport.controls.target.fromArray(p.manifest.camera.target);
      this.viewport.controls.update();
    } else this.viewport.frame();
    this.viewport.updateGround();
    this.select(this.model.objects[0]?.id ?? null);
    this.dirty = false;
    this.generation = Date.now();
    this.emit('project');
  }

  newProject(starter = true) {
    if (this.dirty) void this.autosaveNow();
    this.cancelStroke();
    this.clearReferences();
    this.model.clear();
    this.history.clear();
    this.projectId = newId('proj');
    this.projectName = 'Untitled sculpture';
    this.jobs = [];
    if (starter) { this.addPrimitive('sphere', 3); this.history.clear(); }
    this.viewport.frame();
    this.dirty = false;
    this.emit('project');
  }

  // ───────────────────────────── autosave ─────────────────────────────

  markDirty() {
    this.dirty = true;
    if (this.saveState !== 'unavailable') this.saveState = 'pending';
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.autosaveNow(), 2500);
    this.emit('save');
  }

  async autosaveNow(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (!this.storageOk || !store.storageAvailable()) { this.saveState = 'unavailable'; this.emit('save'); return; }
    if (this.stroke) { this.saveTimer = window.setTimeout(() => this.autosaveNow(), 800); return; } // never block an active stroke
    if (!this.model.objects.length && !this.dirty) return;
    this.saveState = 'saving'; this.emit('save');
    const gen = Math.max(++this.generation, Date.now());
    this.generation = gen;
    try {
      const zip = await writeProject(this.projectState());
      const r = await store.saveProject(this.projectId, this.projectName, zip, gen, this.thumbnail());
      await store.kvSet('lastProjectId', this.projectId);
      if (r === 'saved') { this.dirty = false; this.lastSavedAt = new Date().toISOString(); }
      this.saveState = 'saved';
    } catch (e) {
      this.saveState = 'error';
      console.error('autosave failed', e);
      this.toast('error', `Autosave failed: ${(e as Error).message}`, ['Save a project file to keep a backup.']);
    }
    this.emit('save');
  }

  thumbnail(): string | undefined {
    try {
      this.viewport.renderNow();
      const src = this.viewport.renderer.domElement;
      const c = document.createElement('canvas');
      c.width = 192; c.height = 120;
      const ctx = c.getContext('2d')!;
      const s = Math.max(c.width / src.width, c.height / src.height);
      ctx.drawImage(src, (c.width - src.width * s) / 2, (c.height - src.height * s) / 2, src.width * s, src.height * s);
      return c.toDataURL('image/jpeg', 0.7);
    } catch { return undefined; }
  }

  async restoreLast(): Promise<boolean> {
    if (!this.storageOk || !store.storageAvailable()) return false;
    try {
      const id = await store.kvGet<string>('lastProjectId');
      if (!id) return false;
      const r = await store.loadProject(id);
      if (!r) return false;
      await this.loadProjectBytes(r.data, { newId: false });
      this.toast(r.recoveredFromOlder ? 'warn' : 'info', r.recoveredFromOlder ? 'Latest autosave was damaged; restored the previous valid autosave.' : 'Restored your last autosaved session.');
      return true;
    } catch (e) {
      this.toast('error', `Could not restore autosave: ${(e as Error).message}`);
      return false;
    }
  }

  async openStored(id: string) {
    const r = await store.loadProject(id);
    if (!r) return this.toast('error', 'That stored project could not be read (both slots failed verification).');
    await this.loadProjectBytes(r.data, { newId: false });
    await store.kvSet('lastProjectId', id);
  }

  private prefsTimer = 0;
  persistPrefs() {
    clearTimeout(this.prefsTimer);
    this.prefsTimer = window.setTimeout(() => {
      if (this.storageOk && store.storageAvailable()) store.kvSet('prefs', { brush: this.brush, brushSettings: this.brushSettings, symmetry: this.symmetry, penOnlySculpt: this.penOnlySculpt }).catch(() => {});
    }, 500);
  }
  async loadPrefs() {
    try {
      const p = await store.kvGet<any>('prefs');
      if (!p) return;
      if (p.brushSettings) for (const k of Object.keys(this.brushSettings) as BrushType[]) if (p.brushSettings[k]) this.brushSettings[k] = { ...this.brushSettings[k], ...p.brushSettings[k] };
      if (p.brush) this.brush = p.brush;
      if (p.symmetry) this.symmetry = p.symmetry;
      this.penOnlySculpt = !!p.penOnlySculpt;
    } catch { /* prefs are optional */ }
  }

  // ───────────────────────────── reference images ─────────────────────────────

  async addReference(blob: Blob, rec?: Partial<ReferenceImageRecord>, undoable = true) {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const tex = new THREE.Texture(bmp as any);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const aspect = bmp.width / bmp.height;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(aspect, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: rec?.opacity ?? 0.5, depthWrite: false, side: THREE.DoubleSide }));
    mesh.raycast = () => {};
    mesh.renderOrder = -0.5;
    const view = rec?.view ?? 'front';
    const record: ReferenceImageRecord = {
      id: rec?.id ?? newId('ref'), name: rec?.name ?? 'Reference', view, mime: blob.type || 'image/png', opacity: rec?.opacity ?? 0.5, visible: rec?.visible ?? true,
      position: rec?.position ?? [], quaternion: rec?.quaternion ?? [], scale: rec?.scale ?? [], blob,
    };
    if (rec?.position?.length) {
      mesh.position.fromArray(rec.position); mesh.quaternion.fromArray(rec.quaternion!); mesh.scale.fromArray(rec.scale!);
    } else this.placeReferenceForView(mesh, view);
    mesh.visible = record.visible;
    const ref = { record, mesh, texture: tex };
    this.references.push(ref);
    this.viewport.references.add(mesh);
    this.viewport.requestRender();
    if (undoable) {
      this.history.push({ label: 'Add reference image', bytes: blob.size, undo: () => this.removeReference(record.id, false), redo: () => { this.references.push(ref); this.viewport.references.add(mesh); this.viewport.requestRender(); this.emit('references'); } });
    }
    this.emit('references');
    return ref;
  }

  /** Put a reference plane behind the scene, facing the matching canonical view. */
  placeReferenceForView(mesh: THREE.Mesh, view: string) {
    const box = new THREE.Box3().setFromObject(this.model.root);
    const size = box.isEmpty() ? 1 : Math.max(...box.getSize(new THREE.Vector3()).toArray());
    const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const d = size * 0.9;
    mesh.scale.setScalar(size * 1.1);
    const place: Record<string, [THREE.Vector3, THREE.Euler]> = {
      front: [new THREE.Vector3(0, 0, -d), new THREE.Euler(0, 0, 0)],
      back: [new THREE.Vector3(0, 0, d), new THREE.Euler(0, Math.PI, 0)],
      right: [new THREE.Vector3(-d, 0, 0), new THREE.Euler(0, Math.PI / 2, 0)],
      left: [new THREE.Vector3(d, 0, 0), new THREE.Euler(0, -Math.PI / 2, 0)],
      top: [new THREE.Vector3(0, -d, 0), new THREE.Euler(-Math.PI / 2, 0, 0)],
    };
    const [p, r] = place[view] ?? place.front;
    mesh.position.copy(c).add(p);
    mesh.rotation.copy(r);
  }

  updateReference(id: string, patch: { opacity?: number; visible?: boolean; view?: string }) {
    const r = this.references.find((x) => x.record.id === id);
    if (!r) return;
    if (patch.opacity !== undefined) { r.record.opacity = clamp(patch.opacity, 0.05, 1); (r.mesh.material as THREE.MeshBasicMaterial).opacity = r.record.opacity; }
    if (patch.visible !== undefined) { r.record.visible = patch.visible; r.mesh.visible = patch.visible; }
    if (patch.view) { r.record.view = patch.view; this.placeReferenceForView(r.mesh, patch.view); }
    this.viewport.requestRender();
    this.markDirty();
    this.emit('references');
  }

  removeReference(id: string, undoable = true) {
    const i = this.references.findIndex((x) => x.record.id === id);
    if (i < 0) return;
    const [r] = this.references.splice(i, 1);
    this.viewport.references.remove(r.mesh);
    if (undoable) this.history.push({ label: 'Remove reference', bytes: 64, undo: () => { this.references.splice(i, 0, r); this.viewport.references.add(r.mesh); this.emit('references'); }, redo: () => this.removeReference(id, false) });
    this.viewport.requestRender();
    this.emit('references');
  }

  clearReferences() {
    for (const r of this.references) { this.viewport.references.remove(r.mesh); r.texture.dispose(); (r.mesh.material as THREE.Material).dispose(); r.mesh.geometry.dispose(); }
    this.references = [];
    this.emit('references');
  }

  /** Adopt a generated mesh (provider output or relief) as editable objects — a new version, never an overwrite. */
  async adoptGenerated(data: ArrayBuffer, fileName: string, provenance: Partial<Provenance>, opts: { normalize: boolean }) {
    const res = await parseModel(data, fileName);
    if (opts.normalize) normalizeImported(res);
    return this.addImported(res, provenance, `Adopt ${provenance.source === 'reconstruction' ? 'reconstruction' : 'generated'} ${fileName}`);
  }

  addGeometryObject(geometry: THREE.BufferGeometry, name: string, provenance: Provenance) {
    const obj = this.model.create(geometry, { name: this.uniqueName(name), provenance, material: makeClayMaterial(CLAY_COLOR) });
    this.addObjectCommand(obj, `Add ${name}`);
    this.viewport.syncOverlays();
    this.viewport.frame(obj);
    return obj;
  }

  meshReport(o: SceneObject) { return analyzeGeometry(o.editable.geometry); }

  dispose() {
    clearTimeout(this.saveTimer);
    this.viewport.dispose();
    this.listeners.clear();
  }
}

/** Scale/centre imported generated meshes to ~1 unit tall sitting on y = -0.5 (the default grid). */
export function normalizeImported(res: ImportResult) {
  const box = new THREE.Box3();
  for (const m of res.meshes) {
    const g = m.geometry.clone(); g.applyMatrix4(new THREE.Matrix4().compose(m.position, m.quaternion, m.scale));
    g.computeBoundingBox(); box.union(g.boundingBox!);
  }
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const s = 1 / Math.max(size.x, size.y, size.z, 1e-6);
  const c = box.getCenter(new THREE.Vector3());
  for (const m of res.meshes) {
    m.position.sub(c).multiplyScalar(s);
    m.scale.multiplyScalar(s);
  }
}

export function clamp(v: number, a: number, b: number) { return Math.min(b, Math.max(a, v)); }
export function fmtBytes(n: number) { return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`; }

export type { Command };
export { mirrorSigns };
