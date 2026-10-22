// Verifies the single-file artifact build runs the same editor: top-level and inside a sandboxed iframe
// (allow-scripts only → opaque origin: no IndexedDB, no downloads), approximating restrictive embed hosts.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
const OUT = 'test-results/artifact'; mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/sandbox.html`, '<!doctype html><html><body style="margin:0;background:#000"><iframe src="/index.html?fresh=1" sandbox="allow-scripts" style="border:0;width:100vw;height:100vh"></iframe></body></html>');
copyFileSync('test-results/artifact/sandbox.html', 'dist-artifact/sandbox.html');
const srv = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', 'dist-artifact', '--port', '4180', '--strictPort']);
await new Promise((r) => setTimeout(r, 2500)); console.log('server up?', await fetch('http://localhost:4180/index.html').then(r => r.status).catch(e => e.message));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = {};
async function run(frameName, getFrame, page) {
  console.log('start', frameName);
  const f = await getFrame();
  await f.waitForFunction(() => window.__formengine?.app?.model.objects.length > 0, null, { timeout: 30000 });
  await f.evaluate(() => document.querySelector('.onboard')?.remove());
  console.log('booted', frameName);
  const caps = await f.evaluate(() => window.__capabilities);
  const before = await f.evaluate(() => { const o = window.__formengine.app.selected; window.__p0 = o.editable.positions.slice(); return o.editable.vertexCount; });
  const box = await f.locator('.viewport-canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 80, cy); await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(cx - 80 + i * 8, cy + i);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const r = await f.evaluate(() => { const app = window.__formengine.app, p = app.selected.editable.positions; let m = 0; for (let i = 0; i < p.length; i++) m = Math.max(m, Math.abs(p[i] - window.__p0[i])); const after = p.slice(); app.undo(); let u = 0; for (let i = 0; i < p.length; i++) u = Math.max(u, Math.abs(p[i] - window.__p0[i])); app.redo(); let rd = 0; for (let i = 0; i < p.length; i++) rd = Math.max(rd, Math.abs(p[i] - after[i])); return { maxDelta: m, afterUndo: u, afterRedo: rd, save: app.saveState }; });
  results[frameName] = { caps, verts: before, ...r };
  await page.screenshot({ path: `${OUT}/${frameName}.png` });
}
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://localhost:4180/index.html?fresh=1');
await run('top-level', async () => page.mainFrame(), page);
const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; p2.on('pageerror', (e) => errs.push(e.message));
await p2.goto('http://localhost:4180/sandbox.html');
await p2.waitForTimeout(1500);
await run('sandboxed-iframe', async () => p2.frames().find((fr) => fr !== p2.mainFrame()), p2);
results['sandboxed-iframe'].pageErrors = errs;
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 1));
await browser.close(); srv.kill();
