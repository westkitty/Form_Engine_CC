type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: Partial<CSSStyleDeclaration> | string };

/** Minimal hyperscript. Text is always set via textNodes (never innerHTML) so untrusted names are safe. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') { if (typeof v === 'string') el.setAttribute('style', v); else Object.assign(el.style, v); }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html') el.innerHTML = String(v); // only for trusted static SVG icons
      else if (k in el && typeof v !== 'string') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element) { while (el.firstChild) el.removeChild(el.firstChild); }

export function replace(el: Element, ...children: Child[]) { clear(el); append(el, children); }

/** Slider + numeric input pair with clamping, units, and reset-to-default on double-click. */
export function sliderField(opts: { id: string; label: string; min: number; max: number; step: number; value: number; unit?: string; def?: number; log?: boolean; onInput: (v: number) => void; hint?: string }) {
  const toSlider = (v: number) => (opts.log ? Math.log(v) : v);
  const fromSlider = (v: number) => (opts.log ? Math.exp(v) : v);
  const range = h('input', { type: 'range', id: opts.id, min: String(toSlider(opts.min)), max: String(toSlider(opts.max)), step: opts.log ? 'any' : String(opts.step), value: String(toSlider(opts.value)), 'aria-label': opts.label });
  const num = h('input', { type: 'number', min: String(opts.min), max: String(opts.max), step: String(opts.step), value: fmt(opts.value), 'aria-label': `${opts.label} value`, class: 'num' });
  const set = (v: number, from: 'range' | 'num' | 'ext') => {
    const c = Math.min(opts.max, Math.max(opts.min, v));
    if (from !== 'range') range.value = String(toSlider(c));
    if (from !== 'num') num.value = fmt(c);
    return c;
  };
  range.addEventListener('input', () => opts.onInput(set(fromSlider(+range.value), 'range')));
  num.addEventListener('change', () => { const v = parseFloat(num.value); if (Number.isFinite(v)) opts.onInput(set(v, 'num')); else num.value = fmt(fromSlider(+range.value)); });
  const lab = h('label', { for: opts.id, title: opts.hint ?? 'Double-click to reset' }, opts.label);
  lab.addEventListener('dblclick', () => { if (opts.def !== undefined) opts.onInput(set(opts.def, 'ext')); });
  const row = h('div', { class: 'field slider' }, lab, h('div', { class: 'slider-row' }, range, num, opts.unit ? h('span', { class: 'unit' }, opts.unit) : null));
  return { row, set: (v: number) => { if (document.activeElement !== range && document.activeElement !== num) set(v, 'ext'); } };
}

function fmt(v: number) { return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); }

export function button(label: string, onClick: () => void, opts: { icon?: string; title?: string; class?: string; pressed?: boolean; disabled?: boolean; key?: string; id?: string } = {}) {
  const b = h('button', {
    type: 'button', class: `btn ${opts.class ?? ''}`, title: opts.title ?? (opts.key ? `${label} (${opts.key})` : label), 'aria-label': opts.title ?? label, onclick: onClick,
    'aria-pressed': opts.pressed === undefined ? undefined : String(opts.pressed), disabled: opts.disabled, id: opts.id,
  });
  if (opts.icon) b.appendChild(h('span', { class: 'ico', 'aria-hidden': 'true', html: opts.icon }));
  if (!opts.class?.includes('icon-only')) b.appendChild(h('span', { class: 'lbl' }, label));
  return b;
}

/** Native <dialog> wrapper with title bar and close button. */
export function dialog(title: string, opts: { wide?: boolean; onClose?: () => void; id?: string } = {}) {
  const body = h('div', { class: 'dlg-body' });
  const foot = h('div', { class: 'dlg-foot' });
  const close = h('button', { type: 'button', class: 'btn icon-only ghost', 'aria-label': 'Close dialog', html: ICON.close });
  const dlg = h('dialog', { class: `dlg ${opts.wide ? 'wide' : ''}`, 'aria-label': title, id: opts.id }, h('div', { class: 'dlg-head' }, h('h2', null, title), close), body, foot);
  const shut = () => { dlg.close(); };
  close.addEventListener('click', shut);
  dlg.addEventListener('close', () => { opts.onClose?.(); dlg.remove(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) shut(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  return { dlg, body, foot, close: shut };
}

export const ICON = {
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12h-2" transform="translate(0 -5)"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 12h2" transform="translate(0 -5)"/></svg>',
  select: '<svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 2-3 6z"/></svg>',
  move: '<svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>',
  sculpt: '<svg viewBox="0 0 24 24"><path d="M4 20c4-1 6-4 7-8l6-6a2 2 0 013 3l-6 6c-4 1-7 3-8 7"/><circle cx="7.5" cy="16.5" r="1.2"/></svg>',
  mask: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/></svg>',
  inspect: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v10H3z"/></svg>',
  export: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5M4 15v5h16v-5"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.1A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3.2 3.8M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 004-.9"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 017.5-2"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M4 16V4h12"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-1 .6-1.5 1.2-1.5 2.5M12 17h.01"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/></svg>',
  frame: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><circle cx="12" cy="12" r="3"/></svg>',
  cube: '<svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>',
  library: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
  panel: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
  command: '<svg viewBox="0 0 24 24"><path d="M9 6a3 3 0 10-3 3h12a3 3 0 10-3-3v12a3 3 0 103-3H6a3 3 0 103 3z"/></svg>',
};
