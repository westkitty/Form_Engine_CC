import * as THREE from 'three';
import { App, fmtBytes, type Tool } from '../app/App';
import { SculptInput, isTyping } from '../app/SculptInput';
import { BRUSH_INFO, defaultSettings, type BrushType, type FalloffType } from '../sculpt/brushes';
import { PRIMITIVE_LABELS, type PrimitiveKind } from '../geometry/topology';
import { VIEW_MODE_LABELS, type ViewMode } from '../viewport/materials';
import { h, replace, button, ICON, dialog, clear, popover, vSlider } from './dom';
import { openImageLab, handleImageFiles } from './ImageLab';
import { openExportDialog } from './ExportDialog';
import { openGallery } from './Gallery';
import { openCommandPalette, openHelp } from './Palette';
import { isImageFile, isModelFile } from '../io/importers';
import { LIMITS } from '../io/validate';
import { installState, promptInstall, onInstallChange, fullscreenSupported, toggleFullscreen, isFullscreen } from './install';

/** Brushes on the dock; the rest live behind "More". */
const DOCK_BRUSHES: BrushType[] = ['draw', 'clay', 'smooth', 'grab', 'mask'];
const MORE_BRUSHES: BrushType[] = ['inflate', 'flatten', 'pinch', 'crease'];
const BRUSH_KEYS: Record<string, BrushType> = { b: 'draw', c: 'clay', n: 'inflate', s: 'smooth', g: 'grab', p: 'pinch', e: 'crease', m: 'mask' };

type SheetTab = 'object' | 'scene' | 'refs';

/**
 * Canvas-first workbench. The sculpture fills the screen; controls float around it:
 *  - top bar: project, undo/redo, Image → 3D, export, view, panel, full screen, menu
 *  - brush dock (one side): the five everyday brushes, "More", and Move
 *  - control rail (other side): large vertical Size and Strength sliders, symmetry, invert, brush settings
 *  - panel (on demand): object, scene and reference details
 * Dock and rail swap sides for left-handed use.
 */
export class Shell {
  readonly root: HTMLElement;
  input!: SculptInput;
  private els: Record<string, HTMLElement> = {};
  private sliders: { size?: ReturnType<typeof vSlider>; strength?: ReturnType<typeof vSlider> } = {};
  private hudVisible = false;
  private presentation = false;
  private sheetOpen = false;
  private sheetTab: SheetTab = 'object';
  private hudTimer = 0;

  constructor(readonly app: App, mountPoint: HTMLElement) {
    this.root = h('div', { class: 'app', id: 'app' });
    mountPoint.appendChild(this.root);
    this.build();
  }

  private build() {
    const app = this.app;
    const viewWrap = h('main', { class: 'viewport', id: 'viewport', 'aria-label': 'Sculpting viewport' });
    const top = h('header', { class: 'topbar', role: 'banner' });
    const dock = h('nav', { class: 'dock', 'aria-label': 'Brushes and tools' });
    const rail = h('aside', { class: 'rail', 'aria-label': 'Brush controls' });
    const sheet = h('aside', { class: 'sheet', id: 'inspector', 'aria-label': 'Object panel', hidden: true });
    const toasts = h('div', { class: 'toasts', role: 'log', 'aria-live': 'polite' });
    const announcer = h('div', { class: 'sr-only', 'aria-live': 'assertive', id: 'announcer' });
    const fileOpen = h('input', { type: 'file', hidden: true, multiple: true, id: 'file-open', accept: '.glb,.gltf,.bin,.obj,.mtl,.stl,.ply,.png,.jpg,.jpeg,.webp,.formengine' });
    fileOpen.addEventListener('change', () => { const files = [...(fileOpen.files ?? [])]; fileOpen.value = ''; void this.handleFiles(files); });
    this.root.append(viewWrap, top, dock, rail, sheet, toasts, announcer, fileOpen);
    Object.assign(this.els, { viewWrap, top, dock, rail, sheet, toasts });

    app.mount(viewWrap);
    this.input = new SculptInput(app, viewWrap);
    app.viewport.onContextChange = (lost) => this.contextOverlay(lost);

    const hud = h('div', { class: 'hud', id: 'hud', hidden: true });
    const drop = h('div', { class: 'dropzone', hidden: true }, h('div', null, h('strong', null, 'Drop to open'), h('span', null, '3D models (GLB, glTF, OBJ, STL, PLY), photos (PNG, JPEG, WebP) or .formengine projects')));
    viewWrap.append(hud, drop);
    Object.assign(this.els, { hud, drop });

    this.renderTop();
    this.renderDock();
    this.renderRail();
    this.applyHandedness();
    new ResizeObserver(() => this.layoutGizmo()).observe(viewWrap);
    this.setupDrop();
    this.setupKeys();
    onInstallChange(() => this.renderTop());
    document.addEventListener('fullscreenchange', () => { this.renderTop(); setTimeout(() => app.viewport.resize(), 50); });

    app.on((what) => {
      if (what === 'toast') return this.renderToasts();
      if (what === 'save' || what === 'history') this.renderTopState();
      if (what === 'transform') return this.renderTransformValues();
      if (what === 'brush') return this.syncRail();
      if (what === 'tool') { this.renderDock(); this.syncRail(); if (app.tool === 'transform') this.openSheet('object'); }
      if (['scene', 'project', 'references', 'display'].includes(what)) { this.renderTopState(); if (this.sheetOpen) this.renderSheet(); }
      if (what === 'project') { this.renderTop(); this.renderDock(); this.renderRail(); }
    });
    this.hudTimer = window.setInterval(() => { if (this.hudVisible) this.renderHud(); }, 500);
    window.addEventListener('beforeunload', (e) => { if (app.dirty) { void app.autosaveNow(); e.preventDefault(); } });
  }

  applyHandedness() {
    this.root.classList.toggle('lefty', this.app.handedness === 'left');
    this.layoutGizmo();
  }

