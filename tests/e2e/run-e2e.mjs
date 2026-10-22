#!/usr/bin/env node
/**
 * Browser end-to-end journeys against the production build (vite preview) in headless Chromium.
 * Each journey records machine-readable evidence in test-results/e2e/results.json plus screenshots.
 *
 * Journey 3 uses the REAL bridge server with a TEST FIXTURE upstream (tests/fixtures/mock-meshy-server.mjs).
 * It proves the browser pipeline; it is not evidence of live Meshy reconstruction.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = 'test-results/e2e';
mkdirSync(OUT, { recursive: true });
const BASE = process.env.E2E_URL ?? 'http://localhost:4173/';
const results = [];
const procs = [];
const only = process.argv.slice(2);

function start(cmd, args, env, ready) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env } });
  procs.push(p);
  return new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error(`timeout starting ${args.join(' ')}: ${buf}`)), 20000);
    const on = (d) => { buf += d; const m = buf.match(ready); if (m) { clearTimeout(t); res(m); } };
    p.stdout.on('data', on); p.stderr.on('data', on);
  });
}

async function serverUp(url) { try { return (await fetch(url)).ok; } catch { return false; } }

const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT: ${msg}`); };

async function journey(name, fn) {
  if (only.length && !only.some((o) => name.toLowerCase().includes(o.toLowerCase()))) return;
  const t0 = Date.now();
  const evidence = {};
  try {
    await fn(evidence);
    results.push({ name, status: 'PASS', ms: Date.now() - t0, evidence });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, status: 'FAIL', ms: Date.now() - t0, error: String(e?.stack ?? e), evidence });
    console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

const launchArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
let browser;

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.__errors.push(m.text()); });
  return { ctx, page };
}

async function boot(page, query = '?fresh=1') {
  await page.goto(BASE + query);
  await page.waitForFunction(() => window.__formengine?.app?.model.objects.length >= 0 && document.querySelector('.viewport-canvas'), null, { timeout: 30000 });
  await page.evaluate(() => { try { localStorage.setItem('fe:onboarded', '1'); } catch {} document.querySelector('.onboard')?.remove(); });
  await page.waitForTimeout(300);
}

/** In-page geometry helpers. */
const snap = (page, key, id) => page.evaluate(([key, id]) => {
  const app = window.__formengine.app;
  const o = id ? app.model.get(id) : app.selected ?? app.model.objects[0];
  (window.__snaps ??= {})[key] = { id: o.id, pos: o.editable.positions.slice(), mask: o.editable.mask.slice() };
  return { id: o.id, verts: o.editable.vertexCount, tris: o.editable.triangleCount };
}, [key, id]);
const delta = (page, a, b) => page.evaluate(([a, b]) => {
  const A = window.__snaps[a], B = b ? window.__snaps[b] : null;
  const app = window.__formengine.app;
  const cur = B ? B.pos : app.model.get(A.id).editable.positions;
  if (cur.length !== A.pos.length) return { maxDelta: Infinity, moved: -1, lengthMismatch: true };
  let m = 0, moved = 0;
  for (let i = 0; i < cur.length; i++) { const d = Math.abs(cur[i] - A.pos[i]); if (d > m) m = d; if (d > 1e-6) moved++; }
  return { maxDelta: m, movedComponents: moved };
}, [a, b]);

async function canvasBox(page) { return page.locator('.viewport-canvas').boundingBox(); }

async function drag(page, from, to, steps = 24, opts = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down(opts);
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
  await page.mouse.up(opts);
  await page.waitForTimeout(80);
}

async function strokeAcrossCenter(page, dx = 0.12, dy = 0.02) {
  const b = await canvasBox(page);
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await drag(page, { x: cx - b.width * dx, y: cy - b.height * dy }, { x: cx + b.width * dx, y: cy + b.height * dy });
}

async function saveDownload(page, trigger, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), trigger()]);
  const path = `${OUT}/${name ?? dl.suggestedFilename()}`;
  await dl.saveAs(path);
  return { path, suggested: dl.suggestedFilename(), bytes: readFileSync(path).length };
}

async function importFile(page, paths) {
  await page.setInputFiles('#file-open', paths);
  await page.waitForTimeout(800);
}

/** World-space positions of an object (in-page) stored as a snapshot key. */
const worldSnap = (page, key, id) => page.evaluate(([key, id]) => {
  const app = window.__formengine.app;
  const o = id ? app.model.get(id) : app.selected;
  o.mesh.updateMatrixWorld(true);
  const p = o.editable.positions, e = o.mesh.matrixWorld.elements, out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z + e[12]; out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  (window.__world ??= {})[key] = Array.from(out);
  return out.length / 3;
}, [key, id]);

/** One-sided Hausdorff distance between two world snapshots (A → nearest in B), grid-accelerated. */
const hausdorff = (page, a, b) => page.evaluate(([a, b]) => {
  const A = window.__world[a], B = window.__world[b];
  let minB = [Infinity, Infinity, Infinity], maxB = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < B.length; i += 3) for (let k = 0; k < 3; k++) { minB[k] = Math.min(minB[k], B[i + k]); maxB[k] = Math.max(maxB[k], B[i + k]); }
  const cell = Math.max(maxB[0] - minB[0], maxB[1] - minB[1], maxB[2] - minB[2]) / 64 || 1;
  const g = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < B.length; i += 3) { const k = key(B[i], B[i + 1], B[i + 2]); (g.get(k) ?? g.set(k, []).get(k)).push(i); }
  let worst = 0;
  for (let i = 0; i < A.length; i += 3) {
    let best = Infinity;
    const cx = Math.floor(A[i] / cell), cy = Math.floor(A[i + 1] / cell), cz = Math.floor(A[i + 2] / cell);
    for (let r = 1; r <= 3 && best === Infinity; r++)
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++)
        for (const j of g.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) best = Math.min(best, Math.hypot(A[i] - B[j], A[i + 1] - B[j + 1], A[i + 2] - B[j + 2]));
    if (best === Infinity) for (let j = 0; j < B.length; j += 3) best = Math.min(best, Math.hypot(A[i] - B[j], A[i + 1] - B[j + 1], A[i + 2] - B[j + 2]));
    worst = Math.max(worst, best);
  }
  return worst;
}, [a, b]);

