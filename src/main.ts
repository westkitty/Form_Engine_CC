import './styles/app.css';
import { App } from './app/App';
import { Shell, localStorageGet } from './ui/Shell';
import { h } from './ui/dom';

/** Runtime capability probe — what this surface (browser tab, PWA, embedded artifact iframe) really allows. */
export async function detectCapabilities() {
  const c: Record<string, boolean | string> = {};
  try { const cv = document.createElement('canvas'); c.webgl2 = !!cv.getContext('webgl2'); } catch { c.webgl2 = false; }
  c.pointerEvents = 'PointerEvent' in window;
  c.coalescedEvents = 'PointerEvent' in window && 'getCoalescedEvents' in PointerEvent.prototype;
  c.workers = typeof Worker !== 'undefined';
  c.indexedDB = false;
  try { await new Promise<void>((res, rej) => { const r = indexedDB.open('fe-probe'); r.onsuccess = () => { r.result.close(); res(); }; r.onerror = () => rej(r.error); }); c.indexedDB = true; } catch { /* blocked */ }
  try { c.opfs = !!(await navigator.storage?.getDirectory?.()); } catch { c.opfs = false; }
  c.downloadAttr = 'download' in HTMLAnchorElement.prototype;
  c.clipboard = !!navigator.clipboard;
  c.createImageBitmap = typeof createImageBitmap === 'function';
  let framed = false;
  try { framed = window.self !== window.top; } catch { framed = true; }
  c.embedded = framed;
  try { const e = await navigator.storage?.estimate?.(); c.storageQuota = e?.quota ? `${Math.round(e.quota / 1e6)} MB` : 'unknown'; } catch { c.storageQuota = 'unknown'; }
  c.secureContext = window.isSecureContext;
  return c;
}

async function boot() {
  const mount = document.getElementById('root')!;
  if (localStorageGet('contrast') === 'high') document.documentElement.dataset.contrast = 'high';
  const caps = await detectCapabilities();
  (window as any).__capabilities = caps;
  if (!caps.webgl2) {
    mount.appendChild(h('div', { class: 'fatal', role: 'alert' },
      h('h1', null, 'FORM//ENGINE needs WebGL 2'),
      h('p', null, 'This browser or embedded preview did not provide a WebGL 2 context, so the 3D editor cannot run here. Try a current Chrome, Edge, Firefox or Safari with hardware acceleration enabled.'),
      h('pre', null, JSON.stringify(caps, null, 2))));
    return;
  }
  const app = new App();
  await app.loadPrefs();
  const shell = new Shell(app, mount);
  // Diagnostic/test handle (no secrets): used by the automated browser tests and the diagnostics panel.
  (window as any).__formengine = { app, shell, caps };
  const notes: string[] = [];
  if (!caps.indexedDB) notes.push('Local autosave unavailable here (IndexedDB blocked) — use Save to download a project file.');
  if (caps.embedded) notes.push('Embedded preview: downloads, storage or network may be restricted by the host sandbox.');
  shell.showCapabilityNote(notes.length ? notes.join(' ') : null);
  const params = new URLSearchParams(location.search);
  const restored = params.has('fresh') ? false : await app.restoreLast();
  if (!restored) app.newProject(true);
  shell.renderInspector();
  if (!params.has('fresh')) shell.showOnboarding();
  if ('serviceWorker' in navigator && import.meta.env.PROD && location.protocol === 'https:' && !caps.embedded) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => { /* offline support is optional */ });
  }
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('root')!.appendChild(h('div', { class: 'fatal', role: 'alert' }, h('h1', null, 'Startup failed'), h('pre', null, String(e?.stack ?? e))));
});
