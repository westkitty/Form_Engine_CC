import type { App } from '../app/App';
import type { Shell } from './Shell';
import { h, dialog, replace } from './dom';
import { openImageLab } from './ImageLab';
import { openExportDialog } from './ExportDialog';
import { openGallery } from './Gallery';
import { BRUSH_INFO, type BrushType } from '../sculpt/brushes';

export function openCommandPalette(app: App, shell: Shell) {
  const cmds: [string, () => void][] = [
    ['New sphere', () => app.addPrimitive('sphere', 3)],
    ['New cube', () => app.addPrimitive('cube', 2)],
    ['Import file…', () => (document.getElementById('file-open') as HTMLInputElement).click()],
    ['Open Image Lab', () => openImageLab(app)],
    ['Export GLB / OBJ / STL…', () => openExportDialog(app)],
    ['Save project file', () => void app.saveProjectFile()],
    ['Local projects…', () => void openGallery(app)],
    ['Toggle X symmetry', () => app.setSymmetry({ x: !app.symmetry.x })],
    ...(Object.keys(BRUSH_INFO) as BrushType[]).map((b) => [`Brush: ${BRUSH_INFO[b].label}`, () => app.setBrush(b)] as [string, () => void]),
    ['Subdivide selected', () => app.subdivide()],
    ['Decimate selected to 50%', () => void app.decimate(0.5)],
    ['Diagnostics HUD', () => shell.toggleHud()],
    ['Presentation mode', () => shell.togglePresentation()],
    ['Frame selection', () => app.viewport.frame(app.selected)],
    ['Undo', () => app.undo()],
    ['Redo', () => app.redo()],
    ['Keyboard shortcuts', () => openHelp()],
  ];
  const d = dialog('Commands', { id: 'palette' });
  const q = h('input', { type: 'search', placeholder: 'Type a command…', 'aria-label': 'Search commands', class: 'palette-q' });
  const list = h('ul', { class: 'palette', role: 'listbox' });
  let idx = 0;
  const filtered = () => cmds.filter(([n]) => n.toLowerCase().includes(q.value.toLowerCase()));
  const render = () => {
    const f = filtered();
    idx = Math.min(idx, Math.max(0, f.length - 1));
    replace(list, ...f.map(([n, fn], i) => h('li', { role: 'option', 'aria-selected': String(i === idx), class: i === idx ? 'on' : '', onclick: () => { d.close(); fn(); } }, n)));
  };
  q.addEventListener('input', () => { idx = 0; render(); });
  q.addEventListener('keydown', (e) => {
    const f = filtered();
    if (e.key === 'ArrowDown') { idx = (idx + 1) % Math.max(1, f.length); render(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { idx = (idx - 1 + f.length) % Math.max(1, f.length); render(); e.preventDefault(); }
    if (e.key === 'Enter' && f[idx]) { d.close(); f[idx][1](); }
  });
  d.body.append(q, list);
  render();
  q.focus();
}

export function openHelp() {
  const d = dialog('Shortcuts & gestures', { wide: true, id: 'help' });
  const table = (rows: [string, string][]) => h('table', { class: 'keys' }, h('tbody', null, ...rows.map(([k, v]) => h('tr', null, h('th', null, h('kbd', null, k)), h('td', null, v)))));
  d.body.append(h('div', { class: 'help-cols' },
    h('div', null, h('h3', null, 'Tools & brushes'), table([
      ['V', 'Select'], ['T', 'Transform gizmo (W move · E rotate · R scale)'], ['B', 'Sculpt: Draw'], ['C', 'Clay Build'], ['N', 'Inflate'], ['S', 'Smooth'], ['G', 'Grab'],
      ['Shift+F', 'Flatten'], ['P', 'Pinch'], ['E', 'Crease'], ['M', 'Mask'], ['I', 'Invert brush'], ['X', 'Toggle X symmetry'],
      ['[  ]', 'Brush radius'], ['Shift+[  ]', 'Brush strength'], ['R', 'Reference tool'],
    ])),
    h('div', null, h('h3', null, 'View & project'), table([
      ['F', 'Frame selection'], ['1 / 3 / 7', 'Front / right / top'], ['0', 'Isometric'], ['5', 'Ortho / perspective'], ['Shift+W', 'Wireframe'], ['H', 'Diagnostics'], ['Tab', 'Object panel'], ['Shift+P', 'Turntable (Esc exits)'],
      ['Ctrl/⌘+Z', 'Undo'], ['Ctrl/⌘+Shift+Z, Ctrl+Y', 'Redo'], ['Ctrl/⌘+S', 'Save project file'], ['Ctrl/⌘+E', 'Export'], ['Ctrl/⌘+K', 'Command palette'], ['Ctrl/⌘+D', 'Duplicate'], ['Del', 'Delete object'], ['O', 'Import'], ['?', 'This help'],
    ])),
    h('div', null, h('h3', null, 'S Pen & touch'), table([
      ['Pen on the clay', 'Sculpt; press harder for more'], ['Pen + side button', 'Push in instead of out (invert)'], ['Pen hovering', 'Shows the brush ring'],
      ['One finger on background', 'Turn the view'], ['Two fingers', 'Pan and pinch-zoom'], ['Two-finger tap', 'Undo'], ['Three-finger tap', 'Redo'],
      ['After using the pen', 'Fingers only move the view (palm rejection; change in Brush settings)'], ['Side sliders', 'Size and Strength'],
    ])),
    h('div', null, h('h3', null, 'Mouse'), table([
      ['Left-drag on mesh', 'Sculpt'], ['Left-drag on background', 'Orbit'], ['Right-drag', 'Pan'], ['Wheel', 'Zoom'], ['Alt+drag · Space+drag', 'Orbit even over the mesh'], ['Esc', 'Cancel the stroke / close panel'],
    ])),
  ));
}