  /** Keep the axis gizmo clear of the floating rail and top bar. */
  layoutGizmo() {
    const vp = this.app.viewport, w = this.els.viewWrap.clientWidth;
    const rail = this.els.rail?.getBoundingClientRect();
    vp.gizmo.visible = w > 700 && !this.sheetOpen;
    vp.gizmo.top = 76;
    vp.gizmo.right = this.app.handedness === 'left' ? 12 : Math.round((rail?.width || 84) + 26);
    vp.requestRender();
  }

  // ───────────────────────── top bar ─────────────────────────

  private renderTop() {
    const app = this.app;
    const name = h('input', { class: 'proj-name', value: app.projectName, 'aria-label': 'Project name', maxlength: '80', spellcheck: 'false' });
    name.addEventListener('change', () => { app.projectName = name.value.trim().slice(0, 80) || 'Untitled sculpture'; app.markDirty(); app.emit('project'); });
    this.els.projName = name;
    const inst = installState();
    replace(this.els.top,
      h('div', { class: 'tb-left' },
        h('span', { class: 'brand', 'aria-label': 'FORM//ENGINE', title: 'FORM//ENGINE' }, h('b', null, 'F'), h('i', null, '//')),
        name, h('span', { class: 'save-dot', id: 'save-state', role: 'status' })),
      h('div', { class: 'tb-mid' },
        button('Undo', () => app.undo(), { icon: ICON.undo, class: 'icon-only tb', key: 'Ctrl+Z · two-finger tap', id: 'btn-undo' }),
        button('Redo', () => app.redo(), { icon: ICON.redo, class: 'icon-only tb', key: 'Ctrl+Shift+Z · three-finger tap', id: 'btn-redo' })),
      h('div', { class: 'tb-right' },
        button('Image → 3D', () => openImageLab(app), { icon: ICON.image, class: 'accent tb', title: 'Make 3D from a photo (free, on this device)', id: 'btn-imagelab' }),
        button('Export', () => openExportDialog(app), { icon: ICON.export, class: 'icon-only tb', title: 'Export GLB / OBJ / STL (Ctrl+E)', id: 'btn-export' }),
        button('View', () => this.openViewMenu(), { icon: ICON.view, class: 'icon-only tb', title: 'View and display', id: 'btn-view' }),
        button('Panel', () => (this.sheetOpen ? this.closeSheet() : this.openSheet(this.sheetTab)), { icon: ICON.panel, class: 'icon-only tb', title: 'Object panel', id: 'btn-panel', pressed: this.sheetOpen }),
        inst === 'available' ? button('Install', () => void promptInstall(), { icon: ICON.install, class: 'icon-only tb', title: 'Install as an app', id: 'btn-install' }) : null,
        fullscreenSupported() ? button(isFullscreen() ? 'Exit full screen' : 'Full screen', () => void toggleFullscreen(), { icon: isFullscreen() ? ICON.exitFullscreen : ICON.fullscreen, class: 'icon-only tb', id: 'btn-fullscreen' }) : null,
        button('Menu', () => this.openMainMenu(), { icon: ICON.menu, class: 'icon-only tb', id: 'btn-menu' })),
    );
    this.renderTopState();
  }

  private renderTopState() {
    const app = this.app;
    const s = document.getElementById('save-state');
    if (s) {
      const label = { idle: 'Not saved yet', pending: 'Unsaved changes', saving: 'Saving…', saved: `Saved on this device ${app.lastSavedAt ? new Date(app.lastSavedAt).toLocaleTimeString() : ''}`, error: 'Autosave failed', unavailable: 'Can’t autosave here — use Save' }[app.saveState];
      s.title = label; s.setAttribute('aria-label', label); s.dataset.state = app.saveState;
    }
    const pn = this.els.projName as HTMLInputElement | undefined;
    if (pn && document.activeElement !== pn) pn.value = app.projectName;
    (document.getElementById('btn-undo') as HTMLButtonElement | null)?.toggleAttribute('disabled', !app.history.canUndo);
    (document.getElementById('btn-redo') as HTMLButtonElement | null)?.toggleAttribute('disabled', !app.history.canRedo);
  }

  private menuList(items: (HTMLElement | null)[]) { return h('div', { class: 'menu', role: 'menu' }, ...items); }
  private item(label: string, fn: () => void, opts: { hint?: string; id?: string; icon?: string } = {}) {
    return h('button', { type: 'button', role: 'menuitem', class: 'menu-item', id: opts.id, onclick: () => { document.querySelectorAll('.pop').forEach((p) => p.remove()); fn(); } },
      opts.icon ? h('span', { class: 'ico', 'aria-hidden': 'true', html: opts.icon }) : h('span', { class: 'ico' }), h('span', { class: 'mi-label' }, label), opts.hint ? h('kbd', null, opts.hint) : null);
  }

  openMainMenu() {
    const app = this.app;
    const anchor = document.getElementById('btn-menu')!;
    const inst = installState();
    const menu = this.menuList([
      this.item('Open file…', () => (document.getElementById('file-open') as HTMLInputElement).click(), { hint: 'O', id: 'menu-import', icon: ICON.open }),
      this.item('Save project file', () => void app.saveProjectFile(), { hint: 'Ctrl+S', id: 'btn-save', icon: ICON.save }),
      this.item('Export model…', () => openExportDialog(app), { hint: 'Ctrl+E', icon: ICON.export }),
      this.item('My projects…', () => void openGallery(app), { icon: ICON.library }),
      h('hr'),
      this.item('New sculpture', () => app.newProject(true), { icon: ICON.plus }),
      h('div', { class: 'menu-row', role: 'group', 'aria-label': 'Add shape' }, ...(['sphere', 'cube', 'cylinder', 'torus', 'plane'] as PrimitiveKind[]).map((k) =>
        h('button', { type: 'button', class: 'chip', onclick: () => { document.querySelectorAll('.pop').forEach((p) => p.remove()); app.addPrimitive(k, 3); } }, PRIMITIVE_LABELS[k].replace(' (ico)', '')))),
      h('hr'),
      inst === 'available' ? this.item('Install as an app', () => void promptInstall(), { icon: ICON.install, id: 'menu-install' })
        : inst === 'installed' ? null : this.item('How to install…', () => this.installHelp(), { icon: ICON.install }),
      this.item(app.handedness === 'right' ? 'Left-handed layout' : 'Right-handed layout', () => { app.handedness = app.handedness === 'right' ? 'left' : 'right'; app.persistPrefs(); this.applyHandedness(); }, { icon: ICON.symmetry }),
      this.item('Shortcuts & gestures', () => openHelp(), { hint: '?', icon: ICON.help }),
      this.item('Command palette', () => openCommandPalette(app, this), { hint: 'Ctrl+K', icon: ICON.command }),
      this.item('Recover last autosave', () => void app.restoreLast(), { icon: ICON.undo }),
    ]);
    popover(anchor, menu, { side: 'below', label: 'Main menu', id: 'main-menu' });
  }

