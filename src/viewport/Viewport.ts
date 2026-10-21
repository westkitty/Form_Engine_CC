import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { MaterialLibrary, type ViewMode } from './materials';
import type { SceneModel, SceneObject } from '../scene/SceneModel';

// BVH-accelerated raycasting for every mesh.
THREE.Mesh.prototype.raycast = acceleratedRaycast;
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;

export interface FrameStats { fps: number; p50: number; p95: number; renderP50: number; drawCalls: number; triangles: number; samples: number }

/**
 * Owns the WebGL renderer, cameras, controls, lights and overlays. Renders on demand: `requestRender()`
 * marks the frame dirty; the RAF loop only draws when something changed or an animation is running.
 */
export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly persp: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  readonly transform: TransformControls;
  viewHelper: ViewHelper;
  readonly materials = new MaterialLibrary();
  readonly cursor: THREE.Group;
  readonly cursorMirrors: THREE.Group[] = [];
  readonly overlays = new THREE.Group();
  readonly references = new THREE.Group();
  readonly grid: THREE.GridHelper;
  readonly lightRig = new THREE.Group();
  readonly ground: THREE.Mesh;
  viewMode: ViewMode = 'studio';
  wireframe = false;
  turntable = false;
  /** Lowered during strokes (DPR cap) and restored on idle. */
  interacting = false;
  maxDpr: number;
  contextLost = false;
  onContextChange: (lost: boolean) => void = () => {};
  onAfterRender: () => void = () => {};

  private dirty = true;
  private raf = 0;
  private timer = new THREE.Timer();
  private frameTimes: number[] = [];
  private lastFrame = 0;
  private renderMs: number[] = [];
  private resizeObs: ResizeObserver;
  private disposers: (() => void)[] = [];
  private overlayByObject = new Map<string, { wire: THREE.Mesh; mask: THREE.Mesh }>();

  constructor(readonly container: HTMLElement, readonly model: SceneModel) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer = renderer;
    const mobile = matchMedia('(pointer: coarse)').matches;
    this.maxDpr = mobile ? 1.5 : 2;
    renderer.setPixelRatio(Math.min(devicePixelRatio, this.maxDpr));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'viewport-canvas';
    renderer.domElement.setAttribute('aria-label', '3D viewport');
    renderer.domElement.setAttribute('role', 'img');
    container.appendChild(renderer.domElement);

    this.scene.background = new THREE.Color(0x15171b);
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.22;
    pmrem.dispose();

    // Studio light rig: warm key, cool fill, rim.
    // Lights are parented to the camera so form reads consistently while orbiting (studio "camera rig").
    const key = new THREE.DirectionalLight(0xfff0dc, 2.4); key.position.set(-2.2, 2.6, 1.2);
    const fill = new THREE.DirectionalLight(0xb9c8ff, 0.35); fill.position.set(2.5, -0.5, 1.5);
    const rim = new THREE.DirectionalLight(0xffcf95, 1.6); rim.position.set(1.8, 1.5, -3);
    this.lightRig.add(key, fill, rim);
    this.scene.add(new THREE.HemisphereLight(0x8a93a6, 0x1c1a17, 0.18));

    this.persp = new THREE.PerspectiveCamera(38, 1, 0.01, 500);
    this.persp.position.set(1.6, 1.1, 2.2);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500);
    this.camera = this.persp;
    this.persp.add(this.lightRig);
    this.scene.add(this.persp);

    this.grid = new THREE.GridHelper(10, 40, 0x3a3f4a, 0x24272e);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.55;
    this.grid.position.y = -0.5;
    this.scene.add(this.grid);

    // Cheap contact shadow: radial gradient disc under the scene.
    const shadowTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d')!; const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
      gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    })();
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.renderOrder = -1;
    this.scene.add(this.ground);

    this.scene.add(model.root, this.overlays, this.references);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.update();

    this.transform = new TransformControls(this.camera, renderer.domElement);
    this.transform.addEventListener('change', () => this.requestRender());
    this.transform.addEventListener('dragging-changed', (e: any) => { this.controls.enabled = !e.value; });
    this.scene.add(this.transform.getHelper());

    this.viewHelper = new ViewHelper(this.camera, renderer.domElement);
    (this.viewHelper as any).center = this.controls.target;

    this.cursor = makeCursor(0xf0b46a);
    this.scene.add(this.cursor);
    for (let i = 0; i < 7; i++) { const m = makeCursor(0x7aa7ff); m.visible = false; this.cursorMirrors.push(m); this.scene.add(m); }

    const onLost = (e: Event) => { e.preventDefault(); this.contextLost = true; this.onContextChange(true); };
    const onRestored = () => { this.contextLost = false; this.onContextChange(false); this.requestRender(); };
    renderer.domElement.addEventListener('webglcontextlost', onLost);
    renderer.domElement.addEventListener('webglcontextrestored', onRestored);
    this.disposers.push(() => { renderer.domElement.removeEventListener('webglcontextlost', onLost); renderer.domElement.removeEventListener('webglcontextrestored', onRestored); });

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.disposers.push(model.onChange(() => { this.syncOverlays(); this.requestRender(); }));
    this.loop();
  }

  requestRender() { this.dirty = true; }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.interacting ? Math.min(this.maxDpr, 1.25) : this.maxDpr));
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.requestRender();
  }

  setInteracting(v: boolean) {
    if (this.interacting === v) return;
    this.interacting = v;
    // Lower pixel ratio during strokes on high-DPR devices to protect frame time; restore on idle.
    if (devicePixelRatio > 1.25) this.resize();
  }

  private updateOrthoFrustum() {
    const dist = this.persp.position.distanceTo(this.controls?.target ?? new THREE.Vector3());
    const h = Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)) * dist;
    const w = h * this.persp.aspect;
    this.ortho.left = -w; this.ortho.right = w; this.ortho.top = h; this.ortho.bottom = -h;
    this.ortho.updateProjectionMatrix();
  }

  setOrthographic(on: boolean) {
    const from = this.camera, to = on ? this.ortho : this.persp;
    if (from === to) return;
    if (on) { this.persp.position.copy(from.position); this.updateOrthoFrustum(); this.ortho.zoom = 1; }
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.updateProjectionMatrix();
    this.camera = to;
    to.add(this.lightRig);
    if (!to.parent) this.scene.add(to);
    this.controls.object = to;
    this.transform.camera = to;
    this.viewHelper.dispose?.();
    this.viewHelper = new ViewHelper(to, this.renderer.domElement);
    (this.viewHelper as any).center = this.controls.target;
    this.controls.update();
    this.requestRender();
  }

  get isOrtho() { return this.camera === this.ortho; }

  /** Canonical views: front (1), right (3), top (7), iso. */
  setView(view: 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom' | 'iso') {
    const t = this.controls.target;
    const d = this.camera.position.distanceTo(t);
    const dir = { front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 0.0001], bottom: [0, -1, 0.0001], iso: [1, 0.8, 1] }[view];
    const v = new THREE.Vector3(...(dir as [number, number, number])).normalize().multiplyScalar(d);
    this.camera.position.copy(t).add(v);
    this.camera.lookAt(t);
    this.controls.update();
    this.requestRender();
  }

  /** Frame an object (or the whole scene). */
  frame(obj?: SceneObject | null) {
    const box = new THREE.Box3();
    if (obj) box.setFromObject(obj.mesh); else box.setFromObject(this.model.root);
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.15;
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.persp.near = Math.max(dist / 1000, 0.001); this.persp.far = dist * 100; this.persp.updateProjectionMatrix();
    if (this.isOrtho) { this.persp.position.copy(this.camera.position); this.updateOrthoFrustum(); this.ortho.zoom = 1; this.ortho.updateProjectionMatrix(); }
    this.controls.update();
    this.updateGround();
    this.requestRender();
  }

  /** Place grid and contact shadow under the scene; scale grid to scene size. */
  updateGround() {
    const box = new THREE.Box3().setFromObject(this.model.root);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 0.2);
    this.grid.position.y = box.min.y - 0.002;
    const step = Math.pow(10, Math.floor(Math.log10(span * 4)));
    this.grid.scale.setScalar(step);
    this.ground.position.set((box.min.x + box.max.x) / 2, box.min.y - 0.001, (box.min.z + box.max.z) / 2);
    this.ground.scale.set(size.x * 1.6 + 0.1, size.z * 1.6 + 0.1, 1);
  }

  setViewMode(mode: ViewMode) { this.viewMode = mode; this.applyMaterials(); }
  setWireframe(on: boolean) { this.wireframe = on; this.syncOverlays(); this.requestRender(); }

  applyMaterials() {
    for (const o of this.model.objects) o.mesh.material = this.materials.forMode(this.viewMode, o.baseMaterial);
    this.requestRender();
  }

  /** Wireframe and mask overlays share each object's geometry (no copies). */
  syncOverlays() {
    const alive = new Set(this.model.objects.map((o) => o.id));
    for (const [id, ov] of this.overlayByObject) {
      if (!alive.has(id)) { this.overlays.remove(ov.wire, ov.mask); this.overlayByObject.delete(id); }
    }
    for (const o of this.model.objects) {
      let ov = this.overlayByObject.get(o.id);
      if (!ov || ov.wire.geometry !== o.editable.geometry) {
        if (ov) this.overlays.remove(ov.wire, ov.mask);
        ov = { wire: new THREE.Mesh(o.editable.geometry, this.materials.wire), mask: new THREE.Mesh(o.editable.geometry, this.materials.maskOverlay) };
        ov.wire.raycast = () => {}; ov.mask.raycast = () => {};
        ov.wire.matrixAutoUpdate = ov.mask.matrixAutoUpdate = false;
        this.overlays.add(ov.wire, ov.mask);
        this.overlayByObject.set(o.id, ov);
      }
      ov.wire.visible = this.wireframe && o.visible;
      ov.mask.visible = o.visible;
    }
    this.applyMaterials();
  }

  /** World-space ray hit against visible, unlocked sculptable objects. */
  pick(clientX: number, clientY: number, opts: { includeLocked?: boolean } = {}): { obj: SceneObject; hit: THREE.Intersection } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    (ray as any).firstHitOnly = true;
    let best: { obj: SceneObject; hit: THREE.Intersection } | null = null;
    for (const o of this.model.objects) {
      if (!o.visible || (!opts.includeLocked && o.locked)) continue;
      const hits = ray.intersectObject(o.mesh, false);
      if (hits.length && (!best || hits[0].distance < best.hit.distance)) best = { obj: o, hit: hits[0] };
    }
    return best;
  }

  rayAt(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray.ray;
  }

  /** World-space size of one CSS pixel at a given point (for screen-constant cursor details). */
  pixelWorldSize(at: THREE.Vector3) {
    const h = this.renderer.domElement.clientHeight || 1;
    if (this.isOrtho) return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / h;
    const d = this.camera.position.distanceTo(at);
    return (2 * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)) * d) / h;
  }

  placeCursor(point: THREE.Vector3 | null, normal?: THREE.Vector3, radius = 0.1, mirrors: THREE.Vector3[] = [], obj?: SceneObject) {
    const place = (g: THREE.Group, p: THREE.Vector3, n: THREE.Vector3) => {
      g.visible = true;
      g.position.copy(p);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      g.scale.setScalar(radius);
    };
    if (!point || !normal) { this.cursor.visible = false; for (const m of this.cursorMirrors) m.visible = false; this.requestRender(); return; }
    place(this.cursor, point, normal);
    // Mirror cursors computed in object-local space then mapped back to world.
    for (let i = 0; i < this.cursorMirrors.length; i++) {
      const m = this.cursorMirrors[i];
      const s = mirrors[i + 1];
      if (!s || !obj) { m.visible = false; continue; }
      const inv = obj.mesh.matrixWorld.clone().invert();
      const lp = point.clone().applyMatrix4(inv).multiply(s).applyMatrix4(obj.mesh.matrixWorld);
      const nm = new THREE.Matrix3().getNormalMatrix(obj.mesh.matrixWorld);
      const ln = normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(inv)).multiply(s).applyMatrix3(nm).normalize();
      place(m, lp, ln);
    }
    this.requestRender();
  }

  stats(): FrameStats {
    const ft = this.frameTimes.slice().sort((a, b) => a - b);
    const q = (p: number) => (ft.length ? ft[Math.min(ft.length - 1, Math.floor(ft.length * p))] : 0);
    const info = this.renderer.info.render;
    const rm = this.renderMs.slice().sort((a, b) => a - b);
    return { fps: ft.length ? 1000 / q(0.5) : 0, p50: q(0.5), p95: q(0.95), renderP50: rm.length ? rm[Math.floor(rm.length / 2)] : 0, drawCalls: info.calls, triangles: info.triangles, samples: ft.length };
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.timer.update(); const dt = this.timer.getDelta();
    if (this.contextLost) return;
    let animating = false;
    if (this.turntable) { this.model.root.rotation.y += dt * 0.5; animating = true; }
    if (this.viewHelper.animating) { this.viewHelper.update(dt); animating = true; }
    // Damping keeps moving for a few frames after input; controls.update() returns true while it does.
    if (this.controls.update()) animating = true;
    if (!this.dirty && !animating) { this.lastFrame = 0; return; }
    this.dirty = false;
    const now = performance.now();
    // Interval samples only between back-to-back rendered frames, so idle gaps don't count as slow frames.
    if (this.lastFrame) { this.frameTimes.push(now - this.lastFrame); if (this.frameTimes.length > 240) this.frameTimes.shift(); }
    this.lastFrame = now;
    // Overlays follow their object's world matrix.
    for (const o of this.model.objects) {
      const ov = this.overlayByObject.get(o.id);
      if (ov) { o.mesh.updateMatrixWorld(); ov.wire.matrix.copy(o.mesh.matrixWorld); ov.mask.matrix.copy(o.mesh.matrixWorld); ov.wire.matrixWorld.copy(o.mesh.matrixWorld); ov.mask.matrixWorld.copy(o.mesh.matrixWorld); }
    }
    this.renderer.autoClear = true;
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = false;
    this.viewHelper.render(this.renderer);
    this.renderMs.push(performance.now() - now);
    if (this.renderMs.length > 240) this.renderMs.shift();
    this.onAfterRender();
  };

  /** Render one frame immediately (for captures). */
  renderNow() { this.dirty = true; this.renderer.render(this.scene, this.camera); this.viewHelper.render(this.renderer); }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    for (const d of this.disposers) d();
    this.controls.dispose();
    this.transform.dispose();
    this.viewHelper.dispose?.();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function makeCursor(color: number) {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.97, 1.0, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }));
  const inner = new THREE.Mesh(new THREE.RingGeometry(0.48, 0.5, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide }));
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.03, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  const nrm = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 0.6)]), new THREE.LineBasicMaterial({ color, depthTest: false }));
  for (const m of [ring, inner, dot, nrm]) { m.renderOrder = 999; m.raycast = () => {}; g.add(m); }
  g.visible = false;
  return g;
}
