import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { App } from '../app/App';
import { normalizeImported } from '../app/App';
import { h, replace, button, dialog, ICON } from './dom';
import { loadImageFile, prepareCanvas, canvasToBlob, foregroundBox, ImageIntakeError, type LoadedImage, type Crop } from '../reconstruction/imageIntake';
import { reliefFromImage, DEFAULT_RELIEF, type ReliefOptions } from '../reconstruction/relief';
import { BridgeProvider } from '../reconstruction/bridgeProvider';
import { JobRunner, newJob, transition, TERMINAL, type JobRecord } from '../reconstruction/jobMachine';
import type { ProviderCapabilities, ReconstructionProvider, SourceImage, ViewLabel } from '../reconstruction/types';
import { HfSpaceProvider, TRELLIS_SPACE } from '../reconstruction/hfSpaceProvider';
import { buildDepthShell, DEFAULT_DEPTH_SHELL } from '../reconstruction/depthMesh';
import { estimateDepth, alphaMask, ON_DEVICE_AVAILABLE, DEPTH_MODEL, DEPTH_MODEL_LICENSE, DEPTH_MODEL_SIZE_MB } from '../reconstruction/onDevice';
import { STANDALONE_URL } from '../io/exporters';
import { parseModel, type ImportResult } from '../io/importers';
import { removeDebris, flipWinding } from '../io/validate';
import { newId } from '../scene/SceneModel';
import * as store from '../persistence/idb';

interface LabImage { id: string; name: string; img: LoadedImage; crop: Crop; rotation: 0 | 90 | 180 | 270; view: ViewLabel; thumb: string }

/** Session state of the lab (survives closing the dialog; provider token never leaves memory). */
const lab = {
  images: [] as LabImage[],
  bridgeUrl: '',
  token: '' as string,
  caps: null as ProviderCapabilities | null,
  capsError: '' as string,
  jobs: new Map<string, { job: JobRecord; runner?: JobRunner; result?: ArrayBuffer; fileName?: string }>(),
  relief: { ...DEFAULT_RELIEF } as ReliefOptions,
  remoteSent: false,
  providerNames: new Map<string, string>(),
  moreOpen: false,
  od: { mask: 'auto' as 'auto' | 'depth' | 'full', opts: { ...DEFAULT_DEPTH_SHELL }, texture: true, busy: false, status: '' as string, pct: undefined as number | undefined },
  hf: { token: '', status: '', ok: false, caps: null as ProviderCapabilities | null },
};
let refresh: (() => void) | null = null;

async function loadBridgeUrl() {
  if (lab.bridgeUrl) return;
  try { lab.bridgeUrl = (await store.kvGet<string>('bridgeUrl')) ?? ''; } catch { /* no storage */ }
}

export async function handleImageFiles(app: App, files: File[]) {
  for (const f of files) {
    try {
      const img = await loadImageFile(f);
      const c = prepareCanvas(img, { x: 0, y: 0, w: 1, h: 1 }, 0, 256);
      const views: ViewLabel[] = ['front', 'right', 'back', 'left', 'top'];
      lab.images.push({ id: newId('img'), name: f.name.slice(0, 80), img, crop: { x: 0, y: 0, w: 1, h: 1 }, rotation: 0, view: views[lab.images.length] ?? 'other', thumb: c.toDataURL('image/png') });
    } catch (e) {
      app.toast('error', e instanceof ImageIntakeError ? e.message : `Could not read ${f.name}`);
    }
  }
  openImageLab(app);
}

function provider() { return lab.bridgeUrl ? new BridgeProvider(lab.bridgeUrl, lab.token || null, { local: /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])/.test(lab.bridgeUrl) }) : null; }

async function prepared(li: LabImage, maxSide = 2048): Promise<SourceImage> {
  const c = prepareCanvas(li.img, li.crop, li.rotation, maxSide);
  const blob = await canvasToBlob(c, li.img.hasAlpha);
  return { id: li.id, name: li.name, view: li.view, mime: blob.type, width: c.width, height: c.height, blob };
}

export function openImageLab(app: App) {
  if (document.getElementById('image-lab')) { refresh?.(); return; }
  void loadBridgeUrl().then(() => refresh?.());
  const d = dialog('Photo to 3D', { wide: true, id: 'image-lab', onClose: () => { refresh = null; } });
  const left = h('section', { class: 'lab-col', 'aria-label': 'Source images' });
  const right = h('section', { class: 'lab-col', 'aria-label': 'Modes' });
  const banner = h('div', { class: 'lab-banner', role: 'status' });
  d.body.append(banner, h('div', { class: 'lab' }, left, right));
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true });
  fileIn.addEventListener('change', () => { const f = [...(fileIn.files ?? [])]; fileIn.value = ''; void handleImageFiles(app, f); });
  d.body.append(fileIn);

  refresh = () => {
    replace(banner, lab.remoteSent
      ? h('span', { class: 'remote' }, '● A photo from this session was uploaded to a cloud service, with your consent.')
      : h('span', { class: 'local' }, '● Your photos stay on this device unless you choose a cloud option and confirm.'));
    renderSources(app, left, fileIn);
    renderModes(app, right);
  };
  refresh();
}