  private openViewMenu() {
    const app = this.app, vp = app.viewport;
    const anchor = document.getElementById('btn-view')!;
    const mode = h('div', { class: 'seg wrap', role: 'radiogroup', 'aria-label': 'Surface' }, ...(Object.keys(VIEW_MODE_LABELS) as ViewMode[]).map((m) =>
      h('button', { type: 'button', class: `chip ${vp.viewMode === m ? 'on' : ''}`, role: 'radio', 'aria-checked': String(vp.viewMode === m), onclick: () => { app.setViewMode(m); this.openViewMenu(); } }, VIEW_MODE_LABELS[m].replace(' (own material)', ''))));
    const toggle = (label: string, on: boolean, fn: () => void, id?: string) => h('button', { type: 'button', class: `chip ${on ? 'on' : ''}`, 'aria-pressed': String(on), id, onclick: () => { fn(); this.openViewMenu(); } }, label);
    const content = h('div', { class: 'menu view-menu' },
      h('div', { class: 'menu-title' }, 'Camera'),
      h('div', { class: 'menu-row' },
        h('button', { type: 'button', class: 'chip', onclick: () => vp.frame(app.selected) }, 'Frame'),
        ...(['front', 'right', 'top', 'iso'] as const).map((v) => h('button', { type: 'button', class: 'chip', onclick: () => vp.setView(v) }, v[0].toUpperCase() + v.slice(1))),
        toggle('Ortho', vp.isOrtho, () => vp.setOrthographic(!vp.isOrtho))),
      h('div', { class: 'menu-title' }, 'Surface'),
      mode,
      h('div', { class: 'menu-title' }, 'Show'),
      h('div', { class: 'menu-row' },
        toggle('Wireframe', vp.wireframe, () => vp.setWireframe(!vp.wireframe)),
        toggle('Grid', vp.grid.visible, () => { vp.grid.visible = !vp.grid.visible; vp.ground.visible = vp.grid.visible; vp.requestRender(); }),
        toggle('Turntable', this.presentation, () => this.togglePresentation()),
        toggle('Diagnostics', this.hudVisible, () => this.toggleHud(), 'toggle-hud'),
        toggle('High contrast', document.documentElement.dataset.contrast === 'high', () => { const on = document.documentElement.dataset.contrast !== 'high'; document.documentElement.dataset.contrast = on ? 'high' : ''; localStorageSet('contrast', on ? 'high' : ''); })),
    );
    popover(anchor, content, { side: 'below', label: 'View options', id: 'view-menu' });
  }

  togglePresentation() {
    this.presentation = !this.presentation;
    this.root.classList.toggle('presenting', this.presentation);
    this.app.viewport.turntable = this.presentation;
    this.app.viewport.transform.detach();
    if (!this.presentation) { this.app.model.root.rotation.y = 0; this.app.setTool(this.app.tool); }
    else this.app.toast('info', 'Turntable on. Tap the screen or press Esc to return.', undefined, 2500);
    this.app.viewport.placeCursor(null);
    this.app.viewport.requestRender();
  }

  toggleHud() { this.hudVisible = !this.hudVisible; this.els.hud.hidden = !this.hudVisible; this.renderHud(); }

  private installHelp() {
    const d = dialog('Install FORM//ENGINE as an app', { id: 'install-help' });
    d.body.append(
      h('p', null, 'Installed, it opens full screen from your home screen like any other app, and keeps working offline.'),
      h('h3', null, 'Android app (APK)'),
      h('p', null, 'A full-screen FORM//ENGINE app for Android tablets, with saving straight to Downloads. Download ', h('a', { href: './android/form-engine.apk', download: 'form-engine.apk' }, 'form-engine.apk'), ' on the tablet and open it (allow “Install unknown apps” for your browser when asked), or install it from a computer with ADB: ', h('code', null, 'adb install -r form-engine.apk'), '.'),
      h('h3', null, 'Samsung Galaxy Tab / Android (no APK)'),
      h('ol', null,
        h('li', null, 'Open this page in Chrome or Samsung Internet (not inside another app’s browser).'),
        h('li', null, 'Chrome: tap ⋮ → “Add to home screen” → “Install”. Samsung Internet: tap the menu ☰ → “Add page to” → “Home screen”.'),
        h('li', null, 'Open FORM//ENGINE from the new home-screen icon. It launches full screen in its own window.')),
      h('h3', null, 'iPad'),
      h('p', null, 'In Safari tap Share → “Add to Home Screen”.'),
      h('h3', null, 'Mac / Windows'),
      h('p', null, 'Chrome or Edge: click the install icon in the address bar. Safari (macOS): File → Add to Dock.'),
      h('p', { class: 'hint' }, 'If no install option appears, you are probably in an in-app browser or a private tab.'));
  }

  // ───────────────────────── brush dock ─────────────────────────

