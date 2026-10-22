/**
 * App-install and full-screen support.
 *
 * On Android (Chrome, Samsung Internet) an installed PWA becomes a WebAPK: a real app icon that launches
 * in its own full-screen window (manifest `display: fullscreen`). Chrome only offers install when the
 * manifest has PNG icons (192 and 512 px), a start URL, a standalone-type display mode and a service
 * worker, all of which this build provides. `beforeinstallprompt` lets us offer an in-app Install button.
 */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Call as early as possible (before the app UI exists) so the event is not missed. */
export function initInstall() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallEvent; emit(); });
  window.addEventListener('appinstalled', () => { deferred = null; installed = true; emit(); });
}

export function runningAsApp() {
  if ((window as any).FormEngineAndroid) return true; // native Android wrapper
  return matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}

export function installState(): 'installed' | 'available' | 'manual' {
  if (installed || runningAsApp()) return 'installed';
  return deferred ? 'available' : 'manual';
}

export async function promptInstall() {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  await e.prompt();
  const r = await e.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
  emit();
  return r.outcome === 'accepted';
}

export function onInstallChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }

export function fullscreenSupported() {
  return !!document.documentElement.requestFullscreen && document.fullscreenEnabled && !matchMedia('(display-mode: fullscreen)').matches;
}
export function isFullscreen() { return !!document.fullscreenElement; }
export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch { /* the browser refused (no user gesture or not allowed in this frame) */ }
}

/** Files opened with the installed app from the OS (desktop file handlers / share targets). */
export function consumeLaunchFiles(open: (files: File[]) => void) {
  const lq = (window as any).launchQueue;
  if (!lq?.setConsumer) return;
  lq.setConsumer(async (params: { files?: { getFile: () => Promise<File> }[] }) => {
    if (!params.files?.length) return;
    open(await Promise.all(params.files.map((f) => f.getFile())));
  });
}