function renderSources(app: App, el: HTMLElement, fileIn: HTMLInputElement) {
  const rows = lab.images.map((li, idx) => {
    const view = h('select', { 'aria-label': `${li.name} view` }, ...(['front', 'right', 'back', 'left', 'top', 'other'] as ViewLabel[]).map((v) => h('option', { value: v, selected: li.view === v }, v)));
    view.addEventListener('change', () => { li.view = view.value as ViewLabel; refresh?.(); });
    const inset = (key: 'l' | 't' | 'r' | 'b', label: string) => {
      const val = key === 'l' ? li.crop.x : key === 't' ? li.crop.y : key === 'r' ? 1 - li.crop.x - li.crop.w : 1 - li.crop.y - li.crop.h;
      const inp = h('input', { type: 'range', min: '0', max: '0.45', step: '0.01', value: String(val), 'aria-label': `Crop ${label}` });
      inp.addEventListener('change', () => {
        const v = +inp.value;
        const c = li.crop;
        const l = key === 'l' ? v : c.x, t = key === 't' ? v : c.y, r = key === 'r' ? v : 1 - c.x - c.w, b = key === 'b' ? v : 1 - c.y - c.h;
        li.crop = { x: l, y: t, w: Math.max(0.05, 1 - l - r), h: Math.max(0.05, 1 - t - b) };
        updateThumb(li); refresh?.();
      });
      return h('label', { class: 'crop-ctl' }, label, inp);
    };
    return h('div', { class: 'src' },
      h('img', { src: li.thumb, alt: `Preview of ${li.name}`, class: 'src-thumb' }),
      h('div', { class: 'src-meta' },
        h('strong', null, li.name),
        h('span', { class: 'hint' }, `${li.img.width}×${li.img.height}px · ${(li.img.fileBytes / 1e6).toFixed(2)} MB${li.img.hasAlpha ? ' · alpha' : ''}`),
        h('div', { class: 'src-ctl' }, view,
          button('Rotate 90°', () => { li.rotation = ((li.rotation + 90) % 360) as LabImage['rotation']; updateThumb(li); refresh?.(); }, { class: 'tiny ghost' }),
          button('Fit subject', () => { const c = prepareCanvas(li.img, { x: 0, y: 0, w: 1, h: 1 }, 0, 512); const fb = foregroundBox(c); const pad = 0.03; li.crop = { x: Math.max(0, fb.x - pad), y: Math.max(0, fb.y - pad), w: Math.min(1, fb.w + pad * 2), h: Math.min(1, fb.h + pad * 2) }; updateThumb(li); refresh?.(); }, { class: 'tiny ghost', title: 'Crop to the detected foreground (alpha or border-colour difference)' }),
          button('Remove', () => { lab.images.splice(idx, 1); li.img.bitmap.close(); refresh?.(); }, { icon: ICON.trash, class: 'icon-only ghost tiny' })),
        h('details', null, h('summary', { class: 'hint' }, 'Trim edges'), h('div', { class: 'crop' }, inset('l', 'Left'), inset('t', 'Top'), inset('r', 'Right'), inset('b', 'Bottom'))),
      ));
  });
  const views = new Set(lab.images.map((i) => i.view));
  const missing = (['front', 'right', 'back', 'left'] as ViewLabel[]).filter((v) => !views.has(v));
  replace(el,
    h('h3', null, 'Photos'),
    ...rows,
    lab.images.length ? null : h('p', { class: 'hint' }, 'Add a photo or drawing of one object. A plain or transparent background works best.'),
    h('div', { class: 'btn-row' }, button(lab.images.length ? 'Add another view' : 'Choose photo…', () => fileIn.click(), { icon: ICON.plus, class: lab.images.length ? 'small' : 'accent', id: 'lab-add' })),
    lab.images.length > 1 ? h('p', { class: 'hint' }, missing.length ? `Views missing: ${missing.join(', ')}.` : 'Front, right, back and left views present.') : null,
  );
}

function updateThumb(li: LabImage) { li.thumb = prepareCanvas(li.img, li.crop, li.rotation, 256).toDataURL('image/png'); }