  private renderDock() {
    const app = this.app;
    const brushBtn = (b: BrushType) => {
      const on = app.tool === 'sculpt' && app.brush === b;
      return h('button', { type: 'button', class: `dock-btn b-${b} ${on ? 'on' : ''}`, id: `brush-${b}`, 'aria-pressed': String(on), title: `${BRUSH_INFO[b].label} — ${BRUSH_INFO[b].summary}`, onclick: () => app.setBrush(b) },
        h('span', { class: 'b-glyph', 'aria-hidden': 'true' }), h('span', { class: 'dock-lbl' }, BRUSH_INFO[b].label.replace(' Build', '')));
    };
    const moreOn = app.tool === 'sculpt' && MORE_BRUSHES.includes(app.brush);
    const more = h('button', { type: 'button', class: `dock-btn ${moreOn ? 'on' : ''} ${moreOn ? `b-${app.brush}` : ''}`, id: 'brush-more', 'aria-haspopup': 'dialog', title: 'More brushes',
      onclick: () => popover(more, h('div', { class: 'menu brush-more' }, ...MORE_BRUSHES.map((b) => h('button', { type: 'button', class: `more-brush b-${b} ${app.brush === b ? 'on' : ''}`, id: `brush-${b}`, onclick: () => { document.querySelectorAll('.pop').forEach((p) => p.remove()); app.setBrush(b); } },
        h('span', { class: 'b-glyph', 'aria-hidden': 'true' }), h('span', null, h('b', null, BRUSH_INFO[b].label), h('small', null, BRUSH_INFO[b].summary))))), { side: app.handedness === 'left' ? 'left' : 'right', label: 'More brushes' }) },
      moreOn ? h('span', { class: 'b-glyph', 'aria-hidden': 'true' }) : h('span', { class: 'ico', 'aria-hidden': 'true', html: ICON.more }),
      h('span', { class: 'dock-lbl' }, moreOn ? BRUSH_INFO[app.brush].label : 'More'));
    const tool = (t: Tool, label: string, icon: string, id: string) => h('button', { type: 'button', class: `dock-btn ${app.tool === t ? 'on' : ''}`, id, 'aria-pressed': String(app.tool === t), title: label, onclick: () => app.setTool(t) },
      h('span', { class: 'ico', 'aria-hidden': 'true', html: icon }), h('span', { class: 'dock-lbl' }, label));
    replace(this.els.dock, ...DOCK_BRUSHES.map(brushBtn), more, h('div', { class: 'dock-sep' }), tool('transform', 'Move', ICON.move, 'tool-transform'), tool('select', 'Select', ICON.select, 'tool-select'));
  }

  // ───────────────────────── control rail ─────────────────────────

  private renderRail() {
    const app = this.app;
    this.sliders.size = vSlider({ id: 'rail-size', label: 'Size', min: 0.002, max: 3, value: app.settings.radius, log: true, format: (v) => `${v < 0.1 ? v.toFixed(3) : v.toFixed(2)} ${app.units}`, onInput: (v) => app.updateSettings({ radius: v }) });
    this.sliders.strength = vSlider({ id: 'rail-strength', label: 'Strength', min: 0, max: 1, value: app.settings.strength, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => app.updateSettings({ strength: v }) });
    const sym = h('button', { type: 'button', class: `rail-btn ${app.symmetry.x ? 'on' : ''}`, id: 'sym-x', 'aria-pressed': String(app.symmetry.x), title: 'Mirror strokes across the middle (X)', onclick: () => app.setSymmetry({ x: !app.symmetry.x }) },
      h('span', { class: 'ico', html: ICON.symmetry, 'aria-hidden': 'true' }), h('span', { class: 'rail-lbl' }, 'Mirror'));
    const inv = h('button', { type: 'button', class: `rail-btn ${app.settings.invert ? 'on' : ''}`, id: 'f-invert', 'aria-pressed': String(app.settings.invert), title: 'Invert the brush (I). S Pen: hold the side button.', onclick: () => app.updateSettings({ invert: !app.settings.invert }) },
      h('span', { class: 'ico', html: ICON.invert, 'aria-hidden': 'true' }), h('span', { class: 'rail-lbl' }, app.brush === 'mask' ? 'Erase' : 'Invert'));
    const gear: HTMLButtonElement = h('button', { type: 'button', class: 'rail-btn', id: 'btn-brush-settings', title: 'Brush settings', onclick: () => this.openBrushSettings(gear) },
      h('span', { class: 'ico', html: ICON.settings, 'aria-hidden': 'true' }), h('span', { class: 'rail-lbl' }, 'Brush'));
    replace(this.els.rail, this.sliders.size.el, this.sliders.strength.el, sym, inv, gear);
  }

  private syncRail() {
    const app = this.app, s = app.settings;
    this.sliders.size?.set(s.radius);
    this.sliders.strength?.set(s.strength);
    const sym = document.getElementById('sym-x');
    if (sym) { sym.classList.toggle('on', app.symmetry.x); sym.setAttribute('aria-pressed', String(app.symmetry.x)); }
    const inv = document.getElementById('f-invert');
    if (inv) { inv.classList.toggle('on', s.invert); inv.setAttribute('aria-pressed', String(s.invert)); inv.querySelector('.rail-lbl')!.textContent = app.brush === 'mask' ? 'Erase' : 'Invert'; }
    if (this.hudVisible) this.renderHud();
  }

