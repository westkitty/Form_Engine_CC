#!/usr/bin/env node
/**
 * TEST FIXTURE ONLY — a deterministic imitation of the Meshy Image-to-3D task API used to exercise
 * the real bridge (server/reconstruction-proxy.mjs) and the real browser job runner without credentials
 * or charges. It does NOT reconstruct anything: every "succeeded" task returns the fixed GLB file passed
 * in FIXTURE_GLB. Never point a user-facing build at this server.
 *
 * Behaviour is chosen by the first 4 chars of the first image's base64 payload is irrelevant; instead the
 * scenario is selected with the `texture_prompt` option (passed through by the bridge):
 *   'ok' (default) | 'fail' | 'expire' | 'ratelimit' | 'garbage' | 'slow'
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 0);
const KEY = process.env.MOCK_KEY ?? 'test-key';
const GLB = readFileSync(process.env.FIXTURE_GLB);
const tasks = new Map();
let seq = 0;
const stats = { submissions: 0, polls: 0, deletes: 0, downloads: 0 };
let rateLimitedOnce = false;

function send(res, status, body, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__stats') return send(res, 200, stats);
  if (url.pathname.startsWith('/assets/')) {
    stats.downloads++;
    const t = tasks.get(url.pathname.split('/')[2]);
    if (!t) return send(res, 404, { message: 'gone' });
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': t.scenario === 'garbage' ? 32 : GLB.length });
    return res.end(t.scenario === 'garbage' ? Buffer.alloc(32, 7) : GLB);
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { message: 'Invalid API key' });
  const m = /^\/openapi\/v1\/(image-to-3d|multi-image-to-3d)(?:\/([\w-]+))?$/.exec(url.pathname);
  if (!m) return send(res, 404, { message: 'nope' });
  if (req.method === 'POST' && !m[2]) {
    let body = '';
    for await (const c of req) body += c;
    const j = JSON.parse(body);
    stats.submissions++;
    const id = `fixture-${String(++seq).padStart(4, '0')}-task`;
    tasks.set(id, { id, polls: 0, scenario: j.texture_prompt ?? 'ok', created: Date.now(), images: m[1] === 'multi-image-to-3d' ? j.image_urls.length : 1 });
    return send(res, 202, { result: id });
  }
  const t = tasks.get(m[2]);
  if (!t) return send(res, 404, { message: 'Task not found' });
  if (req.method === 'DELETE') {
    stats.deletes++;
    if (t.polls >= 1) return send(res, 409, { message: 'Task in progress' });
    tasks.delete(t.id);
    return send(res, 200, {});
  }
  stats.polls++;
  t.polls++;
  if (t.scenario === 'ratelimit' && !rateLimitedOnce) { rateLimitedOnce = true; return send(res, 429, { message: 'Too many requests' }, { 'Retry-After': '1' }); }
  const base = { id: t.id, type: m[1], progress: 0, preceding_tasks: 0, created_at: t.created, started_at: 0, finished_at: 0, expires_at: 0, model_urls: {}, task_error: { message: '' } };
  const doneAt = t.scenario === 'slow' ? 1000 : 3;
  if (t.polls === 1) return send(res, 200, { ...base, status: 'PENDING', preceding_tasks: 2 });
  if (t.polls < doneAt) return send(res, 200, { ...base, status: 'IN_PROGRESS', progress: Math.min(95, t.polls * 30) });
  if (t.scenario === 'fail') return send(res, 200, { ...base, status: 'FAILED', task_error: { message: 'Fixture: generation failed' } });
  const host = `http://127.0.0.1:${server.address().port}`;
  return send(res, 200, { ...base, status: 'SUCCEEDED', progress: 100, expires_at: t.scenario === 'expire' ? Date.now() - 1000 : Date.now() + 3 * 864e5, model_urls: { glb: `${host}/assets/${t.id}/model.glb` } });
});

server.listen(PORT, '127.0.0.1', () => console.log(`MOCK_MESHY_PORT=${server.address().port}`));