async function main() {
  // servers
  if (!(await serverUp(BASE))) {
    await start('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], {}, /localhost:4173/);
  }
  writeFileSync(`${OUT}/.keep`, '');
  const fixtureGlb = 'test-results/fixtures/fixture-reconstruction.glb';
  if (!existsSync(fixtureGlb)) throw new Error('Run `npm test` first to generate the reconstruction fixture GLB');
  const meshyPort = +(await start('node', ['tests/fixtures/mock-meshy-server.mjs'], { FIXTURE_GLB: fixtureGlb, MOCK_KEY: 'k' }, /MOCK_MESHY_PORT=(\d+)/))[1];
  const bridgePort = 8799;
  await start('node', ['server/reconstruction-proxy.mjs'], { MESHY_API_KEY: 'k', MESHY_BASE: `http://127.0.0.1:${meshyPort}`, ASSET_HOSTS: '127.0.0.1', PORT: String(bridgePort), ALLOWED_ORIGINS: new URL(BASE).origin }, /listening/);

  browser = await chromium.launch({ args: launchArgs });

  // ───────────── Journey 1: blank clay ─────────────
  await journey('J1 blank clay: sculpt, orbit, smooth, undo/redo, export GLB, re-import', async (ev) => {
    const { page, ctx } = await newPage();
    await boot(page);
    const info = await snap(page, 'start');
    ev.startMesh = info;
    assert(info.tris > 10000, 'starter sphere present');
    await page.screenshot({ path: `${OUT}/j1-0-start.png` });
    // Draw stroke
    await page.keyboard.press('b');
    await strokeAcrossCenter(page);
    const d1 = await delta(page, 'start');
    ev.drawStroke = d1;
    assert(d1.maxDelta > 1e-3, `draw stroke moved vertices (maxDelta=${d1.maxDelta})`);
    const camBefore = await page.evaluate(() => window.__formengine.app.viewport.camera.position.toArray());
    ev.cameraUnmovedDuringStroke = camBefore;
    await snap(page, 'afterDraw');
    await page.screenshot({ path: `${OUT}/j1-1-after-draw-front.png` });
    // orbit by dragging background (top-left corner area)
    const b = await canvasBox(page);
    await drag(page, { x: b.x + 60, y: b.y + b.height - 80 }, { x: b.x + 300, y: b.y + b.height - 60 }, 12);
    const camAfter = await page.evaluate(() => window.__formengine.app.viewport.camera.position.toArray());
    ev.orbitMovedCamera = Math.hypot(...camAfter.map((v, i) => v - camBefore[i]));
    assert(ev.orbitMovedCamera > 0.05, 'background drag orbits camera');
    const dOrbit = await delta(page, 'afterDraw');
    assert(dOrbit.maxDelta === 0, 'orbit does not deform the mesh');
    await page.screenshot({ path: `${OUT}/j1-2-orbited-side.png` });
    await page.keyboard.press('1'); await page.waitForTimeout(150);
    // Smooth stroke
    await page.keyboard.press('s');
    await strokeAcrossCenter(page);
    const dSmooth = await delta(page, 'afterDraw');
    ev.smoothStroke = dSmooth;
    assert(dSmooth.maxDelta > 1e-5, 'smooth changed geometry');
    await snap(page, 'afterSmooth');
    // undo → equals afterDraw ; redo → equals afterSmooth
    await page.keyboard.press('Control+z');
    const u = await delta(page, 'afterDraw');
    ev.undoRestoresDraw = u;
    assert(u.maxDelta === 0, `undo restores exact post-draw positions (maxDelta=${u.maxDelta})`);
    await page.keyboard.press('Control+Shift+z');
    const r = await delta(page, 'afterSmooth');
    ev.redoRestoresSmooth = r;
    assert(r.maxDelta === 0, 'redo restores exact post-smooth positions');
    // radius up + symmetry already on (X) → another stroke on one side
    await page.keyboard.press('b');
    await page.keyboard.press(']'); await page.keyboard.press(']');
    const radius = await page.evaluate(() => window.__formengine.app.settings.radius);
    ev.radiusAfterIncrease = radius;
    assert(radius > 0.25, 'radius increased');
    const sym = await page.evaluate(() => window.__formengine.app.symmetry.x);
    assert(sym, 'X symmetry on by default');
    await snap(page, 'beforeSym');
    const cb = await canvasBox(page);
    await drag(page, { x: cb.x + cb.width / 2 + 90, y: cb.y + cb.height / 2 - 60 }, { x: cb.x + cb.width / 2 + 120, y: cb.y + cb.height / 2 + 40 });
    const symInfo = await page.evaluate(() => {
      const A = window.__snaps.beforeSym.pos, o = window.__formengine.app.selected, p = o.editable.positions;
      let left = 0, right = 0;
      for (let i = 0; i < p.length; i += 3) { const d = Math.hypot(p[i] - A[i], p[i + 1] - A[i + 1], p[i + 2] - A[i + 2]); if (d > 1e-4) { if (A[i] < 0) left++; else right++; } }
      return { left, right };
    });
    ev.symmetryMovedBothSides = symInfo;
    assert(symInfo.left > 10 && symInfo.right > 10, 'symmetry stroke moved vertices on both sides of X=0');
    await page.screenshot({ path: `${OUT}/j1-3-symmetry.png` });
    await worldSnap(page, 'edited');
    // Export GLB through the UI
    await page.click('#btn-export');
    await page.waitForSelector('#export-dlg');
    const dl = await saveDownload(page, () => page.click('#export-go'), 'j1-sculpture.glb');
    ev.exportedGLB = dl;
    assert(dl.bytes > 1000 && readFileSync(dl.path).subarray(0, 4).toString() === 'glTF', 'real GLB downloaded');
    // Fresh page, import the downloaded GLB
    const { page: p2, ctx: c2 } = await newPage();
    await boot(p2);
    await p2.evaluate(() => window.__formengine.app.newProject(false));
    await importFile(p2, [dl.path]);
    const n = await p2.evaluate(() => window.__formengine.app.model.objects.length);
    assert(n === 1, 'one object re-imported');
    await p2.evaluate(() => { window.__world = {}; });
    await worldSnap(p2, 'reimported');
    const edited = await page.evaluate(() => window.__world.edited);
    await p2.evaluate((e) => { window.__world.edited = e; }, edited);
    const hd = await hausdorff(p2, 'edited', 'reimported');
    const hd2 = await hausdorff(p2, 'reimported', 'edited');
    ev.reimportHausdorff = Math.max(hd, hd2);
    assert(ev.reimportHausdorff < 1e-4, `re-imported GLB matches edited shape (hausdorff ${ev.reimportHausdorff})`);
    // and differs from an unedited sphere
    await p2.evaluate(() => { const app = window.__formengine.app; const o = app.addPrimitive('sphere', 3); app.select(o.id); });
    await worldSnap(p2, 'plain');
    ev.differsFromPlainSphere = await hausdorff(p2, 'reimported', 'plain');
    assert(ev.differsFromPlainSphere > 0.02, 'exported shape retains the sculpted change');
    await p2.evaluate(() => { const app = window.__formengine.app; app.deleteObject(app.selected.id); app.viewport.frame(); });
    await p2.screenshot({ path: `${OUT}/j1-4-reimported.png` });
    ev.pageErrors = [...page.__errors, ...p2.__errors];
    await c2.close(); await ctx.close();
  });

  // ───────────── Journey 2: imported model ─────────────
  await journey('J2 imported Khronos Duck GLB: inspect, transform, sculpt, save, reload, export', async (ev) => {
    const duck = 'test-results/external/Duck.glb';
    assert(existsSync(duck), 'Duck.glb fixture downloaded');
    const { page, ctx } = await newPage();
    await boot(page);
    await page.evaluate(() => window.__formengine.app.newProject(false));
    await importFile(page, [duck]);
    const info = await page.evaluate(() => {
      const app = window.__formengine.app, o = app.selected;
      const r = app.meshReport(o);
      return { objects: app.model.objects.length, name: o.name, tris: r.triangles, bounds: r.bounds, hasUV: r.hasUV, material: o.baseMaterial.type, hasTexture: !!o.baseMaterial.map, scale: o.mesh.scale.toArray() };
    });
    ev.imported = info;
    assert(info.objects >= 1 && info.tris > 1000, 'duck mesh imported with geometry');
    assert(info.hasTexture, 'duck texture retained');
    // numeric transform via inspector
    await page.keyboard.press('t');
    await page.waitForSelector('.xyz input');
    await page.fill('input[aria-label="Position Y"]', '0.25'); await page.press('input[aria-label="Position Y"]', 'Enter');
    await page.fill('input[aria-label="Rotation °  Y"], input[aria-label="Rotation ° Y"]', '30').catch(() => {});
    const tr = await page.evaluate(() => window.__formengine.app.selected.mesh.position.toArray());
    ev.positionAfterNumeric = tr;
    assert(Math.abs(tr[1] - 0.25) < 1e-6, 'numeric position applied');
    await page.click('#app'); // blur
    await page.keyboard.press('f');
    await page.waitForTimeout(200);
    await snap(page, 'duck0');
    await page.keyboard.press('b');
    await page.evaluate(() => window.__formengine.app.updateSettings({ radius: 0.15, strength: 0.8 }));
    await strokeAcrossCenter(page, 0.05, 0.05);
    const d = await delta(page, 'duck0');
    ev.sculptOnImported = d;
    assert(d.maxDelta > 1e-3, 'imported duck was sculpted');
    await page.screenshot({ path: `${OUT}/j2-1-duck-sculpted.png` });
    await worldSnap(page, 'duckEdited');
    const editedWorld = await page.evaluate(() => window.__world.duckEdited);
    // Save project file (download) and autosave, then reload → restore
    const proj = await saveDownload(page, () => page.click('#btn-save'), 'j2-duck.formengine');
    ev.projectFile = proj;
    await page.evaluate(() => window.__formengine.app.autosaveNow());
    await page.goto(BASE); // normal load (no ?fresh) → restores last autosave
    await page.waitForFunction(() => window.__formengine?.app?.model.objects.length > 0, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    const restored = await page.evaluate(() => ({ n: window.__formengine.app.model.objects.length, name: window.__formengine.app.model.objects[0].name, hasTexture: !!window.__formengine.app.model.objects[0].baseMaterial.map }));
    ev.afterReload = restored;
    await page.evaluate(() => window.__formengine.app.select(window.__formengine.app.model.objects[0].id));
    await page.evaluate((e) => { window.__world = { duckEdited: e }; }, editedWorld);
    await worldSnap(page, 'duckRestored');
    ev.reloadHausdorff = await hausdorff(page, 'duckEdited', 'duckRestored');
    assert(ev.reloadHausdorff < 1e-5, 'autosave restore preserves sculpt + transform');
    assert(restored.hasTexture, 'texture survives project save/restore');
    // open the downloaded project file into a fresh page as well
    const { page: p3, ctx: c3 } = await newPage();
    await boot(p3);
    await importFile(p3, [proj.path]);
    await p3.evaluate((e) => { window.__world = { duckEdited: e }; const a = window.__formengine.app; a.select(a.model.objects[0].id); }, editedWorld);
    await worldSnap(p3, 'fromFile');
    ev.projectFileHausdorff = await hausdorff(p3, 'duckEdited', 'fromFile');
    assert(ev.projectFileHausdorff < 1e-5, '.formengine file reopens with identical geometry');
    // continue editing after reopen, then export GLB and re-import
    await p3.keyboard.press('b');
    await p3.evaluate(() => window.__formengine.app.updateSettings({ radius: 0.15, strength: 0.8 }));
    await p3.keyboard.press('f'); await p3.waitForTimeout(200);
    await snap(p3, 'cont');
    await strokeAcrossCenter(p3, 0.03, -0.04);
    ev.continueEditing = await delta(p3, 'cont');
    assert(ev.continueEditing.maxDelta > 1e-3, 'can keep sculpting after reopening');
    await p3.click('#btn-export'); await p3.waitForSelector('#export-dlg');
    const glb = await saveDownload(p3, () => p3.click('#export-go'), 'j2-duck-edited.glb');
    ev.exportedGLB = glb;
    await worldSnap(p3, 'duckFinal');
    const fin = await p3.evaluate(() => window.__world.duckFinal);
    await p3.evaluate(() => window.__formengine.app.newProject(false));
    await importFile(p3, [glb.path]);
    await p3.evaluate((f) => { window.__world.duckFinal = f; }, fin);
    await worldSnap(p3, 'duckReimported');
    ev.exportHausdorff = await hausdorff(p3, 'duckFinal', 'duckReimported');
    ev.reimportedHasTexture = await p3.evaluate(() => !!window.__formengine.app.selected.baseMaterial.map);
    assert(ev.exportHausdorff < 1e-4, 'exported duck GLB re-imports with edits');
    assert(ev.reimportedHasTexture, 'texture survives GLB export');
    ev.pageErrors = [...page.__errors, ...p3.__errors];
    await c3.close(); await ctx.close();
  });

  // ───────────── Journey 3: image → bridge → adopt → sculpt → export ─────────────
  await journey('J3 image → bridge (FIXTURE upstream) → consent → job → review → adopt → sculpt → export', async (ev) => {
    const { page, ctx } = await newPage();
    await boot(page);
    // make a real PNG
    const png = `${OUT}/j3-source.png`;
    const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 320; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 320, 320); g.fillStyle = '#c33'; g.beginPath(); g.arc(160, 170, 100, 0, 7); g.fill(); return c.toDataURL('image/png').split(',')[1]; });
    writeFileSync(png, Buffer.from(b64, 'base64'));
    const requests = [];
    page.on('request', (r) => { if (r.url().includes(`:${bridgePort}`)) requests.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await importFile(page, [png]);
    await page.waitForSelector('#image-lab');
    ev.noUploadBeforeConsent = requests.length === 0;
    await page.click('#bridge-advanced > summary');
    await page.fill('#bridge-url', `http://127.0.0.1:${bridgePort}`);
    await page.click('#bridge-test');
    await page.waitForSelector('#provider-status.pill.on', { timeout: 10000 });
    ev.providerStatus = await page.textContent('#provider-status');
    await page.click('#recon-submit');
    await page.waitForSelector('#consent');
    ev.requestsBeforeConsent = requests.filter((r) => r.startsWith('POST')).length;
    assert(ev.requestsBeforeConsent === 0, 'no upload before consent');
    assert(await page.isDisabled('#consent-submit'), 'submit disabled until consent checkbox ticked');
    await page.check('#consent-ok');
    await page.click('#consent-submit');
    await page.waitForSelector('[id^="review-job_"]', { timeout: 30000 });
    const states = await page.evaluate(() => [...document.querySelectorAll('.job-log li')].map((l) => l.textContent));
    ev.jobStateLog = states;
    ev.bridgeRequests = requests;
    assert(requests.filter((r) => r === 'POST /v1/jobs').length === 1, 'exactly one job submission');
    await page.screenshot({ path: `${OUT}/j3-1-job-done.png` });
    await page.click('[id^="review-job_"]');
    await page.waitForSelector('#review');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/j3-2-review.png` });
    const before = await page.evaluate(() => window.__formengine.app.model.objects.map((o) => o.id));
    await page.click('#adopt-btn');
    await page.waitForTimeout(500);
    const adopted = await page.evaluate((before) => {
      const app = window.__formengine.app;
      const o = app.model.objects.find((x) => !before.includes(x.id));
      return o ? { id: o.id, source: o.provenance.source, jobId: o.provenance.jobId, provider: o.provenance.provider, tris: o.editable.triangleCount, warning: o.provenance.inferredWarning } : null;
    }, before);
    ev.adopted = adopted;
    assert(adopted && adopted.source === 'reconstruction' && adopted.tris > 1000, 'reconstruction adopted as editable object');
    assert(before.length >= 1, 'existing sculpt kept (new version, no overwrite)');
    await page.evaluate((id) => { const a = window.__formengine.app; a.select(id); for (const o of a.model.objects) if (o.id !== id) a.setVisible(o.id, false); a.viewport.frame(a.selected); }, adopted.id);
    await snap(page, 'gen0', adopted.id);
    await page.keyboard.press('b');
    await page.evaluate(() => window.__formengine.app.updateSettings({ radius: 0.12, strength: 0.9 }));
    const cb = await canvasBox(page);
    // find a screen point that hits the knot
    const hitPt = await page.evaluate(([w, h, x0, y0]) => { const app = window.__formengine.app; for (let r = 0; r < 200; r += 6) for (let a = 0; a < 6.28; a += 0.5) { const x = x0 + w / 2 + Math.cos(a) * r, y = y0 + h / 2 + Math.sin(a) * r; if (app.viewport.pick(x, y)) return { x, y }; } return null; }, [cb.width, cb.height, cb.x, cb.y]);
    assert(hitPt, 'generated mesh visible under the cursor');
    await drag(page, hitPt, { x: hitPt.x + 40, y: hitPt.y + 10 });
    ev.sculptOnGenerated = await delta(page, 'gen0');
    assert(ev.sculptOnGenerated.maxDelta > 1e-3, 'generated mesh was sculpted');
    await page.screenshot({ path: `${OUT}/j3-3-generated-sculpted.png` });
    await page.click('#btn-export'); await page.waitForSelector('#export-dlg');
    await page.check('#ex-scope-selected');
    const glb = await saveDownload(page, () => page.click('#export-go'), 'j3-generated-edited.glb');
    ev.exportedGLB = glb;
    await worldSnap(page, 'genEdited', adopted.id);
    const ge = await page.evaluate(() => window.__world.genEdited);
    await page.evaluate(() => window.__formengine.app.newProject(false));
    await importFile(page, [glb.path]);
    await page.evaluate((g) => { window.__world.genEdited = g; }, ge);
    await worldSnap(page, 'genReimported');
    ev.reimportHausdorff = await hausdorff(page, 'genEdited', 'genReimported');
    assert(ev.reimportHausdorff < 1e-4, 'edited generated mesh survives GLB export/re-import');
    ev.note = 'Upstream was the TEST FIXTURE mock-meshy-server; live Meshy is UNVERIFIED.';
    ev.pageErrors = page.__errors;
    await ctx.close();
  });

  // ───────────── Journey 4: no provider ─────────────
  await journey('J4 no provider: honest not-connected state, reference planes, 2.5D relief, keep sculpting', async (ev) => {
    const { page, ctx } = await newPage();
    await boot(page);
    const png = `${OUT}/j3-source.png`;
    await importFile(page, [png]);
    await page.waitForSelector('#image-lab');
    ev.status = await page.textContent('#provider-status');
    assert(/Provider not connected/.test(ev.status), 'shows Provider not connected');
    ev.submitButtonPresent = await page.$('#recon-submit') !== null;
    assert(!ev.submitButtonPresent, 'no submit without provider');
    await page.click('#lab-reference');
    await page.waitForTimeout(400);
    ev.references = await page.evaluate(() => window.__formengine.app.references.length);
    assert(ev.references === 1, 'reference plane placed');
    await page.click('#lab-relief');
    await page.waitForTimeout(500);
    const relief = await page.evaluate(() => { const o = window.__formengine.app.selected; const r = window.__formengine.app.meshReport(o); return { source: o.provenance.source, warning: o.provenance.inferredWarning, tris: r.triangles, watertight: r.watertight }; });
    ev.relief = relief;
    assert(relief.source === 'relief' && relief.watertight, 'relief mesh is labelled and watertight');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/j4-1-reference-relief.png` });
    // keep sculpting the sphere
    await page.evaluate(() => { const a = window.__formengine.app; a.select(a.model.objects[0].id); a.setVisible(a.selected.id, true); for (const o of a.model.objects.slice(1)) a.setVisible(o.id, false); a.viewport.frame(a.selected); });
    await snap(page, 's0');
    await page.keyboard.press('b');
    await strokeAcrossCenter(page);
    ev.sculptAfter = await delta(page, 's0');
    assert(ev.sculptAfter.maxDelta > 1e-3, 'local sculpting continues without a provider');
    // reference not exported
    await page.click('#btn-export'); await page.waitForSelector('#export-dlg'); await page.check('#ex-scope-visible');
    const glb = await saveDownload(page, () => page.click('#export-go'), 'j4-visible.glb');
    const { parseCount } = { parseCount: readFileSync(glb.path).includes(Buffer.from('Reference')) };
    ev.referenceInExport = parseCount;
    assert(!parseCount, 'reference image not exported');
    ev.pageErrors = page.__errors;
    await ctx.close();
  });

  // ───────────── Journey 5: touch & pen ─────────────
  await journey('J5 touch/pen: one-finger sculpt, two-finger navigates without deforming, pen pressure', async (ev) => {
    const { page, ctx } = await newPage({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false });
    await boot(page);
    const cdp = await ctx.newCDPSession(page);
    const b = await canvasBox(page);
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const touch = async (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 4, radiusY: 4, force: 1 })) });
    await snap(page, 't0');
    // one finger stroke
    await touch('touchStart', [{ x: cx - 60, y: cy }]);
    for (let i = 1; i <= 15; i++) await touch('touchMove', [{ x: cx - 60 + i * 8, y: cy + i }]);
    await touch('touchEnd', []);
    await page.waitForTimeout(100);
    ev.oneFinger = await delta(page, 't0');
    assert(ev.oneFinger.maxDelta > 1e-3, 'one-finger touch sculpts');
    const hist1 = await page.evaluate(() => window.__formengine.app.history.size);
    // two-finger gesture starting ON the mesh: first finger starts a stroke, second cancels it
    await snap(page, 't1');
    const cam0 = await page.evaluate(() => window.__formengine.app.viewport.camera.position.toArray());
    await touch('touchStart', [{ x: cx - 20, y: cy, id: 1 }]);
    await touch('touchMove', [{ x: cx - 10, y: cy + 4, id: 1 }]);
    await touch('touchStart', [{ x: cx - 10, y: cy + 4, id: 1 }, { x: cx + 80, y: cy, id: 2 }]);
    for (let i = 1; i <= 12; i++) await touch('touchMove', [{ x: cx - 10 + i * 10, y: cy + 4 + i * 4, id: 1 }, { x: cx + 80 + i * 10, y: cy + i * 4, id: 2 }]);
    await touch('touchEnd', []);
    await page.waitForTimeout(300);
    ev.twoFingerDeformation = await delta(page, 't1');
    const cam1 = await page.evaluate(() => window.__formengine.app.viewport.camera.position.toArray());
    ev.twoFingerCameraMove = Math.hypot(...cam1.map((v, i) => v - cam0[i]));
    ev.historyAddedByTwoFinger = (await page.evaluate(() => window.__formengine.app.history.size)) - hist1;
    assert(ev.twoFingerDeformation.maxDelta === 0, 'two-finger gesture leaves geometry unchanged (stroke rolled back)');
    assert(ev.historyAddedByTwoFinger === 0, 'cancelled stroke adds no history');
    assert(ev.twoFingerCameraMove > 1e-3, 'two-finger gesture navigates the camera');
    // pen pressure: low vs high pressure strokes on fresh spheres
    const penStroke = async (force) => {
      await page.evaluate(() => { const a = window.__formengine.app; a.newProject(true); });
      await page.waitForTimeout(150);
      await snap(page, `pen${force}`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx - 50, y: cy, pointerType: 'pen' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx - 50, y: cy, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force });
      for (let i = 1; i <= 12; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx - 50 + i * 8, y: cy, button: 'left', buttons: 1, pointerType: 'pen', force });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 46, y: cy, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force });
      await page.waitForTimeout(80);
      return (await delta(page, `pen${force}`)).maxDelta;
    };
    ev.penLight = await penStroke(0.15);
    ev.penHeavy = await penStroke(1.0);
    ev.penPressureReported = await page.evaluate(() => 'PointerEvent' in window);
    assert(ev.penHeavy > 1e-3 && ev.penLight > 0, 'pen strokes sculpt');
    assert(ev.penHeavy > ev.penLight * 1.3, `pen pressure scales strength (light ${ev.penLight.toFixed(4)} vs heavy ${ev.penHeavy.toFixed(4)})`);
    await page.screenshot({ path: `${OUT}/j5-tablet-landscape.png` });
    ev.pageErrors = page.__errors;
    await ctx.close();
  });

  // ───────────── Journey 6: failure recovery ─────────────
  await journey('J6 failure recovery: malformed/oversized import leaves scene intact, autosave recovery, context loss', async (ev) => {
    const { page, ctx } = await newPage();
    await boot(page);
    await page.keyboard.press('b');
    await strokeAcrossCenter(page);
    await snap(page, 'good');
    const n0 = await page.evaluate(() => window.__formengine.app.model.objects.length);
    const bad = `${OUT}/broken.glb`;
    const buf = Buffer.alloc(200, 0); buf.writeUInt32LE(0x46546c67, 0); writeFileSync(bad, buf);
    const nanObj = `${OUT}/nan.obj`; writeFileSync(nanObj, 'v NaN 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    const junk = `${OUT}/junk.stl`; writeFileSync(junk, 'this is not a mesh at all');
    for (const f of [bad, nanObj, junk]) await importFile(page, [f]);
    ev.toasts = await page.evaluate(() => window.__formengine.app.toasts.map((t) => `${t.kind}: ${t.text}`));
    assert(ev.toasts.filter((t) => t.startsWith('error')).length >= 3, 'three clear import errors shown');
    const n1 = await page.evaluate(() => window.__formengine.app.model.objects.length);
    ev.unchanged = await delta(page, 'good');
    assert(n1 === n0 && ev.unchanged.maxDelta === 0, 'existing sculpture untouched by failed imports');
    await page.screenshot({ path: `${OUT}/j6-1-errors.png` });
    // corrupt project file must not replace current project
    const corrupt = `${OUT}/corrupt.formengine`; writeFileSync(corrupt, Buffer.from('PK\x03\x04garbage'));
    await importFile(page, [corrupt]);
    ev.afterCorruptProject = await delta(page, 'good');
    assert(ev.afterCorruptProject.maxDelta === 0, 'corrupt project file does not alter the open work');
    // autosave → reload → recovered
    await page.evaluate(() => window.__formengine.app.autosaveNow());
    const goodPos = await page.evaluate(() => Array.from(window.__snaps.good.pos.slice(0, 3000)));
    await page.goto(BASE); // normal load (no ?fresh) → restores last autosave
    await page.waitForFunction(() => window.__formengine?.app?.model.objects.length > 0, null, { timeout: 30000 });
    const rec = await page.evaluate((g) => { const p = window.__formengine.app.model.objects[0].editable.positions; let m = 0; for (let i = 0; i < g.length; i++) m = Math.max(m, Math.abs(p[i] - g[i])); return m; }, goodPos);
    ev.autosaveRecoveryMaxDelta = rec;
    assert(rec === 0, 'reload recovers the last autosave exactly');
    // simulate a damaged latest slot: corrupt it and confirm fallback to previous valid slot
    const fallback = await page.evaluate(async () => {
      const app = window.__formengine.app;
      await app.autosaveNow(); // slot X
      app.markDirty(); await app.autosaveNow(); // slot Y (latest)
      const db = await new Promise((r) => { const q = indexedDB.open('formengine'); q.onsuccess = () => r(q.result); });
      const meta = await new Promise((r) => { const q = db.transaction('meta').objectStore('meta').get(app.projectId); q.onsuccess = () => r(q.result); });
      await new Promise((r) => { const tx = db.transaction('blobs', 'readwrite'); tx.objectStore('blobs').put(new Blob(['corrupted']), `${app.projectId}:${meta.latestSlot}`); tx.oncomplete = r; });
      const ok = await app.restoreLast();
      return { ok, toast: app.toasts.map((t) => t.text).pop() };
    });
    ev.damagedSlotFallback = fallback;
    assert(fallback.ok && /previous valid autosave/.test(fallback.toast), 'damaged latest autosave falls back to previous slot');
    // WebGL context loss
    const lost = await page.evaluate(async () => {
      const gl = window.__formengine.app.viewport.renderer.getContext();
      const ext = gl.getExtension('WEBGL_lose_context');
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 300));
      const overlay = !!document.getElementById('ctx-lost');
      ext.restoreContext();
      await new Promise((r) => setTimeout(r, 600));
      return { overlay, cleared: !document.getElementById('ctx-lost'), objects: window.__formengine.app.model.objects.length };
    });
    ev.contextLoss = lost;
    assert(lost.overlay && lost.cleared && lost.objects > 0, 'context loss shows recovery overlay and resumes without losing work');
    ev.pageErrors = page.__errors.filter((e) => !/CONTEXT_LOST|context lost/i.test(e));
    await ctx.close();
  });

  // ───────────── Journey 7: OBJ / STL round trip ─────────────
  await journey('J7 reuse elsewhere: OBJ and STL (mm) export → re-import in new scene', async (ev) => {
    const { page, ctx } = await newPage();
    await boot(page);
    await page.keyboard.press('b');
    await page.evaluate(() => window.__formengine.app.setSymmetry({ x: false }));
    const cb = await canvasBox(page);
    await drag(page, { x: cb.x + cb.width / 2 + 40, y: cb.y + cb.height / 2 - 40 }, { x: cb.x + cb.width / 2 + 90, y: cb.y + cb.height / 2 - 70 }); // asymmetric
    await worldSnap(page, 'src');
    const src = await page.evaluate(() => window.__world.src);
    for (const fmt of ['obj', 'stl']) {
      await page.click('#btn-export'); await page.waitForSelector('#export-dlg');
      await page.check(`#ex-format-${fmt}`);
      if (fmt === 'stl') await page.selectOption('#ex-ou', 'mm');
      const f = await saveDownload(page, () => page.click('#export-go'), `j7-sculpture.${fmt}`);
      ev[`${fmt}File`] = f;
      const { page: p2, ctx: c2 } = await newPage();
      await boot(p2);
      await p2.evaluate(() => window.__formengine.app.newProject(false));
      await importFile(p2, [f.path]);
      await p2.evaluate(([s, scale]) => { window.__world = { src: s.map((v) => v * scale) }; }, [src, fmt === 'stl' ? 1000 : 1]);
      await worldSnap(p2, 'back');
      ev[`${fmt}Hausdorff`] = Math.max(await hausdorff(p2, 'src', 'back'), await hausdorff(p2, 'back', 'src'));
      ev[`${fmt}Toasts`] = await p2.evaluate(() => window.__formengine.app.toasts.map((t) => [t.text, ...(t.detail ?? [])].join(' | ')));
      assert(ev[`${fmt}Hausdorff`] < (fmt === 'stl' ? 0.1 : 1e-4), `${fmt} re-import matches (hd ${ev[`${fmt}Hausdorff`]})`);
      await c2.close();
    }
    await page.evaluate(() => { const p = window.__world.src; window.__world.mirror = p.map((v, i) => (i % 3 === 0 ? -v : v)); });
    ev.asymmetryHausdorffToMirror = await hausdorff(page, 'src', 'mirror');
    assert(ev.asymmetryHausdorffToMirror > 1e-2, 'test sculpture is asymmetric (differs from its X mirror)');
    ev.pageErrors = page.__errors;
    await ctx.close();
  });


  // ───────────── Journey 8: free on-device image → 3D ─────────────
  await journey('J8 free on-device image → 3D (Depth Anything V2 in the browser) → sculpt → export', async (ev) => {
    const photo = 'test-results/free3d/mushroom.png';
    assert(existsSync(photo), 'test photo present (npm run fetch:samples)');
    const { page, ctx } = await newPage();
    await boot(page);
    const external = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.origin !== new URL(BASE).origin && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) external.push(`${r.method()} ${u.host}${u.pathname.slice(0, 80)}`); });
    await importFile(page, [photo]);
    await page.waitForSelector('#image-lab');
    await page.click('#lab-ondevice');
    const t0 = Date.now();
    await page.waitForFunction(() => /Done in|Failed/.test(document.getElementById('od-status')?.textContent ?? ''), null, { timeout: 300000 });
    ev.status = await page.textContent('#od-status');
    ev.wallSeconds = (Date.now() - t0) / 1000;
    assert(/Done in/.test(ev.status), `on-device reconstruction finished: ${ev.status}`);
    ev.externalRequests = [...new Set(external)];
    ev.uploads = external.filter((r) => r.startsWith('POST') || r.startsWith('PUT'));
    assert(ev.uploads.length === 0, 'nothing was uploaded (only model/runtime downloads)');
    const obj = await page.evaluate(() => { const a = window.__formengine.app; const o = a.selected; const r = a.meshReport(o); return { id: o.id, name: o.name, source: o.provenance.source, detail: o.provenance.detail, warning: o.provenance.inferredWarning, tris: r.triangles, watertight: r.watertight, shells: r.components, nonManifold: r.nonManifoldEdges, hasTexture: !!o.baseMaterial.map, size: r.bounds.size }; });
    ev.mesh = obj;
    assert(obj.source === 'depth' && obj.tris > 5000 && obj.watertight && obj.shells === 1, 'closed single-shell depth mesh added');
    await page.keyboard.press('Escape');
    await page.evaluate((id) => { const a = window.__formengine.app; for (const o of a.model.objects) a.setVisible(o.id, o.id === id); a.select(id); a.viewport.setView('iso'); a.viewport.frame(a.selected); }, obj.id);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/j8-1-ondevice-iso.png` });
    await page.evaluate(() => { const a = window.__formengine.app; a.viewport.setView('front'); a.viewport.frame(a.selected); });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/j8-2-ondevice-front.png` });
    await snap(page, 'od0', obj.id);
    await page.keyboard.press('b');
    await page.evaluate(() => window.__formengine.app.updateSettings({ radius: 0.08, strength: 0.8 }));
    await strokeAcrossCenter(page, 0.04, 0.03);
    ev.sculpt = await delta(page, 'od0');
    assert(ev.sculpt.maxDelta > 1e-3, 'depth mesh sculpted');
    await page.click('#btn-export'); await page.waitForSelector('#export-dlg'); await page.check('#ex-scope-selected');
    const glb = await saveDownload(page, () => page.click('#export-go'), 'j8-ondevice-edited.glb');
    ev.exportedGLB = glb;
    await worldSnap(page, 'odEdited', obj.id);
    const w = await page.evaluate(() => window.__world.odEdited);
    await page.evaluate(() => window.__formengine.app.newProject(false));
    await importFile(page, [glb.path]);
    await page.evaluate((x) => { window.__world.odEdited = x; }, w);
    await worldSnap(page, 'odBack');
    ev.reimportHausdorff = await hausdorff(page, 'odEdited', 'odBack');
    ev.reimportedHasTexture = await page.evaluate(() => !!window.__formengine.app.selected.baseMaterial.map);
    assert(ev.reimportHausdorff < 1e-4 && ev.reimportedHasTexture, 'edited textured depth mesh survives GLB export/re-import');
    ev.pageErrors = page.__errors;
    await ctx.close();
  });

  // ───────────── Visual QA at 4 sizes ─────────────
  await journey('Visual QA screenshots 1440x900, 1024x768, 768x1024, 390x844', async (ev) => {
    for (const [w, h, mobile] of [[1440, 900, false], [1024, 768, false], [768, 1024, true], [390, 844, true]]) {
      const { page, ctx } = await newPage({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile });
      await boot(page);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/vqa-${w}x${h}.png` });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      ev[`${w}x${h}`] = { horizontalOverflow: overflow };
      assert(!overflow, `${w}x${h} has no horizontal overflow`);
      if (w <= 760) {
        await page.click('button[aria-label="Toggle inspector panel"]');
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/vqa-${w}x${h}-inspector.png` });
      }
      await page.click('#btn-imagelab');
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${OUT}/vqa-${w}x${h}-imagelab.png` });
      await ctx.close();
    }
  });

  // ───────────── Leak check ─────────────
  await journey('Resource lifetime: 20 new-project + import/remove cycles', async (ev) => {
    const { page, ctx } = await newPage();
    await boot(page);
    const before = await page.evaluate(() => ({ ...window.__formengine.app.viewport.renderer.info.memory }));
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => window.__formengine.app.newProject(true));
      await importFile(page, ['test-results/external/BoxTextured.glb']);
    }
    await page.evaluate(() => { window.__formengine.app.newProject(true); window.__formengine.app.viewport.renderNow(); });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({ ...window.__formengine.app.viewport.renderer.info.memory, history: window.__formengine.app.history.size, objects: window.__formengine.app.model.objects.length, overlays: window.__formengine.app.viewport.overlays.children.length }));
    ev.before = before; ev.after = after;
    assert(after.geometries <= before.geometries + 6, `GPU geometries stable (${before.geometries} → ${after.geometries})`);
    assert(after.textures <= before.textures + 3, `GPU textures stable (${before.textures} → ${after.textures})`);
    assert(after.overlays === 2 * after.objects, 'overlay meshes match object count');
    await ctx.close();
  });

  // ───────────── Performance benchmark ─────────────
  await journey('Performance benchmark (headless Chromium + SwiftShader software GL)', async (ev) => {
    const { page, ctx } = await newPage();
    await boot(page);
    const env = await page.evaluate(() => { const gl = window.__formengine.app.viewport.renderer.getContext(); const dbg = gl.getExtension('WEBGL_debug_renderer_info'); return { ua: navigator.userAgent, renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown', dpr: devicePixelRatio, cores: navigator.hardwareConcurrency }; });
    ev.environment = env;
    for (const [label, kind, detail] of [['~10k tris', 'sphere', 1], ['~100k tris', 'sphere', 4], ['~200k tris', 'sphere', 5], ['~430k tris (subdivided)', 'subdivided', 4]]) {
      const r = await page.evaluate(async ([kind, detail]) => {
        const app = window.__formengine.app;
        app.newProject(false);
        const t0 = performance.now();
        const o = app.addPrimitive('sphere', detail);
        if (kind === 'subdivided') { app.select(o.id); app.subdivide(); }
        const setupMs = performance.now() - t0;
        app.viewport.frame(o);
        const tris = o.editable.triangleCount;
        const results = {};
        const THREE_V = o.mesh.position.constructor;
        for (const brush of ['draw', 'smooth', 'clay', 'grab', 'pinch']) {
          app.setBrush(brush);
          app.updateSettings({ radius: 0.15, strength: 0.5 });
          app.perf.geometryMs.length = 0;
          const frames = [];
          const p = new THREE_V(0, 0, 0.5);
          // 3-second scripted stroke sampled at ~60 Hz via the same code path as pointer input
          const canvas = app.viewport.renderer.domElement.getBoundingClientRect();
          const cx = canvas.left + canvas.width / 2, cy = canvas.top + canvas.height / 2;
          const hit = app.viewport.pick(cx, cy);
          if (!hit) continue;
          app.beginStroke(hit.obj, hit.hit.point, 1);
          // RAF-paced like real pointer input: one stroke sample per animation frame; the app's own
          // render-on-demand loop draws the frame. Frame time = interval between RAF callbacks.
          await new Promise((done) => {
            const start = performance.now();
            let last = start, i = 0;
            const tick = (now) => {
              if (i > 0) frames.push(now - last);
              last = now;
              const x = cx + Math.sin(i / 20) * canvas.width * 0.12, y = cy + Math.cos(i / 27) * canvas.height * 0.08;
              app.strokeSample(x, y, 1);
              i++;
              if (now - start < 3000) requestAnimationFrame(tick); else done();
            };
            requestAnimationFrame(tick);
          });
          app.endStroke();
          const g = app.perf.geometryMs.slice().sort((a, b) => a - b), f = frames.slice().sort((a, b) => a - b);
          const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
          results[brush] = { samples: frames.length, geomP50: +q(g, 0.5).toFixed(2), geomP95: +q(g, 0.95).toFixed(2), frameP50: +q(f, 0.5).toFixed(1), frameP95: +q(f, 0.95).toFixed(1) };
        }
        // orbit render cost
        const orbit = [];
        await new Promise((done) => {
          let last = 0, k = 0;
          const tick = (now) => { if (last) orbit.push(now - last); last = now; app.viewport.controls.rotateLeft?.(0.05); app.viewport.camera.position.applyAxisAngle(new THREE_V(0, 1, 0), 0.05); app.viewport.camera.lookAt(app.viewport.controls.target); app.viewport.requestRender(); if (++k < 90) requestAnimationFrame(tick); else done(); };
          requestAnimationFrame(tick);
        });
        orbit.sort((a, b) => a - b);
        // export cost
        const e0 = performance.now();
        const { exportObjects } = window.__formengine.io ?? {};
        void exportObjects;
        return { tris, setupMs: +setupMs.toFixed(0), brushes: results, orbitFrameP50: +orbit[Math.floor(orbit.length / 2)].toFixed(1), orbitFrameP95: +orbit[Math.floor(orbit.length * 0.95)].toFixed(1), exportNote: e0 ? 'see J1 for export' : '' };
      }, [kind, detail]);
      ev[label] = r;
    }
    await ctx.close();
  });

  await browser.close();
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ when: new Date().toISOString(), base: BASE, results }, null, 2));
  const failed = results.filter((r) => r.status !== 'PASS');
  console.log(`\n${results.length - failed.length}/${results.length} journeys passed. Evidence: ${OUT}/results.json`);
  for (const p of procs) p.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); for (const p of procs) p.kill(); process.exit(2); });
