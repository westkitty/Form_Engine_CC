import type { App } from '../app/App';
import { h, button, dialog, replace } from './dom';
import { DEFAULT_EXPORT, UNIT_TO_M, type ExportOptions, type ExportFormat, type Units } from '../io/exporters';
import { analyzeGeometry } from '../io/validate';

const FORMAT_NOTES: Record<ExportFormat, string> = {
  glb: 'Binary glTF 2.0 — edited positions, normals, UVs, materials and textures (where supported), node transforms. Best for re-use in other apps and engines.',
  obj: 'Wavefront OBJ — geometry, normals and UVs; transforms baked. Materials (.mtl) and textures are NOT written by this exporter.',
  stl: 'STL — triangle surface only, for 3D printing. No colour, UVs or units (values are written in the units you choose below).',
};

export function openExportDialog(app: App) {
  const d = dialog('Export model', { id: 'export-dlg' });
  const opts: ExportOptions = { ...DEFAULT_EXPORT, sceneUnits: app.units, outUnits: app.units };
  let scope: 'selected' | 'visible' = app.selected ? 'selected' : 'visible';
  const summary = h('div', { class: 'export-summary' });

  const radio = <T extends string>(name: string, values: [T, string][], cur: T, fn: (v: T) => void) => h('div', { class: 'seg', role: 'radiogroup', 'aria-label': name }, ...values.map(([v, l]) => {
    const id = `${name}-${v}`;
    const r = h('input', { type: 'radio', name, id, value: v, checked: v === cur });
    r.addEventListener('change', () => { fn(v); render(); });
    return h('label', { for: id, class: 'seg-opt' }, r, l);
  }));

  const render = () => {
    const objs = app.exportTargets(scope);
    const tris = objs.reduce((s, o) => s + o.editable.triangleCount, 0);
    const reports = objs.map((o) => ({ o, r: analyzeGeometry(o.editable.geometry) }));
    const scale = UNIT_TO_M[opts.sceneUnits] / UNIT_TO_M[opts.outUnits];
    replace(summary,
      h('p', { class: 'hint' }, FORMAT_NOTES[opts.format]),
      h('dl', { class: 'stats' },
        h('dt', null, 'Objects'), h('dd', null, objs.length ? objs.map((o) => o.name).join(', ') : 'none'),
        h('dt', null, 'Triangles'), h('dd', null, tris.toLocaleString()),
        h('dt', null, 'Unit scale'), h('dd', null, `${opts.sceneUnits} → ${opts.outUnits} (×${scale})`),
        h('dt', null, 'Transforms'), h('dd', null, opts.format === 'glb' && !opts.applyTransforms ? 'kept as node transforms' : 'baked into vertices'),
      ),
      h('ul', { class: 'issues' }, ...reports.flatMap(({ o, r }) => [
        r.watertight ? null : h('li', null, `${o.name}: not watertight (${r.boundaryEdges} open, ${r.nonManifoldEdges} non-manifold edges)`),
        r.components > 1 ? h('li', null, `${o.name}: ${r.components} disconnected shells`) : null,
        r.degenerate ? h('li', null, `${o.name}: ${r.degenerate} degenerate triangles`) : null,
        r.inconsistentWinding ? h('li', null, `${o.name}: ${r.inconsistentWinding} winding conflicts`) : null,
      ])),
    );
    (go as HTMLButtonElement).disabled = !objs.length;
  };

  const units = (id: string, cur: Units, fn: (u: Units) => void) => {
    const s = h('select', { id }, ...(['m', 'cm', 'mm', 'in'] as Units[]).map((u) => h('option', { value: u, selected: u === cur }, u)));
    s.addEventListener('change', () => { fn(s.value as Units); render(); });
    return s;
  };
  const apply = h('input', { type: 'checkbox', id: 'ex-apply', checked: opts.applyTransforms });
  apply.addEventListener('change', () => { opts.applyTransforms = apply.checked; render(); });
  const mat = h('input', { type: 'checkbox', id: 'ex-clay', checked: opts.materials === 'clay' });
  mat.addEventListener('change', () => { opts.materials = mat.checked ? 'clay' : 'own'; });
  const bin = h('input', { type: 'checkbox', id: 'ex-bin', checked: opts.stlBinary });
  bin.addEventListener('change', () => { opts.stlBinary = bin.checked; });

  d.body.append(
    h('div', { class: 'field' }, h('span', { class: 'mini-label' }, 'Format'), radio<ExportFormat>('ex-format', [['glb', 'GLB'], ['obj', 'OBJ'], ['stl', 'STL']], opts.format, (v) => { opts.format = v; })),
    h('div', { class: 'field' }, h('span', { class: 'mini-label' }, 'Scope'), radio<'selected' | 'visible'>('ex-scope', [['selected', 'Selected object'], ['visible', 'All visible']], scope, (v) => { scope = v; })),
    h('div', { class: 'field two' }, h('label', { for: 'ex-su' }, 'Scene units'), units('ex-su', opts.sceneUnits, (u) => { opts.sceneUnits = u; })),
    h('div', { class: 'field two' }, h('label', { for: 'ex-ou' }, 'Output units'), units('ex-ou', opts.outUnits, (u) => { opts.outUnits = u; })),
    h('div', { class: 'chk-row' },
      h('label', { class: 'chk', for: 'ex-apply' }, apply, 'GLB: bake transforms'),
      h('label', { class: 'chk', for: 'ex-clay' }, mat, 'GLB: plain clay material'),
      h('label', { class: 'chk', for: 'ex-bin' }, bin, 'STL: binary'),
    ),
    h('p', { class: 'hint' }, 'Coordinate system: Y-up, right-handed (glTF convention). Triangulated. Reference images and masks are not exported.'),
    summary,
  );
  const go = button('Export', async () => {
    (go as HTMLButtonElement).disabled = true;
    try { const r = await app.exportModel(scope, opts); if (r) d.close(); }
    catch (e) { app.toast('error', `Export failed: ${(e as Error).message}`); }
    finally { (go as HTMLButtonElement).disabled = false; }
  }, { class: 'accent', id: 'export-go' });
  d.foot.append(button('Cancel', () => d.close(), { class: 'ghost' }), go);
  render();
}
