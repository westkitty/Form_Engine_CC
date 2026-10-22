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
      if (this.touches.size === 0) this.tap = { start: e.timeStamp, max: 0, moved: false, origin: new Map() };
      this.touches.set(e.pointerId, e);
      if (this.tap) { this.tap.origin.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.tap.max = Math.max(this.tap.max, this.touches.size); }
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
    if (e.pointerType === 'pen') this.notePen();
    if (app.tool !== 'sculpt') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.spaceHeld || e.altKey) return;
    // Palm rejection: once a pen has been used (or pen-only is on), fingers only navigate.
    if (e.pointerType === 'touch' && (app.penOnlySculpt || (app.autoPalmRejection && app.penSeen))) return;
    const hit = app.viewport.pick(e.clientX, e.clientY);
    if (!hit) return; // background → orbit
    e.stopPropagation();
    e.preventDefault();
    if (app.selected?.id !== hit.obj.id) app.select(hit.obj.id);
    const pressure = this.pressure(e);
    // S Pen side (barrel) button = buttons bit 2; eraser end = bit 32. Either inverts this stroke.
    const invert = e.pointerType === 'pen' && ((e.buttons & 2) !== 0 || (e.buttons & 32) !== 0 || e.button === 5);
    if (!app.beginStroke(hit.obj, hit.hit.point, pressure, invert)) return;
    this.strokePointer = e.pointerId;
    this.strokePointerType = e.pointerType;
    this.lastDown = e;
    try { this.canvas().setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    this.updateCursor(hit.hit.point, hit.hit.face?.normal.clone().transformDirection(hit.obj.mesh.matrixWorld));
  }

  private pressure(e: PointerEvent) {
    // Mouse reports 0.5 while pressed and touch is often 0/1; only pens provide meaningful pressure.
    if (e.pointerType !== 'pen') return 1;
    if (!(e.pressure > 0)) return 1;
    const gamma = this.app.pressureCurve === 'soft' ? 0.6 : this.app.pressureCurve === 'firm' ? 1.7 : 1;
    return Math.min(1, 0.12 + Math.pow(e.pressure, gamma) * 0.88);
  }

  private penNoted = false;
  private notePen() {
    const app = this.app;
    if (app.penSeen) return;
    app.penSeen = true;
    if (!this.penNoted && app.autoPalmRejection) {
      this.penNoted = true;
      app.toast('info', 'Pen detected: fingers now only move the view (palm rejection). Side button inverts the brush.', undefined, 4500);
      app.emit('brush');
    }
  }

  private move(e: PointerEvent) {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, e);
      const o = this.tap?.origin.get(e.pointerId);
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 14) this.tap!.moved = true;
    }
    if (e.pointerType === 'pen' && e.buttons === 0) this.notePen();
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

  /** Two-finger tap = undo, three-finger tap = redo (short, nearly motionless multi-touch). */
  private tap: { start: number; max: number; moved: boolean; origin: Map<number, { x: number; y: number }> } | null = null;
  private endTouch(id: number, at: number) {
    this.touches.delete(id);
    if (this.touches.size || !this.tap) return;
    const t = this.tap; this.tap = null;
    // Event timestamps (when the fingers actually touched/lifted), so a busy main thread can't turn a quick tap into a "slow" one.
    const ms = at - t.start;
    (window as any).__lastTap = { max: t.max, moved: t.moved, ms: Math.round(ms) }; // diagnostics (read by tests)
    if (t.moved || ms > 500) return;
    if (t.max === 2) this.app.undo();
    else if (t.max === 3) this.app.redo();
  }

  private up(e: PointerEvent) {
    if (e.pointerType === 'touch') this.endTouch(e.pointerId, e.timeStamp);
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
    if (e.pointerType === 'touch') { this.touches.delete(e.pointerId); if (!this.touches.size) this.tap = null; }
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
