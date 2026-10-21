import * as THREE from 'three';
import type { App } from './App';
import { mirrorSigns } from '../sculpt/Stroke';

/**
 * Arbitrates viewport pointer input between sculpting and camera navigation.
 *
 * Runs in the capture phase on the viewport container, so it sees events before OrbitControls (which
 * listens on the canvas). When a sculpt stroke starts the event is stopped and never reaches the camera.
 *  - Mouse: left-drag on a mesh sculpts; left-drag on background, right/middle drag, Alt+drag or holding
 *    Space navigates.
 *  - Pen: always sculpts on a mesh, pressure applied when reported.
 *  - Touch: one finger on a mesh sculpts (unless pen-only mode); a second finger cancels the stroke
 *    (rolled back, no history entry) and hands both fingers to two-finger orbit/pan/zoom.
 */
export class SculptInput {
  spaceHeld = false;
  private strokePointer: number | null = null;
  private strokePointerType = '';
  private lastDown: PointerEvent | null = null;
  private touches = new Map<number, PointerEvent>();
  private forwarding = false;
  private hoverQueued: { x: number; y: number } | null = null;
  private hoverRaf = 0;
  private downAt: { x: number; y: number; t: number } | null = null;
  private disposers: (() => void)[] = [];

  constructor(private app: App, el: HTMLElement) {
    const on = <K extends keyof HTMLElementEventMap>(t: K, f: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => { el.addEventListener(t, f as any, o); this.disposers.push(() => el.removeEventListener(t, f as any, o)); };
    on('pointerdown', (e) => this.down(e), { capture: true });
    on('pointermove', (e) => this.move(e), { capture: true });
    on('pointerup', (e) => this.up(e), { capture: true });
    on('pointercancel', (e) => this.cancel(e), { capture: true });
    on('pointerleave', () => { if (this.strokePointer === null) app.viewport.placeCursor(null); });
    on('contextmenu', (e) => e.preventDefault());
    const kd = (e: KeyboardEvent) => { if (e.code === 'Space' && !isTyping(e)) { this.spaceHeld = true; } };
    const ku = (e: KeyboardEvent) => { if (e.code === 'Space') this.spaceHeld = false; };
    const blur = () => { this.spaceHeld = false; if (this.strokePointer !== null) { app.cancelStroke(); this.strokePointer = null; } };
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku); window.addEventListener('blur', blur);
    this.disposers.push(() => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('blur', blur); });
  }

  private canvas() { return this.app.viewport.renderer.domElement; }

  private down(e: PointerEvent) {
    if (this.forwarding || e.target !== this.canvas()) return;
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, e);
      if (this.touches.size >= 2 && this.strokePointer !== null) {
        // Second finger: abandon the stroke and give both pointers to the camera.
        this.app.cancelStroke();
        const first = this.lastDown;
        this.strokePointer = null;
        if (first) this.forward(first);
        this.app.toast('info', 'Two-finger gesture: stroke cancelled, navigating.', undefined, 1500);
        return;
      }
      if (this.touches.size >= 2) return;
    }
    const app = this.app;
    if (app.tool !== 'sculpt') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.spaceHeld || e.altKey) return;
    if (e.pointerType === 'touch' && app.penOnlySculpt) return;
    const hit = app.viewport.pick(e.clientX, e.clientY);
    if (!hit) return; // background → orbit
    e.stopPropagation();
    e.preventDefault();
    if (app.selected?.id !== hit.obj.id) app.select(hit.obj.id);
    const pressure = this.pressure(e);
    if (!app.beginStroke(hit.obj, hit.hit.point, pressure)) return;
    this.strokePointer = e.pointerId;
    this.strokePointerType = e.pointerType;
    this.lastDown = e;
    try { this.canvas().setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    this.updateCursor(hit.hit.point, hit.hit.face?.normal.clone().transformDirection(hit.obj.mesh.matrixWorld));
  }

  private pressure(e: PointerEvent) {
    // Mouse reports 0.5 while pressed and touch is often 0/1; only pens provide meaningful pressure.
    if (e.pointerType !== 'pen') return 1;
    return e.pressure > 0 ? Math.min(1, 0.15 + e.pressure * 0.85) : 1;
  }

  private move(e: PointerEvent) {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) this.touches.set(e.pointerId, e);
    if (this.strokePointer !== null && e.pointerId === this.strokePointer) {
      e.stopPropagation();
      const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const list = evs.length ? evs : [e];
      let last: ReturnType<App['strokeSample']> = null;
      for (const ev of list) last = this.app.strokeSample(ev.clientX, ev.clientY, this.pressure(ev)) ?? last;
      if (last) this.updateCursor(last.point, last.normal);
      return;
    }
    if (this.app.tool === 'sculpt' && e.buttons === 0 && e.pointerType !== 'touch') {
      this.hoverQueued = { x: e.clientX, y: e.clientY };
      if (!this.hoverRaf) this.hoverRaf = requestAnimationFrame(() => this.hover());
    }
  }

  private hover() {
    this.hoverRaf = 0;
    const q = this.hoverQueued;
    if (!q || this.app.tool !== 'sculpt') return;
    const hit = this.app.viewport.pick(q.x, q.y);
    if (!hit) { this.app.viewport.placeCursor(null); this.canvas().style.cursor = ''; return; }
    this.canvas().style.cursor = 'none';
    this.updateCursor(hit.hit.point, hit.hit.face?.normal.clone().transformDirection(hit.obj.mesh.matrixWorld), hit.obj);
  }

  private updateCursor(point: THREE.Vector3, normal?: THREE.Vector3, obj = this.app.selected ?? undefined) {
    const app = this.app;
    const mirrors = mirrorSigns(app.symmetry);
    app.viewport.placeCursor(point, normal ?? new THREE.Vector3(0, 1, 0), app.settings.radius, mirrors, obj);
  }

  private up(e: PointerEvent) {
    if (e.pointerType === 'touch') this.touches.delete(e.pointerId);
    if (this.strokePointer !== null && e.pointerId === this.strokePointer) {
      e.stopPropagation();
      this.strokePointer = null;
      try { this.canvas().releasePointerCapture(e.pointerId); } catch { /* already released */ }
      this.app.endStroke();
      if (this.strokePointerType === 'touch') this.app.viewport.placeCursor(null);
      return;
    }
    // click-to-select (no drag) in select/transform/inspect tools
    const d = this.downAt;
    if (d && e.target === this.canvas() && this.app.tool !== 'sculpt' && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5 && performance.now() - d.t < 500) {
      if (this.app.viewport.transform.dragging) return;
      const hit = this.app.viewport.pick(e.clientX, e.clientY, { includeLocked: true });
      this.app.select(hit ? hit.obj.id : null);
    }
  }

  private cancel(e: PointerEvent) {
    if (e.pointerType === 'touch') this.touches.delete(e.pointerId);
    if (this.strokePointer !== null && e.pointerId === this.strokePointer) {
      this.strokePointer = null;
      this.app.cancelStroke(); // pointercancel: roll back, no history
    }
  }

  /** Replay a pointerdown to the canvas so OrbitControls starts tracking a pointer it never saw. */
  private forward(src: PointerEvent) {
    this.forwarding = true;
    try {
      this.canvas().dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: src.pointerId, pointerType: src.pointerType, clientX: src.clientX, clientY: src.clientY, button: 0, buttons: 1, isPrimary: src.isPrimary, bubbles: true, cancelable: true,
      }));
    } finally { this.forwarding = false; }
  }

  dispose() { for (const d of this.disposers) d(); cancelAnimationFrame(this.hoverRaf); }
}

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
