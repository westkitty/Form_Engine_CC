import * as THREE from 'three';
import { App, fmtBytes, type Tool } from '../app/App';
import { SculptInput, isTyping } from '../app/SculptInput';
import { BRUSH_INFO, defaultSettings, type BrushType, type FalloffType } from '../sculpt/brushes';
import { PRIMITIVE_LABELS, type PrimitiveKind } from '../geometry/topology';
import { VIEW_MODE_LABELS, type ViewMode } from '../viewport/materials';
import { h, replace, sliderField, button, ICON, dialog, clear } from './dom';
import { openImageLab, handleImageFiles } from './ImageLab';
import { openExportDialog } from './ExportDialog';
import { openGallery } from './Gallery';
import { openCommandPalette, openHelp } from './Palette';
import { isImageFile, isModelFile } from '../io/importers';
import { LIMITS } from '../io/validate';

const BRUSHES: BrushType[] = ['draw', 'clay', 'inflate', 'smooth', 'grab', 'flatten', 'pinch', 'crease', 'mask'];
const BRUSH_KEYS: Record<string, BrushType> = { b: 'draw', c: 'clay', n: 'inflate', s: 'smooth', g: 'grab', p: 'pinch', e: 'crease', m: 'mask' };

/** Builds and wires the workbench interface around the viewport. */
export class Shell {
  readonly root: HTMLElement;
  input!: SculptInput;
  private els: Record<string, HTMLElement> = {};
  private brushFields: { radius?: ReturnType<typeof sliderField>; strength?: ReturnType<typeof sliderField>; spacing?: ReturnType<typeof sliderField> } = {};
  private hudVisible = false;
  private presentation = false;
  private statusTimer = 0;

  constructor(readonly app: App, mountPoint: HTMLElement) {
    this.root = h('div', { class: 'app', id: 'app' });
    mountPoint.appendChild(this.root);
    this.build();
  }

  private build() {
    const app = this.app;
    const top = h('header', { class: 'topbar', role: 'banner' });
    const rail = h('nav', { class: 'rail', 'aria-label': 'Tools' });
    const viewWrap = h('main', { class: 'viewport', id: 'viewport', 'aria-label': 'Sculpting viewport' });
    const insp = h('aside', { class: 'inspector', id: 'inspector', 'aria-label': 'Inspector' });
    const status = h('footer', { class: 'statusbar', role: 'status', 'aria-live': 'off' });
    const toasts = h('div', { class: 'toasts', role: 'log', 'aria-live': 'polite' });
    const announcer = h('div', { class: 'sr-only', 'aria-live': 'assertive', id: 'announcer' });
    this.root.append(top, rail, viewWrap, insp, status, toasts, announcer);
    Object.assign(this.els, { top, rail, viewWrap, insp, status, toasts });

    app.mount(viewWrap);
    this.input = new SculptInput(app, viewWrap);
    app.viewport.onContextChange = (lost) => this.contextOverlay(lost);

    // viewport overlays
    const hud = h('div', { class: 'hud', id: 'hud', hidden: true });
    const drop = h('div', { class: 'dropzone', hidden: true }, h('div', null, h('strong', null, 'Drop to import'), h('span', null, 'Models: GLB · glTF (+bin/textures) · OBJ (+MTL) · STL · PLY — Images: PNG · JPEG · WebP → Image Lab')));
    const viewBar = h('div', { class: 'viewbar', role: 'toolbar', 'aria-label': 'View' });
    viewWrap.append(hud, drop, viewBar);
    Object.assign(this.els, { hud, drop, viewBar });

    this.buildTop();
    this.buildRail();
    this.buildViewBar();
    this.renderInspector();
    this.renderStatus();
    this.setupDrop();
    this.setupKeys();

    app.on((what) => {
      if (what === 'toast') return this.renderToasts();
      if (what === 'save' || what === 'history' || what === 'stroke') { this.renderTopState(); this.scheduleStatus(); }
      if (what === 'transform') return this.renderTransformValues();
      if (what === 'brush') return this.syncBrushFields();
      if (['tool', 'scene', 'project', 'references', 'display', 'history'].includes(what)) { this.renderRail(); this.renderInspector(); this.renderTopState(); this.renderViewBar(); }
    });
    app.viewport.onAfterRender = () => { if (this.hudVisible) this.scheduleStatus(); };
    this.statusTimer = window.setInterval(() => this.renderStatus(), 1000);
    window.addEventListener('beforeunload', (e) => { if (app.dirty) { void app.autosaveNow(); e.preventDefault(); } });
  }

  // ───────────────────────── top bar ─────────────────────────