  private openBrushSettings(anchor: HTMLElement) {
    const app = this.app, s = app.settings;
    const sel = <T extends string>(id: string, label: string, opts: [T, string][], cur: T, fn: (v: T) => void) => {
      const el = h('select', { id }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
      el.addEventListener('change', () => fn(el.value as T));
      return h('label', { class: 'set-row', for: id }, h('span', null, label), el);
    };
    const chk = (id: string, label: string, val: boolean, fn: (v: boolean) => void) => {
      const c = h('input', { type: 'checkbox', id, checked: val });
      c.addEventListener('change', () => fn(c.checked));
      return h('label', { class: 'set-row chk', for: id }, h('span', null, label), c);
    };
    const spacing = h('input', { type: 'range', id: 'f-spacing', min: '0.05', max: '0.6', step: '0.01', value: String(s.spacing), 'aria-label': 'Stroke spacing' });
    spacing.addEventListener('input', () => app.updateSettings({ spacing: +spacing.value }));
    const content = h('div', { class: 'menu settings-menu' },
      h('div', { class: 'menu-title' }, `${BRUSH_INFO[app.brush].label} brush`),
      sel<FalloffType>('f-falloff', 'Edge falloff', [['smooth', 'Smooth'], ['sphere', 'Round'], ['linear', 'Linear'], ['sharp', 'Sharp'], ['constant', 'Hard']], s.falloff, (v) => app.updateSettings({ falloff: v })),
      h('label', { class: 'set-row', for: 'f-spacing' }, h('span', null, 'Stroke spacing'), spacing),
      app.brush === 'smooth' ? chk('f-boundary', 'Keep open edges in place', s.protectBoundary, (v) => app.updateSettings({ protectBoundary: v })) : null,
      h('div', { class: 'menu-title' }, 'Mirror'),
      h('div', { class: 'menu-row' }, ...(['x', 'y', 'z'] as const).map((ax) => h('button', { type: 'button', class: `chip ${app.symmetry[ax] ? 'on' : ''}`, id: `sym-${ax}-chip`, 'aria-pressed': String(app.symmetry[ax]), onclick: () => { app.setSymmetry({ [ax]: !app.symmetry[ax] }); this.openBrushSettings(anchor); } }, `${ax.toUpperCase()} axis`))),
      h('div', { class: 'menu-title' }, 'Pen & touch'),
      chk('f-pressure', 'Pen pressure changes strength', s.pressure, (v) => app.updateSettings({ pressure: v })),
      sel<'soft' | 'linear' | 'firm'>('f-curve', 'Pressure feel', [['soft', 'Soft (light touch)'], ['linear', 'Natural'], ['firm', 'Firm']], app.pressureCurve, (v) => { app.pressureCurve = v; app.persistPrefs(); }),
      chk('f-palm', 'Ignore fingers once a pen is used', app.autoPalmRejection, (v) => { app.autoPalmRejection = v; app.persistPrefs(); }),
      chk('f-penonly', 'Fingers never sculpt', app.penOnlySculpt, (v) => { app.penOnlySculpt = v; app.persistPrefs(); }),
      h('div', { class: 'menu-title' }, 'Mask'),
      h('div', { class: 'menu-row' },
        h('button', { type: 'button', class: 'chip', onclick: () => app.maskAll('clear') }, 'Clear mask'),
        h('button', { type: 'button', class: 'chip', onclick: () => app.maskAll('invert') }, 'Invert mask')),
      h('button', { type: 'button', class: 'link', onclick: () => { app.updateSettings(defaultSettings(app.brush)); this.openBrushSettings(anchor); } }, 'Reset this brush'),
    );
    popover(anchor, content, { side: app.handedness === 'left' ? 'right' : 'left', label: 'Brush settings', id: 'brush-settings' });
  }

  // ───────────────────────── panel (sheet) ─────────────────────────

  openSheet(tab: SheetTab) {
    this.sheetOpen = true;
    this.sheetTab = tab;
    this.els.sheet.hidden = false;
    this.root.classList.add('sheet-open');
    document.getElementById('btn-panel')?.setAttribute('aria-pressed', 'true');
    this.renderSheet();
    this.layoutGizmo();
  }
  closeSheet() {
    this.sheetOpen = false;
    this.els.sheet.hidden = true;
    this.root.classList.remove('sheet-open');
    document.getElementById('btn-panel')?.setAttribute('aria-pressed', 'false');
    this.layoutGizmo();
  }

  /** Kept for callers that refresh the panel (e.g. after boot). */
  renderInspector() { if (this.sheetOpen) this.renderSheet(); }

  private renderSheet() {
    const app = this.app;
    const tabs: [SheetTab, string][] = [['object', 'Object'], ['scene', 'Scene'], ...(app.references.length ? [['refs', 'References'] as [SheetTab, string]] : [])];
    if (!tabs.some(([t]) => t === this.sheetTab)) this.sheetTab = 'object';
    const body = this.sheetTab === 'object' ? this.objectPanel() : this.sheetTab === 'scene' ? this.scenePanel() : this.referencePanel();
    const scroll = this.els.sheet.querySelector('.sheet-body')?.scrollTop ?? 0;
    replace(this.els.sheet,
      h('div', { class: 'sheet-head' },
        h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Panel sections', onkeydown: (e: KeyboardEvent) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          const i = tabs.findIndex(([t]) => t === this.sheetTab), n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
          this.openSheet(n); document.getElementById(`tab-${n}`)?.focus();
        } }, ...tabs.map(([t, l]) => h('button', { type: 'button', role: 'tab', class: `tab ${this.sheetTab === t ? 'on' : ''}`, 'aria-selected': String(this.sheetTab === t), 'aria-controls': 'sheet-panel', tabindex: this.sheetTab === t ? '0' : '-1', id: `tab-${t}`, onclick: () => this.openSheet(t) }, l))),
        h('button', { type: 'button', class: 'btn icon-only ghost', 'aria-label': 'Close panel', title: 'Close panel', html: ICON.close, onclick: () => this.closeSheet() })),
      h('div', { class: 'sheet-body', role: 'tabpanel', id: 'sheet-panel', 'aria-labelledby': `tab-${this.sheetTab}` }, body));
    const b = this.els.sheet.querySelector('.sheet-body');
    if (b) b.scrollTop = scroll;
    queueMicrotask(() => this.renderTransformValues());
  }

  private group(title: string, ...content: (Node | null | false)[]) {
    return h('section', { class: 'grp' }, h('h3', null, title), ...content.filter(Boolean) as Node[]);
  }

  private objectPanel() {
    const app = this.app;
    const o = app.selected;
    if (!o) return h('p', { class: 'empty' }, 'Nothing selected. Tap an object, or add one from the menu.');
    const rows = (['position', 'rotation', 'scale'] as const).map((part) => {
      const label = { position: 'Position', rotation: 'Rotation °', scale: 'Scale' }[part];
      return h('div', { class: 'field xyz' }, h('span', { class: 'mini-label' }, label), ...[0, 1, 2].map((ax) => {
        const inp = h('input', { type: 'number', inputmode: 'decimal', step: part === 'rotation' ? '1' : '0.01', class: `num ax-${'xyz'[ax]}`, 'aria-label': `${label} ${'XYZ'[ax]}`, 'data-part': part, 'data-axis': String(ax) });
        inp.addEventListener('change', () => app.setTransformNumeric(o.id, part, ax as 0 | 1 | 2, parseFloat(inp.value)));
        return inp;
      }));
    });
    const st = o.editable.stats();
    const size = new THREE.Vector3().fromArray(st.bounds.max).sub(new THREE.Vector3().fromArray(st.bounds.min)).multiply(o.mesh.scale);
    const report = h('div', { class: 'report', id: 'mesh-report' });
    const ratio = h('select', { 'aria-label': 'Decimation target', id: 'dec-ratio' }, ...[0.75, 0.5, 0.25, 0.1].map((r) => h('option', { value: String(r) }, `${Math.round(r * 100)}%`)));
    const p = o.provenance;
    const colour = h('input', { type: 'color', value: o.materialParams.kind === 'clay' ? o.materialParams.color : '#c9b8a3', 'aria-label': 'Clay colour', id: 'obj-colour' });
    colour.addEventListener('change', () => app.setMaterialColor(o.id, colour.value));
    return h('div', null,
      h('div', { class: 'obj-title' }, h('strong', null, o.name), h('span', { class: 'hint' }, `${st.triangles.toLocaleString()} triangles · ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} ${app.units}`)),
      p.inferredWarning ? h('p', { class: 'note' }, p.inferredWarning) : null,
      this.group('Position',
        h('div', { class: 'seg' }, ...(['translate', 'rotate', 'scale'] as const).map((m, i) => h('button', { type: 'button', class: `chip ${app.tool === 'transform' && app.transformMode === m ? 'on' : ''}`, onclick: () => { app.setTool('transform'); app.setTransformMode(m); this.renderSheet(); } }, ['Move', 'Rotate', 'Scale'][i]))),
        ...rows,
        h('button', { type: 'button', class: 'link', onclick: () => app.resetTransform(o.id) }, 'Reset position')),
      this.group('Look', h('label', { class: 'set-row', for: 'obj-colour' }, h('span', null, o.materialParams.kind === 'clay' ? 'Clay colour' : 'Replace material with clay'), colour)),
      this.group('Detail',
        h('div', { class: 'btn-row' },
          button('More detail', () => app.subdivide(), { class: 'small', title: 'Subdivide: 4× triangles so fine strokes look smooth', id: 'btn-subdivide' }),
          h('span', { class: 'inline' }, button('Simplify to', () => void app.decimate(+ratio.value), { class: 'small', title: 'Decimate (keeps shape, fewer triangles)' }), ratio))),
      this.group('Check & repair',
        h('div', { class: 'btn-row' },
          button('Check mesh', () => this.renderReport(report, o.id), { class: 'small', id: 'btn-analyze' }),
          button('Remove loose bits', () => app.repair('debris'), { class: 'small ghost' }),
          button('Flip inside-out', () => app.repair('flip'), { class: 'small ghost' }),
          button('Centre pivot', () => app.repair('recenter'), { class: 'small ghost' })),
        report),
      this.group('Source',
        h('p', { class: 'hint' }, `${{ primitive: 'Starter shape', import: 'Imported file', reconstruction: 'Made from photo (cloud)', depth: 'Made from photo (on this device)', relief: '2.5D relief from image', project: 'From project' }[p.source]}${p.detail ? ` — ${p.detail}` : ''}`)),
    );
  }

  private renderReport(el: HTMLElement, id: string) {
    const o = this.app.model.get(id);
    if (!o) return;
    const r = this.app.meshReport(o);
    replace(el,
      h('p', { class: r.issues.length ? 'hint warn' : 'hint ok' }, r.issues.length ? `${r.issues.length} thing(s) to know:` : `Looks good: ${r.watertight ? 'closed (printable)' : 'open'} surface, ${r.components} piece${r.components === 1 ? '' : 's'}.`),
      r.issues.length ? h('ul', { class: 'issues' }, ...r.issues.map((i) => h('li', null, i))) : null);
  }

  private scenePanel() {
    const app = this.app;
    const list = h('ul', { class: 'outliner', role: 'listbox', 'aria-label': 'Objects' });
    for (const o of app.model.objects) {
      const nameEl = h('span', { class: 'o-name', title: 'Double-tap to rename' }, o.name);
      nameEl.addEventListener('dblclick', () => {
        const inp = h('input', { value: o.name, class: 'rename', 'aria-label': 'New name', maxlength: '80' });
        nameEl.replaceWith(inp); inp.focus(); inp.select();
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = o.name; inp.blur(); } });
        inp.addEventListener('blur', () => app.renameObject(o.id, inp.value));
      });
      const li = h('li', { class: `o-row ${app.model.selectedId === o.id ? 'sel' : ''}`, role: 'option', 'aria-selected': String(app.model.selectedId === o.id), tabindex: '0' },
        nameEl,
        button(o.visible ? 'Hide' : 'Show', () => app.setVisible(o.id, !o.visible), { icon: o.visible ? ICON.eye : ICON.eyeOff, class: 'icon-only ghost', title: `${o.visible ? 'Hide' : 'Show'} ${o.name}` }),
        button(o.locked ? 'Unlock' : 'Lock', () => app.setLocked(o.id, !o.locked), { icon: o.locked ? ICON.lock : ICON.unlock, class: `icon-only ghost ${o.locked ? 'on' : ''}`, title: `${o.locked ? 'Unlock' : 'Lock'} ${o.name}` }));
      li.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button,input')) return; app.select(o.id); });
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { app.select(o.id); e.preventDefault(); } });
      list.appendChild(li);
    }
    if (!app.model.objects.length) list.appendChild(h('li', { class: 'empty' }, 'Empty. Add a shape, open a file, or make 3D from a photo.'));
    const sel = app.selected;
    return h('div', null, list, h('div', { class: 'btn-row' },
      button('Add sphere', () => app.addPrimitive('sphere', 3), { icon: ICON.plus, class: 'small' }),
      sel ? button('Duplicate', () => app.duplicateObject(sel.id), { icon: ICON.copy, class: 'small' }) : null,
      sel ? button('Delete', () => app.deleteObject(sel.id), { icon: ICON.trash, class: 'small danger' }) : null));
  }

  private referencePanel() {
    const app = this.app;
    return h('div', { class: 'refs' }, ...app.references.map((r) => {
      const op = h('input', { type: 'range', min: '0.05', max: '1', step: '0.05', value: String(r.record.opacity), 'aria-label': `${r.record.name} opacity` });
      op.addEventListener('input', () => app.updateReference(r.record.id, { opacity: +op.value }));
      const view = h('select', { 'aria-label': `${r.record.name} side` }, ...['front', 'back', 'left', 'right', 'top'].map((v) => h('option', { value: v, selected: r.record.view === v }, v)));
      view.addEventListener('change', () => app.updateReference(r.record.id, { view: view.value }));
      return h('div', { class: 'ref-row' },
        h('strong', null, r.record.name),
        h('div', { class: 'ref-ctl' }, view, op,
          button(r.record.visible ? 'Hide' : 'Show', () => app.updateReference(r.record.id, { visible: !r.record.visible }), { icon: r.record.visible ? ICON.eye : ICON.eyeOff, class: 'icon-only ghost' }),
          button('Look from here', () => app.viewport.setView(r.record.view as any), { class: 'small ghost' }),
          button('Remove', () => app.removeReference(r.record.id), { icon: ICON.trash, class: 'icon-only ghost' })));
    }), h('p', { class: 'hint' }, 'Guides only — never exported.'));
  }

  private renderTransformValues() {
    const o = this.app.selected;
    if (!o) return;
    const r = o.mesh.rotation;
    const vals = { position: o.mesh.position.toArray(), rotation: [r.x, r.y, r.z].map((v) => THREE.MathUtils.radToDeg(v)), scale: o.mesh.scale.toArray() };
    for (const inp of document.querySelectorAll<HTMLInputElement>('.xyz input')) {
      if (document.activeElement === inp) continue;
      const v = (vals as any)[inp.dataset.part!][+inp.dataset.axis!];
      inp.value = inp.dataset.part === 'rotation' ? v.toFixed(1) : v.toFixed(3);
    }
  }

  // ───────────────────────── HUD / toasts / overlays ─────────────────────────

  renderStatus() { this.renderHud(); }

  private renderHud() {
    if (!this.hudVisible) return;
    const app = this.app, vp = app.viewport, fs = vp.stats(), t = app.model.totals();
    const gm = app.perf.geometryMs.slice().sort((a, b) => a - b);
    const mem = (performance as any).memory;
    const row = (k: string, v: string) => h('div', { class: 'hud-row' }, h('span', null, k), h('b', null, v));
    replace(this.els.hud,
      h('div', { class: 'hud-title' }, 'Diagnostics'),
      row('Frame p50 / p95', fs.p50 ? `${fs.p50.toFixed(1)} / ${fs.p95.toFixed(1)} ms` : '—'),
      row('Scene', `${t.triangles.toLocaleString()} tris · ${t.objects} obj`),
      row('Draw calls', String(fs.drawCalls)),
      row('Dab update p95', gm.length ? `${gm[Math.floor(gm.length * 0.95)].toFixed(2)} ms` : '—'),
      row('Last stroke', app.lastStrokeStats.dabs ? `${app.lastStrokeStats.dabs} dabs · ${app.lastStrokeStats.verts} verts` : '—'),
      row('History', `${app.history.size} · ${fmtBytes(app.history.bytes)}`),
      row('Input', `${app.penSeen ? 'pen seen' : 'no pen yet'} · palm ${app.autoPalmRejection ? 'on' : 'off'}`),
      row('JS heap', mem ? fmtBytes(mem.usedJSHeapSize) : 'n/a'),
      row('Renderer', `WebGL${vp.renderer.capabilities.isWebGL2 ? '2' : '1'} · DPR ${vp.renderer.getPixelRatio().toFixed(2)}`),
    );
  }

  private renderToasts() {
    const app = this.app;
    replace(this.els.toasts, ...app.toasts.map((t) => h('div', { class: `toast t-${t.kind}`, role: t.kind === 'error' ? 'alert' : 'status' },
      h('div', { class: 't-text' }, t.text),
      t.detail?.length ? h('ul', null, ...t.detail.map((d) => h('li', null, d))) : null,
      h('button', { type: 'button', class: 'btn icon-only ghost', 'aria-label': 'Dismiss', onclick: () => app.dismissToast(t.id), html: ICON.close }))));
    const last = app.toasts[app.toasts.length - 1];
    if (last) (document.getElementById('announcer')!).textContent = last.text;
  }

  private contextOverlay(lost: boolean) {
    const id = 'ctx-lost';
    document.getElementById(id)?.remove();
    if (lost) this.els.viewWrap.appendChild(h('div', { class: 'ctx-lost', id, role: 'alert' }, h('strong', null, 'Graphics paused'), h('p', null, 'The GPU reset. Your sculpture is safe and the view resumes automatically.'), button('Save project file', () => void this.app.saveProjectFile(), { icon: ICON.save })));
  }

  showCapabilityNote(note: string | null) {
    document.getElementById('cap-note')?.remove();
    if (note) this.els.viewWrap.appendChild(h('div', { class: 'cap-note', id: 'cap-note' }, note, h('button', { type: 'button', class: 'btn icon-only ghost', 'aria-label': 'Dismiss', html: ICON.close, onclick: () => document.getElementById('cap-note')?.remove() })));
  }

  // ───────────────────────── files / drop ─────────────────────────

  async handleFiles(files: File[]) {
    if (!files.length) return;
    const project = files.find((f) => /\.formengine$/i.test(f.name));
    if (project) return this.app.openProjectFile(project);
    const models = files.filter((f) => isModelFile(f) || /\.(bin|mtl)$/i.test(f.name) || (!isImageFile(f) && /\.(png|jpe?g|webp|ktx2|basis)$/i.test(f.name)));
    const images = files.filter(isImageFile);
    if (files.some(isModelFile)) { await this.app.importFiles([...models, ...images]); return; }
    if (images.length) return handleImageFiles(this.app, images);
    this.app.toast('error', `Can’t open ${files.map((f) => f.name).join(', ')}`, ['3D models: .glb .gltf .obj .stl .ply', 'Photos: .png .jpg .webp', 'Projects: .formengine']);
  }

  private setupDrop() {
    let depth = 0;
    this.root.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; this.els.drop.hidden = false; e.preventDefault(); } });
    this.root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    this.root.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; this.els.drop.hidden = true; } });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; this.els.drop.hidden = true;
      const files = [...(e.dataTransfer?.files ?? [])];
      const big = files.find((f) => f.size > LIMITS.maxFileBytes);
      if (big) return this.app.toast('error', `${big.name} is larger than ${LIMITS.maxFileBytes / 1e6} MB.`);
      void this.handleFiles(files);
    });
    // presentation: any tap exits
    this.els.viewWrap.addEventListener('pointerdown', () => { if (this.presentation) this.togglePresentation(); }, { capture: true });
  }

  // ───────────────────────── keyboard ─────────────────────────

  private setupKeys() {
    const app = this.app;
    window.addEventListener('keydown', (e) => {
      if (isTyping(e) || document.querySelector('dialog[open]')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? app.redo() : app.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); app.redo(); return; }
      if (mod && k === 's') { e.preventDefault(); void app.saveProjectFile(); return; }
      if (mod && k === 'e') { e.preventDefault(); openExportDialog(app); return; }
      if (mod && k === 'k') { e.preventDefault(); openCommandPalette(app, this); return; }
      if (mod && k === 'd') { e.preventDefault(); if (app.selected) app.duplicateObject(app.selected.id); return; }
      if (mod || e.altKey) return;
      if (e.key === 'Escape') { if (this.presentation) this.togglePresentation(); else if (app.stroke) app.cancelStroke(); else if (this.sheetOpen) this.closeSheet(); return; }
      if (this.presentation) return;
      if (e.key === '?') { openHelp(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { if (app.selected) app.deleteObject(app.selected.id); return; }
      if (e.key === '[' || e.key === ']') {
        const up = e.key === ']';
        if (e.shiftKey) app.updateSettings({ strength: app.settings.strength + (up ? 0.05 : -0.05) });
        else app.updateSettings({ radius: app.settings.radius * (up ? 1.15 : 1 / 1.15) });
        return;
      }
      if (e.shiftKey) {
        if (k === 'f') return app.setBrush('flatten');
        if (k === 'p') return this.togglePresentation();
        if (k === 'w') { app.viewport.setWireframe(!app.viewport.wireframe); return; }
        return;
      }
      if (app.tool === 'transform' && (k === 'w' || k === 'e' || k === 'r')) return app.setTransformMode(k === 'w' ? 'translate' : k === 'e' ? 'rotate' : 'scale');
      if (BRUSH_KEYS[k]) return app.setBrush(BRUSH_KEYS[k]);
      switch (k) {
        case 'v': return app.setTool('select');
        case 't': return app.setTool('transform');
        case 'f': return app.viewport.frame(app.selected);
        case 'x': return app.setSymmetry({ x: !app.symmetry.x });
        case 'i': return app.updateSettings({ invert: !app.settings.invert });
        case 'h': return this.toggleHud();
        case 'o': (document.getElementById('file-open') as HTMLInputElement).click(); return;
        case 'tab': e.preventDefault(); return this.sheetOpen ? this.closeSheet() : this.openSheet(this.sheetTab);
        case '1': return app.viewport.setView('front');
        case '3': return app.viewport.setView('right');
        case '7': return app.viewport.setView('top');
        case '0': return app.viewport.setView('iso');
        case '5': app.viewport.setOrthographic(!app.viewport.isOrtho); return;
      }
    });
  }

  /** First-run walkthrough on the live starter sphere (skippable). */
  showOnboarding() {
    if (localStorageGet('onboarded') === '2') return;
    const coarse = matchMedia('(pointer: coarse)').matches;
    const steps: [string, string][] = coarse ? [
      ['Sculpt', 'Draw on the clay with your S Pen (or a finger). Press harder for a stronger stroke; hold the pen’s side button to push in instead of out.'],
      ['Move around', 'One finger on the background turns the view. Two fingers pan and pinch to zoom. Once you use the pen, fingers only move the view.'],
      ['Undo', 'Tap with two fingers to undo, three fingers to redo. Size and Strength are the tall sliders at the side.'],
      ['Keep it', 'Your work saves on this device automatically. Menu → Install puts FORM//ENGINE on your home screen, full screen.'],
    ] : [
      ['Sculpt', 'Drag across the clay. Size and Strength are the tall sliders at the side; I inverts the brush.'],
      ['Move around', 'Drag the background to orbit, right-drag to pan, scroll to zoom. F frames the object.'],
      ['Brushes', 'B Draw · C Clay · S Smooth · G Grab · M Mask. More brushes are under “More”.'],
      ['Keep it', 'Work saves on this device automatically. Export writes GLB/OBJ/STL with your edits.'],
    ];
    let i = 0;
    const card = h('div', { class: 'onboard', role: 'dialog', 'aria-label': 'Quick start' });
    const render = () => {
      const [t, d] = steps[i];
      replace(card, h('div', { class: 'ob-step' }, `${i + 1} of ${steps.length}`), h('h3', null, t), h('p', null, d), h('div', { class: 'btn-row' },
        button('Skip', () => done(), { class: 'ghost' }),
        button(i < steps.length - 1 ? 'Next' : 'Start sculpting', () => { if (i < steps.length - 1) { i++; render(); } else done(); }, { class: 'accent' })));
    };
    const done = () => { card.remove(); localStorageSet('onboarded', '2'); };
    render();
    this.els.viewWrap.appendChild(card);
  }

  dispose() { clearInterval(this.hudTimer); this.input.dispose(); this.app.dispose(); clear(this.root); }
}

export function localStorageGet(k: string) { try { return localStorage.getItem(`fe:${k}`); } catch { return null; } }
export function localStorageSet(k: string, v: string) { try { localStorage.setItem(`fe:${k}`, v); } catch { /* storage blocked */ } }
export { dialog };