function renderModes(app: App, el: HTMLElement) {
  const has = lab.images.length > 0;

  // Mode 1
  const mode1 = h('div', { class: 'mode' },
    h('h3', null, 'Trace it yourself ', h('span', { class: 'tag' }, 'reference planes')),
    h('p', { class: 'hint' }, 'Places each image as a guide plane behind the model (matching its view). Guides are never exported and nothing is generated — you sculpt the form yourself.'),
    button('Place as reference planes', async () => {
      for (const li of lab.images) { const s = await prepared(li, 2048); await app.addReference(s.blob, { name: li.name, view: li.view === 'other' ? 'front' : li.view }); }
      app.setTool('reference');
      app.toast('ok', `Placed ${lab.images.length} reference image(s).`);
    }, { class: 'small', disabled: !has, id: 'lab-reference' }));
  // Mode 5
  const depth = h('input', { type: 'range', min: '0.02', max: '0.4', step: '0.01', value: String(lab.relief.depth), 'aria-label': 'Relief depth' });
  depth.addEventListener('change', () => { lab.relief.depth = +depth.value; });
  const src = h('select', { 'aria-label': 'Relief height source' }, ...([['luminance-in-alpha', 'Brightness inside subject'], ['luminance', 'Brightness'], ['alpha', 'Silhouette (alpha)']] as const).map(([v, l]) => h('option', { value: v, selected: lab.relief.source === v }, l)));
  src.addEventListener('change', () => { lab.relief.source = src.value as ReliefOptions['source']; });
  const inv = h('input', { type: 'checkbox', checked: lab.relief.invert, id: 'relief-inv' });
  inv.addEventListener('change', () => { lab.relief.invert = inv.checked; });
  const mode5 = h('div', { class: 'mode' },
    h('h3', null, 'Flat relief ', h('span', { class: 'tag warn' }, '2.5D, not full 3D')),
    h('p', { class: 'hint' }, 'Builds a closed relief slab from the first image (brightness → height). Real, editable geometry, but only a height field — there is no inferred back or side.'),
    h('div', { class: 'field two' }, h('label', null, 'Height from'), src),
    h('div', { class: 'field two' }, h('label', null, 'Depth'), depth),
    h('label', { class: 'chk', for: 'relief-inv' }, inv, 'Invert (dark = high)'),
    button('Generate relief mesh', async () => {
      const li = lab.images[0];
      const c = prepareCanvas(li.img, li.crop, li.rotation, 1024);
      const g = await reliefFromImage(c, lab.relief);
      app.addGeometryObject(g, `Relief ${li.name.replace(/\.[^.]+$/, '')}`, { source: 'relief', detail: `2.5D relief from ${li.name} (${lab.relief.source})`, sourceImages: [li.id], createdAt: new Date().toISOString(), inferredWarning: 'Height-field relief derived from image brightness/alpha. Not a 3D reconstruction.' });
      app.toast('ok', 'Relief mesh added. It is labelled 2.5D relief in Provenance.');
    }, { class: 'small', disabled: !has, id: 'lab-relief' }));
  // On-device depth reconstruction (free, private)
  const sub = h('select', { 'aria-label': 'Subject outline', id: 'od-mask' },
    h('option', { value: 'auto', selected: lab.od.mask === 'auto' }, 'Auto (transparency, else depth)'),
    h('option', { value: 'depth', selected: lab.od.mask === 'depth' }, 'Separate by depth'),
    h('option', { value: 'full', selected: lab.od.mask === 'full' }, 'Whole image'));
  sub.addEventListener('change', () => { lab.od.mask = sub.value as typeof lab.od.mask; });
  const rng = (id: string, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void) => {
    const r = h('input', { type: 'range', id, min: String(min), max: String(max), step: String(step), value: String(get()), 'aria-label': label });
    r.addEventListener('change', () => set(+r.value));
    return h('div', { class: 'field two' }, h('label', { for: id }, label), r);
  };
  const texChk = h('input', { type: 'checkbox', id: 'od-tex', checked: lab.od.texture });
  texChk.addEventListener('change', () => { lab.od.texture = texChk.checked; });
  const odStatus = h('div', { class: 'od-status', id: 'od-status', role: 'status' }, lab.od.status ? [lab.od.status, typeof lab.od.pct === 'number' ? h('progress', { max: '100', value: String(lab.od.pct) }) : lab.od.busy ? h('progress') : null] : null);
  const modeOD = h('div', { class: 'mode primary' },
    h('h3', null, 'Make 3D from photo ', h('span', { class: 'tag ok' }, 'free · stays on this device')),
    h('p', { class: 'hint' }, `Turns the first photo into a solid you can sculpt. The front follows the photo; the back is guessed. First use downloads a ${DEPTH_MODEL_SIZE_MB} MB model (Depth Anything V2, ${DEPTH_MODEL_LICENSE}) once.`),
    ON_DEVICE_AVAILABLE ? [
      button(has ? 'Make 3D' : 'Add a photo first', () => void runOnDevice(app), { class: 'accent', disabled: !has || lab.od.busy, id: 'lab-ondevice' }),
      odStatus,
      h('details', { class: 'od-opts' }, h('summary', null, 'Options'),
        h('div', { class: 'field two' }, h('label', { for: 'od-mask' }, 'Subject'), sub),
        rng('od-depth', 'Depth', 0.05, 0.8, 0.05, () => lab.od.opts.depthStrength, (v) => { lab.od.opts.depthStrength = v; }),
        rng('od-back', 'Back depth', 0, 1, 0.05, () => lab.od.opts.backRatio, (v) => { lab.od.opts.backRatio = v; }),
        rng('od-res', 'Detail', 64, 256, 16, () => lab.od.opts.resolution, (v) => { lab.od.opts.resolution = v; }),
        h('label', { class: 'chk', for: 'od-tex' }, texChk, 'Paint the photo onto the front')),
    ] : h('p', { class: 'hint warn' }, `This embedded preview can’t download the model. Open the app: ${STANDALONE_URL}`),
  );
  // Free cloud: TRELLIS Space on Hugging Face
  const hfTok = h('input', { type: 'password', value: lab.hf.token, placeholder: 'optional free token: hf_…', 'aria-label': 'Hugging Face token', autocomplete: 'off', id: 'hf-token' });
  const hfMulti = lab.images.length > 1;
  const hfMode = h('select', { 'aria-label': 'Free cloud mode', id: 'hf-mode' },
    h('option', { value: 'single' }, 'Single image (first image)'),
    h('option', { value: 'multi', disabled: !hfMulti, selected: hfMulti }, `Multi-view (${Math.min(4, lab.images.length)} images)`));
  const modeHF = h('div', { class: 'mode' },
    h('h3', null, 'Full 3D in the cloud ', h('span', { class: 'tag' }, 'free · uploads the photo')),
    h('p', { class: 'hint' }, 'Full 3D (including the back) from TRELLIS, an open model running on a public Hugging Face Space. Free; Hugging Face limits how much GPU time each visitor gets per day. A free Hugging Face account token (huggingface.co/settings/tokens, "Read") gives a larger allowance. The token stays in this tab only. The Space is community-run and may be busy or asleep.'),
    h('div', { class: 'field two' }, h('label', { for: 'hf-token' }, 'HF token'), hfTok),
    lab.hf.status ? h('p', { class: `pill ${lab.hf.ok ? 'on' : 'warn'}`, id: 'hf-status' }, lab.hf.status) : null,
    h('div', { class: 'field two' }, h('label', { for: 'hf-mode' }, 'Mode'), hfMode),
    h('div', { class: 'btn-row' },
      button('Check Space', async () => {
        lab.hf.token = hfTok.value.trim(); lab.hf.status = 'Checking…'; lab.hf.ok = false; refresh?.();
        try { lab.hf.caps = await new HfSpaceProvider(lab.hf.token || null).capabilities(); lab.hf.status = 'Space reachable.'; lab.hf.ok = true; }
        catch (e) { lab.hf.status = (e as Error).message; }
        refresh?.();
      }, { class: 'small', id: 'hf-check' }),
      button('Review & submit…', async () => {
        lab.hf.token = hfTok.value.trim();
        const pr = new HfSpaceProvider(lab.hf.token || null);
        const caps = lab.hf.caps ?? { provider: 'TRELLIS (Hugging Face Space)', modes: ['single', 'multi'], maxImages: 4, progress: 'discrete', cancel: 'any', outputFormats: ['glb'] } as ProviderCapabilities;
        void consentFlow(app, pr, caps, `Hugging Face Space ${TRELLIS_SPACE}`, hfMode.value as 'single' | 'multi', {});
      }, { class: 'small accent', disabled: !has, id: 'hf-submit' })),
  );
  // Mode 2/3
  const urlIn = h('input', { type: 'url', value: lab.bridgeUrl, placeholder: 'http://127.0.0.1:8787', 'aria-label': 'Bridge URL', id: 'bridge-url', spellcheck: 'false' });
  const tokIn = h('input', { type: 'password', value: lab.token, placeholder: 'optional bridge token (kept in memory only)', 'aria-label': 'Bridge token', autocomplete: 'off' });
  const connect = async () => {
    const u = urlIn.value.trim();
    if (u && !/^https?:\/\//.test(u)) { lab.capsError = 'URL must start with http:// or https://'; refresh?.(); return; }
    lab.bridgeUrl = u.replace(/\/+$/, ''); lab.token = tokIn.value; lab.caps = null; lab.capsError = '';
    try { await store.kvSet('bridgeUrl', lab.bridgeUrl); } catch { /* storage optional */ }
    const pr = provider();
    if (pr) {
      try { lab.caps = await pr.capabilities(); } catch (e) { lab.capsError = pr.getError(e).message; }
    }
    refresh?.();
  };
  const connected = !!lab.caps;
  const status = !lab.bridgeUrl ? h('p', { class: 'pill off', id: 'provider-status' }, 'Provider not connected')
    : connected ? h('p', { class: 'pill on', id: 'provider-status' }, `Connected: ${lab.caps!.provider} via ${lab.bridgeUrl}`)
      : h('p', { class: 'pill warn', id: 'provider-status' }, lab.capsError ? `Not connected: ${lab.capsError}` : 'Not tested');
  const multiOk = connected && lab.caps!.modes.includes('multi') && lab.images.length > 1;
  const modeSel = h('select', { 'aria-label': 'Reconstruction mode', id: 'recon-mode' },
    h('option', { value: 'single' }, 'Single image → mesh (first image)'),
    h('option', { value: 'multi', disabled: !multiOk, selected: multiOk }, `Multi-view → mesh (${Math.min(lab.images.length, lab.caps?.maxImages ?? 4)} images)`));
  const tex = h('input', { type: 'checkbox', checked: true, id: 'opt-tex' });
  const mode2 = h('details', { class: 'mode advanced', id: 'bridge-advanced', open: !!lab.bridgeUrl },
    h('summary', null, h('h3', null, 'Advanced · your own reconstruction server ', h('span', { class: 'tag' }, 'self-hosted or paid'))),
    h('p', { class: 'hint' }, 'For a model you run yourself (any server speaking the FORM bridge protocol) or a paid service such as Meshy. Not needed for the free options above.'),
    status,
    h('details', { class: 'connect', open: !connected },
      h('summary', null, connected ? 'Connection settings' : 'Connect Reconstruction'),
      h('p', { class: 'hint' }, 'Reconstruction runs on a real service through a FORM bridge you control (server/reconstruction-proxy.mjs for Meshy, or your own local inference server speaking the same protocol). API keys stay on the bridge — never in this web app. See docs/PROVIDERS.md.'),
      h('div', { class: 'field two' }, h('label', { for: 'bridge-url' }, 'Bridge URL'), urlIn),
      h('div', { class: 'field two' }, h('label', null, 'Bridge token'), tokIn),
      button('Test connection', () => void connect(), { class: 'small', id: 'bridge-test' })),
    connected ? h('div', null,
      h('div', { class: 'field two' }, h('label', { for: 'recon-mode' }, 'Mode'), modeSel),
      h('label', { class: 'chk', for: 'opt-tex' }, tex, 'Request textured output'),
      h('p', { class: 'hint' }, lab.caps!.progress === 'percent' ? 'This provider reports real progress percentages.' : 'This provider only reports states; progress is shown as indeterminate.'),
      button('Review & submit…', () => { const pr = provider(); if (pr && lab.caps) void consentFlow(app, pr, lab.caps, `bridge ${lab.bridgeUrl}`, modeSel.value as 'single' | 'multi', { should_texture: tex.checked }); }, { class: 'small accent', disabled: !has, id: 'recon-submit' }),
    ) : h('p', { class: 'hint' }, 'No server connected. Everything else in the Image Lab works without one.'),
  );
  const more = h('details', { class: 'more-ways', id: 'lab-more', open: lab.moreOpen || !!lab.jobs.size },
    h('summary', null, 'More ways'), mode1, mode5, modeHF, mode2);
  more.addEventListener('toggle', () => { lab.moreOpen = more.open; });
  replace(el, modeOD, more, (lab.jobs.size || app.jobs.length) ? renderJobs(app) : null);
}

async function consentFlow(app: App, pr: ReconstructionProvider, caps: ProviderCapabilities, via: string, mode: 'single' | 'multi', options: Record<string, unknown>) {
  const chosen = mode === 'single' ? lab.images.slice(0, 1) : lab.images.slice(0, caps.maxImages);
  const free = pr instanceof HfSpaceProvider;
  const est = await pr.estimate([], mode);
  const sources = await Promise.all(chosen.map((li) => prepared(li)));
  const total = sources.reduce((s, x) => s + x.blob.size, 0);
  const c = dialog('Confirm upload to reconstruction provider', { id: 'consent' });
  const agree = h('input', { type: 'checkbox', id: 'consent-ok' });
  const consentText = `I consent to sending ${sources.length} image(s) to ${caps.provider} (${via}) for ${mode === 'multi' ? 'multi-view' : 'single-image'} 3D reconstruction.${free ? ' This is free.' : ' This may consume paid credits.'}`;
  c.body.append(
    h('dl', { class: 'stats' },
      h('dt', null, 'Provider'), h('dd', null, `${caps.provider} (${via})`),
      h('dt', null, 'Mode'), h('dd', null, mode === 'multi' ? `Multi-view, ${sources.length} separate images (views: ${sources.map((s) => s.view).join(', ')})` : 'Single image'),
      h('dt', null, 'Data sent'), h('dd', null, `${sources.length} image(s), ${(total / 1e6).toFixed(2)} MB total, cropped/rotated as shown, ≤ 2048 px. No project data, meshes or names are sent.`),
      h('dt', null, 'Cost'), h('dd', null, caps.pricingNote ?? est.costNote),
      h('dt', null, 'Retention'), h('dd', null, caps.retentionNote ?? 'Provider terms apply; FORM//ENGINE cannot delete copies held by the provider.'),
    ),
    h('div', { class: 'consent-thumbs' }, ...chosen.map((li) => h('img', { src: li.thumb, alt: li.name }))),
    h('p', { class: 'hint warn' }, 'Unseen back and side surfaces will be inferred by the model, not measured. Review the result from every angle.'),
    h('label', { class: 'chk', for: 'consent-ok' }, agree, consentText),
  );
  const submit = button('Submit job', async () => {
    if (!agree.checked) return;
    c.close();
    await startJob(app, pr, caps.provider, mode, sources, options, consentText);
  }, { class: 'accent', disabled: true, id: 'consent-submit' });
  agree.addEventListener('change', () => { (submit as HTMLButtonElement).disabled = !agree.checked; });
  c.foot.append(button('Cancel', () => c.close(), { class: 'ghost' }), submit);
}

async function startJob(app: App, pr: ReconstructionProvider, providerName: string, mode: 'single' | 'multi', sources: SourceImage[], options: Record<string, unknown>, consentText: string) {
  lab.providerNames.set(pr.id, providerName);
  let job = newJob(newId('job'), pr.id, mode, sources);
  job = transition(transition(transition(job, 'validating'), 'ready'), 'awaiting-consent');
  const entry: { job: JobRecord; runner?: JobRunner; result?: ArrayBuffer; fileName?: string } = { job };
  const runner = new JobRunner(pr, job, {
    onUpdate: (j) => { entry.job = j; syncLite(app, j); refresh?.(); announce(`Reconstruction job ${j.state}${typeof j.progress === 'number' ? ` ${j.progress}%` : ''}`); },
    verify: async (data, name) => {
      const r = await parseModel(data, name);
      if (!r.meshes.length) throw new Error('no meshes');
      try { await store.kvSet(`jobresult:${entry.job.id}`, new Blob([data])); } catch { /* local copy optional */ }
    },
  });
  entry.runner = runner;
  lab.jobs.set(job.id, entry);
  lab.remoteSent = true;
  refresh?.();
  const final = await runner.submitAndRun(sources, options, consentText);
  if (final.state === 'ready-to-edit') { entry.result = runner.resultBytes!; entry.fileName = runner.resultFileName; app.toast('ok', 'Reconstruction finished and verified. Review it in the Image Lab.'); }
  else if (final.state === 'failed') app.toast('error', `Reconstruction failed: ${final.error?.message ?? 'unknown error'}`, ['Your scene was not changed.']);
  refresh?.();
}

function syncLite(app: App, j: JobRecord) {
  const lite = { id: j.id, provider: j.providerId, mode: j.mode, remoteId: j.remoteId, status: j.state, createdAt: j.createdAt, updatedAt: j.updatedAt, sourceImageIds: j.sourceImageIds, error: j.error?.message, consent: j.consent ? { at: j.consent.at, provider: j.consent.provider, imageCount: j.consent.imageCount } : undefined };
  const i = app.jobs.findIndex((x) => x.id === j.id);
  if (i >= 0) app.jobs[i] = { ...app.jobs[i], ...lite }; else app.jobs.push(lite);
  app.markDirty();
}

function announce(text: string) { const a = document.getElementById('announcer'); if (a) a.textContent = text; }

function renderJobs(app: App) {
  const rows: HTMLElement[] = [];
  // persisted jobs from the project that are not live in this session
  for (const lite of app.jobs) {
    if (lab.jobs.has(lite.id)) continue;
    const resumable = lite.remoteId && !TERMINAL.includes(lite.status as any);
    rows.push(h('div', { class: 'job' },
      h('div', { class: 'job-head' }, h('span', { class: `state s-${lite.status}` }, lite.status), h('span', { class: 'mono' }, lite.remoteId ?? lite.id)),
      h('span', { class: 'hint' }, `${lite.mode} · ${new Date(lite.updatedAt).toLocaleString()}${lite.error ? ` · ${lite.error}` : ''}`),
      h('div', { class: 'btn-row' },
        resumable ? button('Resume polling', () => void resumeJob(app, lite), { class: 'tiny', disabled: !provider() }) : null,
        lite.status === 'ready-to-edit' ? button('Review stored result', () => void reviewStored(app, lite.id), { class: 'tiny' }) : null)));
  }
  for (const [, e] of lab.jobs) {
    const j = e.job;
    const busy = !TERMINAL.includes(j.state) && j.state !== 'offline' && j.state !== 'needs-auth';
    rows.push(h('div', { class: 'job', id: `job-${j.id}` },
      h('div', { class: 'job-head' }, h('span', { class: `state s-${j.state}` }, j.state), h('span', { class: 'mono' }, j.remoteId ?? '(not submitted)')),
      typeof j.progress === 'number' && busy
        ? h('progress', { max: '100', value: String(j.progress), 'aria-label': 'Provider-reported progress' })
        : busy ? h('progress', { 'aria-label': 'Working (provider reports no percentage)' }) : null,
      h('span', { class: 'hint' }, [
        typeof j.queuePosition === 'number' && j.state === 'queued' ? `${j.queuePosition} task(s) ahead · ` : '',
        `${j.mode} · ${j.sourceImageIds.length} image(s) · updated ${new Date(j.updatedAt).toLocaleTimeString()}`,
        j.error ? ` · ${j.error.message}` : '',
      ].join('')),
      h('details', { class: 'job-log' }, h('summary', null, 'State history'), h('ol', null, ...j.history.map((s) => h('li', null, `${new Date(s.at).toLocaleTimeString()} ${s.state}${s.note ? ` — ${s.note}` : ''}`)))),
      h('div', { class: 'btn-row' },
        busy ? button('Cancel', async () => { const note = await e.runner!.cancel(); app.toast('info', note); refresh?.(); }, { class: 'tiny danger' }) : null,
        (j.state === 'offline' || j.state === 'needs-auth') && j.remoteId ? button('Resume', async () => { await e.runner!.resume(); if (e.runner!.resultBytes) { e.result = e.runner!.resultBytes; e.fileName = e.runner!.resultFileName; } refresh?.(); }, { class: 'tiny' }) : null,
        j.state === 'ready-to-edit' && e.result ? button('Review & adopt…', () => openReview(app, e.result!, e.fileName!, j), { class: 'tiny accent', id: `review-${j.id}` }) : null,
        ['failed', 'canceled', 'expired'].includes(j.state) ? h('span', { class: 'hint' }, 'Adjust the images or provider and submit a new job (requires consent again).') : null,
      )));
  }
  return h('div', { class: 'mode jobs' }, h('h3', null, 'Jobs'), rows.length ? h('div', null, ...rows) : h('p', { class: 'hint' }, 'No reconstruction jobs yet.'));
}

async function resumeJob(app: App, lite: { id: string; mode: string; remoteId?: string; status: string; createdAt: string; updatedAt: string; sourceImageIds: string[] }) {
  const pr = provider();
  if (!pr || !lite.remoteId) return;
  const job: JobRecord = { id: lite.id, providerId: pr.id, mode: lite.mode as any, state: 'offline', remoteId: lite.remoteId, sourceImageIds: lite.sourceImageIds, history: [{ state: 'offline', at: new Date().toISOString(), note: 'restored from project' }], createdAt: lite.createdAt, updatedAt: lite.updatedAt };
  const entry: { job: JobRecord; runner?: JobRunner; result?: ArrayBuffer; fileName?: string } = { job };
  entry.runner = new JobRunner(pr, job, {
    onUpdate: (j) => { entry.job = j; syncLite(app, j); refresh?.(); },
    verify: async (data, name) => { const r = await parseModel(data, name); if (!r.meshes.length) throw new Error('no meshes'); try { await store.kvSet(`jobresult:${job.id}`, new Blob([data])); } catch { /* optional */ } },
  });
  lab.jobs.set(job.id, entry);
  await entry.runner.resume();
  if (entry.runner.resultBytes) { entry.result = entry.runner.resultBytes; entry.fileName = entry.runner.resultFileName; }
  refresh?.();
}

async function reviewStored(app: App, id: string) {
  const blob = await store.kvGet<Blob>(`jobresult:${id}`).catch(() => undefined);
  if (!blob) return app.toast('error', 'The stored copy of this result is not available on this device.');
  const lite = app.jobs.find((j) => j.id === id)!;
  openReview(app, await blob.arrayBuffer(), `reconstruction_${id}.glb`, { id, providerId: lite.provider, mode: lite.mode as any, state: 'ready-to-edit', remoteId: lite.remoteId, sourceImageIds: lite.sourceImageIds, history: [], createdAt: lite.createdAt, updatedAt: lite.updatedAt });
}

/** Review a provider-returned mesh before adopting it: stats, submesh choice, repairs, side-by-side with source. */
async function openReview(app: App, data: ArrayBuffer, fileName: string, job: JobRecord) {
  let res: ImportResult;
  try { res = await parseModel(data, fileName); } catch (e) { return app.toast('error', `Result could not be parsed: ${(e as Error).message}`); }
  const r = dialog('Review generated asset', { wide: true, id: 'review' });
  const canvas = h('canvas', { class: 'review-canvas', 'aria-label': 'Generated mesh preview (drag to orbit)' });
  const src = lab.images.find((i) => job.sourceImageIds.includes(i.id));
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x1a1c21);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 1.2)); const dl = new THREE.DirectionalLight(0xffffff, 1.5); dl.position.set(2, 3, 4); scene.add(dl);
  const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  const ctl = new OrbitControls(cam, canvas);
  const grp = new THREE.Group(); scene.add(grp);
  const clone = { ...res, meshes: res.meshes.map((m) => ({ ...m, position: m.position.clone(), quaternion: m.quaternion.clone(), scale: m.scale.clone() })) };
  normalizeImported(clone);
  for (const m of clone.meshes) { const mesh = new THREE.Mesh(m.geometry, new THREE.MeshStandardMaterial({ color: 0xc9b8a3, roughness: 0.6 })); mesh.position.copy(m.position); mesh.quaternion.copy(m.quaternion); mesh.scale.copy(m.scale); grp.add(mesh); }
  cam.position.set(0, 0, 2.6); ctl.update();
  let raf = 0;
  const loop = () => { raf = requestAnimationFrame(loop); const w = canvas.clientWidth, hh = canvas.clientHeight; if (canvas.width !== Math.floor(w * renderer.getPixelRatio())) { renderer.setSize(w, hh, false); cam.aspect = w / Math.max(1, hh); cam.updateProjectionMatrix(); } ctl.update(); renderer.render(scene, cam); };
  loop();
  r.dlg.addEventListener('close', () => { cancelAnimationFrame(raf); ctl.dispose(); renderer.dispose(); grp.traverse((o) => (o as THREE.Mesh).material && ((o as THREE.Mesh).material as THREE.Material).dispose()); });

  const pick = res.meshes.map((m, i) => { const c = h('input', { type: 'checkbox', checked: true, id: `sub-${i}` }); return { c, m, row: h('label', { class: 'chk', for: `sub-${i}` }, c, `${m.name} — ${m.report.triangles.toLocaleString()} tris, ${m.report.components} shell(s)${m.report.watertight ? ', watertight' : ''}`) }; });
  const norm = h('input', { type: 'checkbox', checked: true, id: 'rv-norm' });
  const debris = h('input', { type: 'checkbox', checked: res.meshes.some((m) => m.report.components > 1), id: 'rv-debris' });
  const flip = h('input', { type: 'checkbox', id: 'rv-flip' });
  const rot = h('select', { 'aria-label': 'Rotate about Y' }, ...[0, 90, 180, 270].map((d) => h('option', { value: String(d) }, `${d}°`)));
  const issues = res.meshes.flatMap((m) => m.report.issues.map((i) => `${m.name}: ${i}`));
  r.body.append(h('div', { class: 'review' },
    h('div', { class: 'review-pair' },
      src ? h('figure', null, h('img', { src: src.thumb, alt: 'Source image' }), h('figcaption', null, `Source: ${src.name} (${src.view})`)) : h('figure', null, h('figcaption', null, 'Source image not in this session')),
      h('figure', null, canvas, h('figcaption', null, 'Returned mesh (drag to orbit) — inspect the back and sides')),
    ),
    h('div', null,
      h('p', { class: 'hint warn' }, 'Generated by a provider from 2D input. Geometry not visible in the source images was inferred, not measured.'),
      h('h3', null, 'Submeshes'), ...pick.map((p) => p.row),
      issues.length ? h('ul', { class: 'issues' }, ...issues.slice(0, 10).map((i) => h('li', null, i))) : h('p', { class: 'hint ok' }, 'No topology problems found.'),
      h('h3', null, 'Before adopting'),
      h('label', { class: 'chk', for: 'rv-norm' }, norm, 'Re-centre and scale to 1 unit'),
      h('label', { class: 'chk', for: 'rv-debris' }, debris, 'Remove small disconnected debris'),
      h('label', { class: 'chk', for: 'rv-flip' }, flip, 'Flip winding (if inside-out)'),
      h('div', { class: 'field two' }, h('label', null, 'Rotate Y'), rot),
      h('p', { class: 'hint' }, 'Adopting adds a NEW object version; existing sculpted objects are never overwritten.'),
    )));
  r.foot.append(button('Reject', () => r.close(), { class: 'ghost' }), button('Edit as Sculpt', () => {
    const chosen: ImportResult = { ...res, meshes: pick.filter((p) => p.c.checked).map((p) => p.m) };
    if (!chosen.meshes.length) return app.toast('warn', 'Select at least one submesh.');
    for (const m of chosen.meshes) {
      if (debris.checked) { const d = removeDebris(m.geometry); m.geometry = d.geometry; }
      if (flip.checked) flipWinding(m.geometry);
      if (+rot.value) m.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(+rot.value)));
    }
    if (norm.checked) normalizeImported(chosen);
    app.addImported(chosen, { source: 'reconstruction', provider: lab.providerNames.get(job.providerId) ?? job.providerId, jobId: job.remoteId, sourceImages: job.sourceImageIds, inferredWarning: 'Provider-generated from 2D image(s): unseen surfaces were inferred, not measured.', detail: `${job.mode}-view reconstruction` }, 'Adopt reconstruction');
    app.setTool('sculpt');
    r.close();
    document.getElementById('image-lab')?.querySelector<HTMLButtonElement>('.dlg-head button')?.click();
  }, { class: 'accent', id: 'adopt-btn' }));
}