  private buildTop() {
    const app = this.app;
    const name = h('input', { class: 'proj-name', value: app.projectName, 'aria-label': 'Project name', maxlength: '80', spellcheck: 'false' });
    name.addEventListener('change', () => { app.projectName = name.value.trim().slice(0, 80) || 'Untitled sculpture'; app.markDirty(); app.emit('project'); });
    const saveDot = h('span', { class: 'save-state', id: 'save-state' });
    const undo = button('Undo', () => app.undo(), { icon: ICON.undo, class: 'icon-only', key: 'Ctrl+Z', id: 'btn-undo' });
    const redo = button('Redo', () => app.redo(), { icon: ICON.redo, class: 'icon-only', key: 'Ctrl+Shift+Z', id: 'btn-redo' });
    const fileOpen = h('input', { type: 'file', hidden: true, multiple: true, id: 'file-open', accept: '.glb,.gltf,.bin,.obj,.mtl,.stl,.ply,.png,.jpg,.jpeg,.webp,.formengine' });
    fileOpen.addEventListener('change', () => { const files = [...(fileOpen.files ?? [])]; fileOpen.value = ''; void this.handleFiles(files); });
    const more = h('div', { class: 'menu-wrap' });
    const menuBtn = button('Project', () => this.toggleMenu(more), { icon: ICON.library, title: 'Project menu' });
    menuBtn.setAttribute('aria-haspopup', 'menu');
    more.append(menuBtn);
    this.els.projName = name;
    replace(this.els.top,
      h('div', { class: 'brand', 'aria-label': 'FORM//ENGINE' }, h('span', { class: 'brand-mark' }, 'FORM'), h('span', { class: 'brand-sep' }, '//'), h('span', { class: 'brand-mark2' }, 'ENGINE')),
      h('div', { class: 'proj' }, name, saveDot),
      h('div', { class: 'top-group' }, undo, redo),
      h('div', { class: 'top-group grow' },
        more,
        button('Import', () => fileOpen.click(), { icon: ICON.open, title: 'Import model, image or project (O)', id: 'btn-import' }),
        button('Save', () => void app.saveProjectFile(), { icon: ICON.save, title: 'Download project file .formengine (Ctrl+S)', id: 'btn-save' }),
        button('Export', () => openExportDialog(app), { icon: ICON.export, title: 'Export GLB / OBJ / STL (Ctrl+E)', id: 'btn-export' }),
        button('Image → 3D', () => openImageLab(app), { icon: ICON.image, title: 'Image Lab: references, relief, reconstruction', class: 'accent', id: 'btn-imagelab' }),
      ),
      h('div', { class: 'top-group' },
        button('Commands', () => openCommandPalette(app, this), { icon: ICON.command, class: 'icon-only hide-narrow', key: 'Ctrl+K' }),
        button('Help', () => openHelp(), { icon: ICON.help, class: 'icon-only hide-narrow', key: '?' }),
        button('Inspector', () => this.root.classList.toggle('insp-open'), { icon: ICON.panel, class: 'icon-only only-narrow', title: 'Toggle inspector panel' }),
      ),
      fileOpen,
    );
    this.renderTopState();
  }