/** On-device: depth model in this browser → depth shell → new editable, textured object. */
async function runOnDevice(app: App) {
  const li = lab.images[0];
  if (!li || lab.od.busy) return;
  lab.od.busy = true; lab.od.status = 'Preparing image…'; lab.od.pct = undefined; refresh?.();
  const setStatus = (t: string, pct?: number) => { lab.od.status = t; lab.od.pct = pct; const el = document.getElementById('od-status'); if (el) { replace(el, t, typeof pct === 'number' ? h('progress', { max: '100', value: String(pct) }) : h('progress')); } };
  try {
    const canvas = prepareCanvas(li.img, li.crop, li.rotation, 1024);
    const t0 = performance.now();
    const depth = await estimateDepth(canvas, (p) => {
      if (p.phase === 'loading-library') setStatus('Loading the depth engine…');
      else if (p.phase === 'downloading') setStatus(p.total ? `Downloading the model (first time only): ${(p.loaded! / 1e6).toFixed(1)} / ${(p.total / 1e6).toFixed(1)} MB` : 'Downloading the model…', p.total ? Math.round((p.loaded! / p.total) * 100) : undefined);
      else if (p.phase === 'running') setStatus('Estimating depth on this device…');
    });
    const inferMs = performance.now() - t0;
    setStatus('Building the mesh…');
    const mask = lab.od.mask === 'full' ? { data: new Float32Array([1]), width: 1, height: 1 } : lab.od.mask === 'auto' ? alphaMask(canvas) : null;
    const res = buildDepthShell({ depth, mask, aspect: canvas.width / canvas.height }, lab.od.opts);
    let material: THREE.Material | undefined;
    if (lab.od.texture) {
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0, name: 'Photo projection' });
    }
    const outline = lab.od.mask === 'full' ? 'whole image' : res.maskSource === 'alpha' ? 'image transparency' : res.maskSource === 'depth-threshold' ? 'depth separation' : 'whole image (no clear subject found)';
    app.addGeometryObject(res.geometry, `Depth 3D ${li.name.replace(/\.[^.]+$/, '')}`, {
      source: 'depth', detail: `On-device ${DEPTH_MODEL} (${DEPTH_MODEL_LICENSE}); subject from ${outline}; ${res.grid.nx}×${res.grid.ny} grid`,
      sourceImages: [li.id], createdAt: new Date().toISOString(),
      inferredWarning: 'Front surface from an estimated (relative) depth map, not a measurement. Back and sides are inferred. Sculpt to refine.',
    }, material);
    setStatus(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s (depth ${(inferMs / 1000).toFixed(1)} s). Subject from ${outline}.`);
    app.toast('ok', 'Your 3D model is ready. Sculpt it like any other shape.');
    document.getElementById('image-lab')?.querySelector<HTMLButtonElement>('.dlg-head button')?.click();
  } catch (e) {
    setStatus(`Failed: ${(e as Error)?.message ?? e}`);
    app.toast('error', `On-device 3D failed: ${(e as Error)?.message ?? e}`, ['The model download needs an internet connection the first time.', 'Your scene was not changed.']);
  } finally {
    lab.od.busy = false;
    refresh?.();
  }
}