  private toggleMenu(wrap: HTMLElement) {
    const existing = wrap.querySelector('.menu');
    if (existing) { existing.remove(); return; }
    const app = this.app;
    const item = (label: string, fn: () => void, hint?: string) => h('button', { type: 'button', role: 'menuitem', class: 'menu-item', onclick: () => { menu.remove(); fn(); } }, h('span', null, label), hint ? h('kbd', null, hint) : null);
    const menu = h('div', { class: 'menu', role: 'menu' },
      item('New project (starter sphere)', () => app.newProject(true)),
      item('New empty project', () => app.newProject(false)),
      item('Local projects…', () => void openGallery(app)),
      item('Open project / import file…', () => (document.getElementById('file-open') as HTMLInputElement).click(), 'O'),
      item('Save project file (.formengine)', () => void app.saveProjectFile(), 'Ctrl+S'),
      item('Recover last autosave', () => void app.restoreLast()),
      item('Export GLB / OBJ / STL…', () => openExportDialog(app), 'Ctrl+E'),
      item('Image Lab…', () => openImageLab(app)),
      item('Command palette', () => openCommandPalette(app, this), 'Ctrl+K'),
      item('Shortcuts & gestures', () => openHelp(), '?'),
      h('hr'),
      ...(['sphere', 'uvsphere', 'cube', 'cylinder', 'torus', 'plane'] as PrimitiveKind[]).map((k) => item(`Add ${PRIMITIVE_LABELS[k]}`, () => app.addPrimitive(k, 3))),
    );
    wrap.appendChild(menu);
    (menu.firstElementChild as HTMLElement)?.focus();
    const off = (e: Event) => { if (!wrap.contains(e.target as Node)) { menu.remove(); document.removeEventListener('pointerdown', off, true); } };
    document.addEventListener('pointerdown', off, true);
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll<HTMLElement>('.menu-item')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); e.preventDefault(); }
      if (e.key === 'Escape') { menu.remove(); (wrap.firstElementChild as HTMLElement).focus(); }
    });
  }

  private renderTopState() {
    const app = this.app;
    const s = document.getElementById('save-state');
    if (s) {
      const label = { idle: 'Not saved yet', pending: 'Unsaved changes', saving: 'Saving…', saved: `Autosaved ${app.lastSavedAt ? new Date(app.lastSavedAt).toLocaleTimeString() : ''}`, error: 'Autosave failed', unavailable: 'Local storage unavailable — use Save' }[app.saveState];
      s.textContent = label;
      s.dataset.state = app.saveState;
    }
    const pn = this.els.projName as HTMLInputElement;
    if (pn && document.activeElement !== pn) pn.value = app.projectName;
    (document.getElementById('btn-undo') as HTMLButtonElement | null)?.toggleAttribute('disabled', !app.history.canUndo);
    (document.getElementById('btn-redo') as HTMLButtonElement | null)?.toggleAttribute('disabled', !app.history.canRedo);
  }

  // ───────────────────────── tool rail ─────────────────────────

  private buildRail() { this.renderRail(); }
  private renderRail() {
    const app = this.app;
    const tool = (t: Tool, label: string, icon: string, key: string) => button(label, () => app.setTool(t), { icon, pressed: app.tool === t && !(t === 'sculpt' && app.brush === 'mask'), key, class: 'rail-btn', id: `tool-${t}` });
    replace(this.els.rail,
      tool('select', 'Select', ICON.select, 'V'),
      tool('transform', 'Move', ICON.move, 'T'),
      tool('sculpt', 'Sculpt', ICON.sculpt, 'B'),
      button('Mask', () => app.setBrush('mask'), { icon: ICON.mask, pressed: app.tool === 'sculpt' && app.brush === 'mask', key: 'M', class: 'rail-btn', id: 'tool-mask' }),
      tool('reference', 'Refs', ICON.image, 'R'),
      tool('inspect', 'Inspect', ICON.inspect, 'Shift+I'),
      h('div', { class: 'rail-spacer' }),
      button('Add', () => this.toggleMenu(document.querySelector('.menu-wrap')!), { icon: ICON.plus, class: 'rail-btn', title: 'Add primitive / project menu' }),
    );
  }

  // ───────────────────────── view bar ─────────────────────────

  private buildViewBar() { this.renderViewBar(); }
  private renderViewBar() {
    const app = this.app, vp = app.viewport;
    const sel = h('select', { 'aria-label': 'Surface view mode', class: 'compact' }, ...(Object.keys(VIEW_MODE_LABELS) as ViewMode[]).map((m) => h('option', { value: m, selected: vp.viewMode === m }, VIEW_MODE_LABELS[m])));
    sel.addEventListener('change', () => app.setViewMode(sel.value as ViewMode));
    replace(this.els.viewBar,
      button('Frame', () => vp.frame(app.selected), { icon: ICON.frame, class: 'icon-only ghost', key: 'F' }),
      button('Front', () => vp.setView('front'), { class: 'ghost tiny', key: '1' }),
      button('Right', () => vp.setView('right'), { class: 'ghost tiny', key: '3' }),
      button('Top', () => vp.setView('top'), { class: 'ghost tiny', key: '7' }),
      button('Iso', () => vp.setView('iso'), { class: 'ghost tiny', key: '0' }),
      button(vp.isOrtho ? 'Ortho' : 'Persp', () => { vp.setOrthographic(!vp.isOrtho); this.renderViewBar(); }, { class: 'ghost tiny', key: '5', pressed: vp.isOrtho, title: 'Toggle orthographic (5)' }),
      button('Wire', () => { vp.setWireframe(!vp.wireframe); this.renderViewBar(); }, { class: 'ghost tiny', pressed: vp.wireframe, key: 'Shift+W' }),
      sel,
      button('Present', () => this.togglePresentation(), { icon: ICON.play, class: 'icon-only ghost', key: 'Shift+P', title: 'Presentation mode (Shift+P, Esc to exit)' }),
      button('HUD', () => this.toggleHud(), { class: 'ghost tiny', pressed: this.hudVisible, key: 'H', title: 'Diagnostics HUD (H)' }),
    );
  }

  togglePresentation() {
    this.presentation = !this.presentation;
    this.root.classList.toggle('presenting', this.presentation);
    this.app.viewport.turntable = this.presentation;
    this.app.viewport.transform.detach();
    if (!this.presentation) { this.app.model.root.rotation.y = 0; this.app.setTool(this.app.tool); }
    this.app.viewport.placeCursor(null);
    setTimeout(() => this.app.viewport.resize(), 0);
  }

  toggleHud() { this.hudVisible = !this.hudVisible; this.els.hud.hidden = !this.hudVisible; this.renderViewBar(); this.renderStatus(); }

  // ───────────────────────── inspector ─────────────────────────

  renderInspector() {
    const app = this.app;
    const sel = app.selected;
    const sections: HTMLElement[] = [];
    sections.push(this.sceneSection());
    if (app.tool === 'sculpt') sections.push(this.brushSection());
    if (sel && (app.tool === 'transform' || app.tool === 'select')) sections.push(this.transformSection(sel.id));
    if (app.tool === 'reference' || app.references.length) sections.push(this.referenceSection());
    sections.push(this.displaySection());
    if (sel) sections.push(this.geometrySection(sel.id));
    if (sel) sections.push(this.provenanceSection(sel.id));
    const scrollTop = this.els.insp.scrollTop;
    replace(this.els.insp, h('button', { type: 'button', class: 'drawer-handle only-narrow', 'aria-label': 'Close inspector', onclick: () => this.root.classList.remove('insp-open') }, h('span')), ...sections);
    this.els.insp.scrollTop = scrollTop;
  }

  private section(title: string, id: string, ...content: (Node | null)[]) {
    const open = localStorageGet(`sec:${id}`) !== '0';
    const d = h('details', { class: 'sec', open, id: `sec-${id}` }, h('summary', null, title), h('div', { class: 'sec-body' }, ...content));
    d.addEventListener('toggle', () => localStorageSet(`sec:${id}`, d.open ? '1' : '0'));
    return d;
  }

  private sceneSection() {
    const app = this.app;
    const list = h('ul', { class: 'outliner', role: 'listbox', 'aria-label': 'Scene objects' });
    for (const o of app.model.objects) {
      const nameEl = h('span', { class: 'o-name', title: 'Double-click to rename' }, o.name);
      nameEl.addEventListener('dblclick', () => {
        const inp = h('input', { value: o.name, class: 'rename', 'aria-label': 'New name', maxlength: '80' });
        nameEl.replaceWith(inp); inp.focus(); inp.select();
        const done = () => app.renameObject(o.id, inp.value);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = o.name; inp.blur(); } });
        inp.addEventListener('blur', done);
      });
      const li = h('li', { class: `o-row ${app.model.selectedId === o.id ? 'sel' : ''}`, role: 'option', 'aria-selected': String(app.model.selectedId === o.id), tabindex: '0' },
        h('span', { class: `o-kind k-${o.provenance.source}`, title: o.provenance.source }, o.provenance.source === 'reconstruction' ? 'AI' : o.provenance.source === 'depth' ? 'DEP' : o.provenance.source === 'relief' ? '2.5D' : o.provenance.source === 'import' ? 'IMP' : '◯'),
        nameEl,
        h('span', { class: 'o-tris' }, shortNum(o.editable.triangleCount)),
        button(o.visible ? 'Hide' : 'Show', () => app.setVisible(o.id, !o.visible), { icon: o.visible ? ICON.eye : ICON.eyeOff, class: 'icon-only ghost tiny', title: `${o.visible ? 'Hide' : 'Show'} ${o.name}` }),
        button(o.locked ? 'Unlock' : 'Lock', () => app.setLocked(o.id, !o.locked), { icon: o.locked ? ICON.lock : ICON.unlock, class: `icon-only ghost tiny ${o.locked ? 'on' : ''}`, title: `${o.locked ? 'Unlock' : 'Lock'} ${o.name}` }),
      );
      li.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button,input')) return; app.select(o.id); });
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { app.select(o.id); e.preventDefault(); } });
      list.appendChild(li);
    }
    if (!app.model.objects.length) list.appendChild(h('li', { class: 'empty' }, 'Empty scene — add a primitive, import a model, or open the Image Lab.'));
    const sel = app.selected;
    return this.section('Scene', 'scene', list, h('div', { class: 'btn-row' },
      button('Sphere', () => app.addPrimitive('sphere', 3), { icon: ICON.plus, class: 'small' }),
      button('Cube', () => app.addPrimitive('cube', 2), { icon: ICON.cube, class: 'small' }),
      sel ? button('Duplicate', () => app.duplicateObject(sel.id), { icon: ICON.copy, class: 'small', key: 'Ctrl+D' }) : null,
      sel ? button('Delete', () => app.deleteObject(sel.id), { icon: ICON.trash, class: 'small danger', key: 'Del' }) : null,
    ));
  }

  private brushSection() {
    const app = this.app;
    const s = app.settings;
    const grid = h('div', { class: 'brush-grid', role: 'radiogroup', 'aria-label': 'Brush' }, ...BRUSHES.map((b) => {
      const info = BRUSH_INFO[b];
      const key = Object.entries(BRUSH_KEYS).find(([, v]) => v === b)?.[0]?.toUpperCase() ?? (b === 'flatten' ? '⇧F' : '');
      return h('button', { type: 'button', role: 'radio', 'aria-checked': String(app.brush === b), class: `brush ${app.brush === b ? 'on' : ''} b-${b}`, title: `${info.label} — ${info.summary}${key ? ` (${key})` : ''}`, onclick: () => app.setBrush(b), id: `brush-${b}` },
        h('span', { class: 'b-glyph', 'aria-hidden': 'true' }), h('span', { class: 'b-name' }, info.label), key ? h('kbd', null, key) : null);
    }));
    const d = defaultSettings(app.brush);
    this.brushFields.radius = sliderField({ id: 'f-radius', label: 'Radius', min: 0.0005, max: 500, step: 0.0005, value: s.radius, unit: app.units, def: d.radius, log: true, onInput: (v) => app.updateSettings({ radius: v }), hint: 'World-space radius ([ and ] to change)' });
    this.brushFields.strength = sliderField({ id: 'f-strength', label: 'Strength', min: 0, max: 1, step: 0.01, value: s.strength, def: d.strength, onInput: (v) => app.updateSettings({ strength: v }), hint: 'Shift+[ / Shift+]' });
    this.brushFields.spacing = sliderField({ id: 'f-spacing', label: 'Spacing', min: 0.02, max: 1, step: 0.01, value: s.spacing, unit: '× r', def: d.spacing, onInput: (v) => app.updateSettings({ spacing: v }) });
    const falloff = h('select', { id: 'f-falloff', 'aria-label': 'Falloff' }, ...(['smooth', 'sphere', 'linear', 'sharp', 'constant'] as FalloffType[]).map((f) => h('option', { value: f, selected: s.falloff === f }, f)));
    falloff.addEventListener('change', () => app.updateSettings({ falloff: falloff.value as FalloffType }));
    const chk = (id: string, label: string, val: boolean, fn: (v: boolean) => void, title?: string) => {
      const c = h('input', { type: 'checkbox', id, checked: val });
      c.addEventListener('change', () => fn(c.checked));
      return h('label', { class: 'chk', for: id, title }, c, label);
    };
    const sym = h('div', { class: 'sym', role: 'group', 'aria-label': 'Symmetry' }, h('span', { class: 'mini-label' }, 'Symmetry'),
      ...(['x', 'y', 'z'] as const).map((ax) => button(ax.toUpperCase(), () => app.setSymmetry({ [ax]: !app.symmetry[ax] }), { pressed: app.symmetry[ax], class: `tiny toggle ax-${ax}`, title: `Mirror across local ${ax.toUpperCase()} = 0${ax === 'x' ? ' (X)' : ''}`, id: `sym-${ax}` })));
    return this.section('Brush', 'brush', grid,
      h('p', { class: 'hint' }, BRUSH_INFO[app.brush].summary),
      this.brushFields.radius.row, this.brushFields.strength.row,
      h('div', { class: 'field two' }, h('label', { for: 'f-falloff' }, 'Falloff'), falloff),
      this.brushFields.spacing.row,
      h('div', { class: 'chk-row' },
        chk('f-invert', app.brush === 'mask' ? 'Erase' : 'Invert', s.invert, (v) => app.updateSettings({ invert: v }), 'Reverse the brush direction (I)'),
        chk('f-pressure', 'Pen pressure', s.pressure, (v) => app.updateSettings({ pressure: v }), 'Scale strength by stylus pressure when reported'),
        app.brush === 'smooth' ? chk('f-boundary', 'Protect boundaries', s.protectBoundary, (v) => app.updateSettings({ protectBoundary: v })) : null,
      ),
      sym,
      h('div', { class: 'btn-row' },
        button('Clear mask', () => app.maskAll('clear'), { class: 'small' }),
        button('Invert mask', () => app.maskAll('invert'), { class: 'small' }),
        button('Defaults', () => app.updateSettings(defaultSettings(app.brush)), { class: 'small ghost', title: 'Reset this brush to its default settings' }),
      ),
      h('div', { class: 'chk-row' }, chk('f-penonly', 'Pen-only sculpt (touch navigates)', app.penOnlySculpt, (v) => { app.penOnlySculpt = v; app.persistPrefs(); })),
    );
  }

  private syncBrushFields() {
    const s = this.app.settings;
    this.brushFields.radius?.set(s.radius);
    this.brushFields.strength?.set(s.strength);
    this.brushFields.spacing?.set(s.spacing);
    for (const ax of ['x', 'y', 'z'] as const) document.getElementById(`sym-${ax}`)?.setAttribute('aria-pressed', String(this.app.symmetry[ax]));
    const inv = document.getElementById('f-invert') as HTMLInputElement | null;
    if (inv) inv.checked = s.invert;
    this.scheduleStatus();
  }

  private transformSection(id: string) {
    const app = this.app;
    const o = app.model.get(id)!;
    const rows: HTMLElement[] = [];
    const parts: ['position' | 'rotation' | 'scale', string][] = [['position', 'Position'], ['rotation', 'Rotation °'], ['scale', 'Scale']];
    for (const [part, label] of parts) {
      const inputs = [0, 1, 2].map((ax) => {
        const inp = h('input', { type: 'number', step: part === 'rotation' ? '1' : '0.01', class: `num ax-${'xyz'[ax]}`, 'aria-label': `${label} ${'XYZ'[ax]}`, 'data-part': part, 'data-axis': String(ax) });
        inp.addEventListener('change', () => app.setTransformNumeric(id, part, ax as 0 | 1 | 2, parseFloat(inp.value)));
        return inp;
      });
      rows.push(h('div', { class: 'field xyz' }, h('span', { class: 'mini-label' }, label), ...inputs));
    }
    const sec = this.section('Transform', 'transform',
      app.tool === 'transform' ? h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Gizmo mode' }, ...(['translate', 'rotate', 'scale'] as const).map((m, i) => button(['Move (W)', 'Rotate (E)', 'Scale (R)'][i], () => app.setTransformMode(m), { pressed: app.transformMode === m, class: 'tiny' }))) : h('p', { class: 'hint' }, 'Press T for the transform gizmo.'),
      ...rows,
      h('div', { class: 'btn-row' }, button('Reset transform', () => app.resetTransform(id), { class: 'small ghost' }), o.locked ? h('span', { class: 'hint' }, 'Locked — unlock to transform or sculpt.') : null),
    );
    queueMicrotask(() => this.renderTransformValues());
    return sec;
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

  private referenceSection() {
    const app = this.app;
    const list = h('div', { class: 'refs' });
    for (const r of app.references) {
      const op = h('input', { type: 'range', min: '0.05', max: '1', step: '0.05', value: String(r.record.opacity), 'aria-label': `${r.record.name} opacity` });
      op.addEventListener('input', () => app.updateReference(r.record.id, { opacity: +op.value }));
      const view = h('select', { 'aria-label': `${r.record.name} view` }, ...['front', 'back', 'left', 'right', 'top'].map((v) => h('option', { value: v, selected: r.record.view === v }, v)));
      view.addEventListener('change', () => app.updateReference(r.record.id, { view: view.value }));
      list.appendChild(h('div', { class: 'ref-row' },
        h('div', { class: 'ref-head' }, h('strong', null, r.record.name), h('span', { class: 'tag' }, 'guide · not exported')),
        h('div', { class: 'ref-ctl' }, view, op,
          button(r.record.visible ? 'Hide' : 'Show', () => app.updateReference(r.record.id, { visible: !r.record.visible }), { icon: r.record.visible ? ICON.eye : ICON.eyeOff, class: 'icon-only ghost tiny' }),
          button('Align camera', () => { app.viewport.setView((r.record.view as any) === 'back' ? 'back' : (r.record.view as any)); }, { class: 'tiny ghost', title: 'Look along this reference view' }),
          button('Remove', () => app.removeReference(r.record.id), { icon: ICON.trash, class: 'icon-only ghost tiny' })),
      ));
    }
    if (!app.references.length) list.appendChild(h('p', { class: 'hint' }, 'No reference images. Drop a photo or open the Image Lab to place front/side guides for manual sculpting.'));
    return this.section('Reference images', 'refs', list, button('Open Image Lab', () => openImageLab(app), { icon: ICON.image, class: 'small' }));
  }

  private displaySection() {
    const app = this.app, vp = app.viewport;
    const grid = h('input', { type: 'checkbox', id: 'd-grid', checked: vp.grid.visible });
    grid.addEventListener('change', () => { vp.grid.visible = grid.checked; vp.ground.visible = grid.checked; vp.requestRender(); });
    const units = h('select', { id: 'd-units', 'aria-label': 'Scene units' }, ...(['m', 'cm', 'mm', 'in'] as const).map((u) => h('option', { value: u, selected: app.units === u }, u)));
    units.addEventListener('change', () => { app.units = units.value as any; app.markDirty(); this.renderInspector(); });
    const contrast = h('input', { type: 'checkbox', id: 'd-contrast', checked: document.documentElement.dataset.contrast === 'high' });
    contrast.addEventListener('change', () => { document.documentElement.dataset.contrast = contrast.checked ? 'high' : ''; localStorageSet('contrast', contrast.checked ? 'high' : ''); });
    return this.section('Display & units', 'display',
      h('div', { class: 'chk-row' }, h('label', { class: 'chk', for: 'd-grid' }, grid, 'Grid & contact shadow'), h('label', { class: 'chk', for: 'd-contrast' }, contrast, 'High-contrast UI')),
      h('div', { class: 'field two' }, h('label', { for: 'd-units' }, 'Scene units'), units),
      h('p', { class: 'hint' }, `Renderer: WebGL${app.viewport.renderer.capabilities.isWebGL2 ? '2' : '1'} · DPR ${app.viewport.renderer.getPixelRatio().toFixed(2)} (cap ${app.viewport.maxDpr})`),
    );
  }

  private geometrySection(id: string) {
    const app = this.app;
    const o = app.model.get(id)!;
    const st = o.editable.stats();
    const size = new THREE.Vector3().fromArray(st.bounds.max).sub(new THREE.Vector3().fromArray(st.bounds.min)).multiply(o.mesh.scale);
    const report = h('div', { class: 'report', id: 'mesh-report' });
    const ratio = h('select', { 'aria-label': 'Decimation target', id: 'dec-ratio' }, ...[0.75, 0.5, 0.25, 0.1].map((r) => h('option', { value: String(r) }, `keep ${Math.round(r * 100)}%`)));
    return this.section('Geometry', 'geometry',
      h('dl', { class: 'stats' },
        h('dt', null, 'Triangles'), h('dd', { id: 'stat-tris' }, st.triangles.toLocaleString()),
        h('dt', null, 'Vertices'), h('dd', null, `${st.vertices.toLocaleString()} (${st.welded.toLocaleString()} welded)`),
        h('dt', null, 'Size'), h('dd', null, `${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)} ${app.units}`),
        h('dt', null, 'Open boundary verts'), h('dd', null, st.boundaryVertices.toLocaleString()),
      ),
      h('div', { class: 'btn-row' },
        button('Subdivide', () => app.subdivide(), { class: 'small', title: 'Midpoint subdivision: 4× triangles, real new vertices (no smoothing)', id: 'btn-subdivide' }),
        ratio, button('Decimate', () => void app.decimate(+ratio.value), { class: 'small', title: 'meshoptimizer quadric simplification (attribute-aware). Clears mask.' }),
      ),
      h('div', { class: 'btn-row' },
        button('Analyze mesh', () => this.renderReport(report, o.id), { class: 'small', icon: ICON.inspect, id: 'btn-analyze' }),
        button('Remove debris', () => app.repair('debris'), { class: 'small ghost', title: 'Delete disconnected shells smaller than 2% of the largest' }),
        button('Flip normals', () => app.repair('flip'), { class: 'small ghost' }),
        button('Center pivot', () => app.repair('recenter'), { class: 'small ghost', title: 'Move geometry so its bounds centre is at the local origin' }),
      ),
      report,
    );
  }

  private renderReport(el: HTMLElement, id: string) {
    const o = this.app.model.get(id);
    if (!o) return;
    const r = this.app.meshReport(o);
    replace(el,
      h('dl', { class: 'stats' },
        h('dt', null, 'Watertight'), h('dd', null, r.watertight ? 'yes' : 'no'),
        h('dt', null, 'Shells'), h('dd', null, String(r.components)),
        h('dt', null, 'Boundary edges'), h('dd', null, String(r.boundaryEdges)),
        h('dt', null, 'Non-manifold edges'), h('dd', null, String(r.nonManifoldEdges)),
        h('dt', null, 'Winding conflicts'), h('dd', null, String(r.inconsistentWinding)),
        h('dt', null, 'Degenerate / thin tris'), h('dd', null, `${r.degenerate} / ${r.thinTriangles}`),
        h('dt', null, 'UVs / colours'), h('dd', null, `${r.hasUV ? 'yes' : 'no'} / ${r.hasColor ? 'yes' : 'no'}`),
      ),
      r.issues.length ? h('ul', { class: 'issues' }, ...r.issues.map((i) => h('li', null, i))) : h('p', { class: 'hint ok' }, 'No topology problems found.'),
      h('p', { class: 'hint' }, 'Why it matters: open boundaries and non-manifold edges break 3D printing and some booleans; inconsistent winding renders inside-out; thin triangles sculpt unevenly.'),
    );
  }

  private provenanceSection(id: string) {
    const o = this.app.model.get(id)!;
    const p = o.provenance;
    return this.section('Provenance', 'provenance',
      h('dl', { class: 'stats' },
        h('dt', null, 'Source'), h('dd', null, p.source),
        p.detail ? [h('dt', null, 'Detail'), h('dd', null, p.detail)] : null,
        p.provider ? [h('dt', null, 'Provider'), h('dd', null, p.provider)] : null,
        p.jobId ? [h('dt', null, 'Task id'), h('dd', { class: 'mono' }, p.jobId)] : null,
        h('dt', null, 'Created'), h('dd', null, new Date(p.createdAt).toLocaleString()),
      ),
      p.inferredWarning ? h('p', { class: 'hint warn' }, p.inferredWarning) : null,
    );
  }

  // ───────────────────────── status / HUD ─────────────────────────

  private statusQueued = false;
  private scheduleStatus() { if (this.statusQueued) return; this.statusQueued = true; requestAnimationFrame(() => { this.statusQueued = false; this.renderStatus(); }); }

  renderStatus() {
    const app = this.app, vp = app.viewport;
    const fs = vp.stats();
    const t = app.model.totals();
    const s = app.settings;
    const gm = app.perf.geometryMs.slice().sort((a, b) => a - b);
    const gp95 = gm.length ? gm[Math.floor(gm.length * 0.95)] : 0;
    replace(this.els.status,
      h('span', { class: 'st' }, `${BRUSH_INFO[app.brush].label} · r ${s.radius.toFixed(3)} ${app.units} · s ${s.strength.toFixed(2)}${s.invert ? ' · inv' : ''}`),
      h('span', { class: 'st' }, `Sym ${(['x', 'y', 'z'] as const).filter((a) => app.symmetry[a]).join('').toUpperCase() || 'off'}`),
      h('span', { class: 'st' }, `${t.triangles.toLocaleString()} tris · ${t.objects} obj`),
      h('span', { class: 'st', id: 'st-frame' }, fs.p50 ? `${fs.fps.toFixed(0)} fps · p95 ${fs.p95.toFixed(1)} ms` : 'idle (render on demand)'),
      h('span', { class: 'st' }, `History ${app.history.size} · ${fmtBytes(app.history.bytes)}`),
      h('span', { class: `st save-${app.saveState}` }, app.saveState === 'saved' ? 'Autosaved' : app.saveState === 'unavailable' ? 'No local storage' : app.saveState === 'error' ? 'Autosave error' : app.dirty ? 'Unsaved' : 'Saved'),
      h('span', { class: 'st grow' }),
      h('span', { class: 'st dim' }, `WebGL${vp.renderer.capabilities.isWebGL2 ? '2' : '1'}`),
    );
    if (this.hudVisible) {
      const mem = (performance as any).memory;
      replace(this.els.hud,
        h('div', { class: 'hud-title' }, 'Diagnostics'),
        hudRow('Frame p50 / p95', fs.p50 ? `${fs.p50.toFixed(1)} / ${fs.p95.toFixed(1)} ms` : '—'),
        hudRow('FPS (while rendering)', fs.p50 ? fs.fps.toFixed(0) : '—'),
        hudRow('Render call p50 (CPU)', fs.renderP50 ? `${fs.renderP50.toFixed(2)} ms` : '—'),
        hudRow('Draw calls', String(fs.drawCalls)),
        hudRow('Rendered tris', fs.triangles.toLocaleString()),
        hudRow('Selected verts', app.selected ? app.selected.editable.vertexCount.toLocaleString() : '—'),
        hudRow('Dab update p95', gm.length ? `${gp95.toFixed(2)} ms` : '—'),
        hudRow('Last stroke', app.lastStrokeStats.dabs ? `${app.lastStrokeStats.dabs} dabs · ${app.lastStrokeStats.verts} verts · ${app.lastStrokeStats.ms.toFixed(0)} ms` : '—'),
        hudRow('Geometries / textures', `${vp.renderer.info.memory.geometries} / ${vp.renderer.info.memory.textures}`),
        hudRow('JS heap', mem ? fmtBytes(mem.usedJSHeapSize) : 'n/a in this browser'),
        hudRow('DPR', `${vp.renderer.getPixelRatio().toFixed(2)}${vp.interacting ? ' (stroke)' : ''}`),
        hudRow('Renderer', `WebGL${vp.renderer.capabilities.isWebGL2 ? '2' : '1'}`),
      );
    }
  }

  // ───────────────────────── toasts / overlays ─────────────────────────

  private renderToasts() {
    const app = this.app;
    replace(this.els.toasts, ...app.toasts.map((t) => h('div', { class: `toast t-${t.kind}`, role: t.kind === 'error' ? 'alert' : 'status' },
      h('div', { class: 't-text' }, h('strong', null, t.kind === 'error' ? 'Error' : t.kind === 'warn' ? 'Note' : t.kind === 'ok' ? 'Done' : 'Info'), ' ', t.text),
      t.detail?.length ? h('ul', null, ...t.detail.map((d) => h('li', null, d))) : null,
      h('button', { type: 'button', class: 'btn icon-only ghost tiny', 'aria-label': 'Dismiss', onclick: () => app.dismissToast(t.id), html: ICON.close }))));
    const last = app.toasts[app.toasts.length - 1];
    if (last) (document.getElementById('announcer')!).textContent = last.text;
  }

  private contextOverlay(lost: boolean) {
    const id = 'ctx-lost';
    document.getElementById(id)?.remove();
    if (lost) this.els.viewWrap.appendChild(h('div', { class: 'ctx-lost', id, role: 'alert' }, h('strong', null, 'Graphics context lost'), h('p', null, 'The GPU reset or ran out of memory. Your geometry is safe in memory; the view will resume when the browser restores the context. You can also Save the project now.'), button('Save project file', () => void this.app.saveProjectFile(), { icon: ICON.save })));
  }

  // ───────────────────────── files / drop ─────────────────────────

  async handleFiles(files: File[]) {
    if (!files.length) return;
    const project = files.find((f) => /\.formengine$/i.test(f.name));
    if (project) return this.app.openProjectFile(project);
    const models = files.filter((f) => isModelFile(f) || /\.(bin|mtl)$/i.test(f.name) || (!isImageFile(f) && /\.(png|jpe?g|webp|ktx2|basis)$/i.test(f.name)));
    const images = files.filter(isImageFile);
    if (files.some(isModelFile)) {
      // textures that accompany a model are resources, not Image Lab inputs
      await this.app.importFiles([...models, ...images]);
      return;
    }
    if (images.length) return handleImageFiles(this.app, images);
    this.app.toast('error', `Unsupported file${files.length > 1 ? 's' : ''}: ${files.map((f) => f.name).join(', ')}`, ['Models: .glb .gltf .obj .stl .ply', 'Images: .png .jpg .webp', 'Projects: .formengine']);
  }

  private setupDrop() {
    const vw = this.root;
    let depth = 0;
    vw.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; this.els.drop.hidden = false; e.preventDefault(); } });
    vw.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    vw.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; this.els.drop.hidden = true; } });
    vw.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; this.els.drop.hidden = true;
      const files = [...(e.dataTransfer?.files ?? [])];
      const big = files.find((f) => f.size > LIMITS.maxFileBytes);
      if (big) return this.app.toast('error', `${big.name} exceeds the ${LIMITS.maxFileBytes / 1e6} MB limit.`);
      void this.handleFiles(files);
    });
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
      if (e.key === 'Escape') { if (this.presentation) this.togglePresentation(); else if (app.stroke) app.cancelStroke(); return; }
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
        if (k === 'w') { app.viewport.setWireframe(!app.viewport.wireframe); this.renderViewBar(); return; }
        if (k === 'i') return app.setTool('inspect');
        return;
      }
      if (app.tool === 'transform' && (k === 'w' || k === 'e' || k === 'r')) return app.setTransformMode(k === 'w' ? 'translate' : k === 'e' ? 'rotate' : 'scale');
      if (BRUSH_KEYS[k]) return app.setBrush(BRUSH_KEYS[k]);
      switch (k) {
        case 'v': return app.setTool('select');
        case 't': return app.setTool('transform');
        case 'r': return app.setTool('reference');
        case 'f': return app.viewport.frame(app.selected);
        case 'x': return app.setSymmetry({ x: !app.symmetry.x });
        case 'i': return app.updateSettings({ invert: !app.settings.invert });
        case 'h': return this.toggleHud();
        case 'o': (document.getElementById('file-open') as HTMLInputElement).click(); return;
        case '1': return app.viewport.setView('front');
        case '3': return app.viewport.setView('right');
        case '7': return app.viewport.setView('top');
        case '0': return app.viewport.setView('iso');
        case '5': app.viewport.setOrthographic(!app.viewport.isOrtho); this.renderViewBar(); return;
      }
    });
  }

  /** First-run walkthrough on the live starter sphere (skippable). */
  showOnboarding() {
    if (localStorageGet('onboarded') === '1') return;
    const steps = [
      ['Sculpt', 'Drag across the clay sphere with the left mouse button, a pen or one finger. The Draw brush raises the surface; hold I to invert.'],
      ['Navigate', 'Drag the background (or right/middle-drag, Alt+drag, Space+drag) to orbit. Two fingers orbit/pan/zoom on touch. F frames the object.'],
      ['Refine', 'Try Smooth (S), Grab (G) and Clay (C). X toggles symmetry. [ and ] change the radius. Ctrl+Z undoes.'],
      ['Keep it', 'Work autosaves locally. Save downloads a portable .formengine project; Export writes GLB/OBJ/STL that keep your edits.'],
    ];
    let i = 0;
    const card = h('div', { class: 'onboard', role: 'dialog', 'aria-label': 'Quick start' });
    const render = () => {
      const [t, d] = steps[i];
      replace(card, h('div', { class: 'ob-step' }, `${i + 1} / ${steps.length}`), h('h3', null, t), h('p', null, d), h('div', { class: 'btn-row' },
        button('Skip', () => done(), { class: 'small ghost' }),
        button(i < steps.length - 1 ? 'Next' : 'Start sculpting', () => { if (i < steps.length - 1) { i++; render(); } else done(); }, { class: 'small accent' })));
    };
    const done = () => { card.remove(); localStorageSet('onboarded', '1'); };
    render();
    this.els.viewWrap.appendChild(card);
  }

  showCapabilityNote(note: string | null) {
    document.getElementById('cap-note')?.remove();
    if (note) this.els.viewWrap.appendChild(h('div', { class: 'cap-note', id: 'cap-note' }, note));
  }

  dispose() { clearInterval(this.statusTimer); this.input.dispose(); this.app.dispose(); clear(this.root); }
}

function hudRow(k: string, v: string) { return h('div', { class: 'hud-row' }, h('span', null, k), h('b', null, v)); }
function shortNum(n: number) { return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n); }
export function localStorageGet(k: string) { try { return localStorage.getItem(`fe:${k}`); } catch { return null; } }
export function localStorageSet(k: string, v: string) { try { localStorage.setItem(`fe:${k}`, v); } catch { /* storage blocked */ } }
export { dialog };
