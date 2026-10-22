#!/usr/bin/env node
/**
 * FORM//ENGINE reconstruction bridge — FORM Bridge v1 → Meshy Image-to-3D / Multi-Image-to-3D.
 *
 * Holds the provider API key server-side so it never ships in the static web build.
 * Zero dependencies; Node ≥ 18 (global fetch).
 *
 *   MESHY_API_KEY=msy_... node server/reconstruction-proxy.mjs
 *
 * Environment:
 *   MESHY_API_KEY     required. Never logged, never returned.
 *   HOST / PORT       bind address (default 127.0.0.1:8787 — local only).
 *   ALLOWED_ORIGINS   comma-separated CORS allowlist (default http://localhost:5173,http://localhost:4173).
 *   BRIDGE_TOKEN      optional; if set, clients must send `Authorization: Bearer <token>`.
 *   MESHY_BASE        upstream base URL (default https://api.meshy.ai). Tests point this at a local fixture.
 *   ASSET_HOSTS       comma-separated host suffixes allowed for model downloads (default meshy.ai).
 *
 * Meshy endpoints verified against docs.meshy.ai on 2026-10-21:
 *   POST/GET/DELETE /openapi/v1/image-to-3d[/:id], /openapi/v1/multi-image-to-3d[/:id]
 *   status: PENDING | IN_PROGRESS | SUCCEEDED | FAILED | CANCELED; model_urls.glb; expires_at (ms)
 *   DELETE refunds only PENDING tasks; IN_PROGRESS returns 409.
 */
import http from 'node:http';

const KEY = process.env.MESHY_API_KEY;
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8787);
const ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(',').map((s) => s.trim()).filter(Boolean);
const TOKEN = process.env.BRIDGE_TOKEN || null;
const BASE = (process.env.MESHY_BASE ?? 'https://api.meshy.ai').replace(/\/+$/, '');
const ASSET_HOSTS = (process.env.ASSET_HOSTS ?? 'meshy.ai').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_BODY = 4 * 21 * 1024 * 1024 * 1.4; // up to 4 images × 20 MB base64-encoded
const MAX_MODEL = 300 * 1024 * 1024;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;
const OPTION_KEYS = new Set(['ai_model', 'should_texture', 'enable_pbr', 'should_remesh', 'target_polycount', 'topology', 'texture_prompt', 'pose_mode']);

if (!KEY) {
  console.error('MESHY_API_KEY is not set. Refusing to start (the bridge would only return errors).');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After, Content-Length');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  return !origin || ORIGINS.includes(origin);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Body is not valid JSON'), { status: 400 }); }
}

async function meshy(path, init = {}) {
  const r = await fetch(BASE + path, { ...init, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  let json = null;
  const text = await r.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, retryAfter: r.headers.get('retry-after') };
}

function upstreamError(res, up) {
  const msg = up.json?.message ?? up.json?.error ?? `Upstream error ${up.status}`;
  const headers = up.retryAfter ? { 'Retry-After': up.retryAfter } : {};
  send(res, up.status >= 400 && up.status < 600 ? up.status : 502, { error: String(msg).slice(0, 400) }, headers);
}

function parseId(raw) {
  const m = /^(single|multi):([\w-]{8,80})$/.exec(raw ?? '');
  if (!m) return null;
  return { endpoint: m[1] === 'single' ? 'image-to-3d' : 'multi-image-to-3d', taskId: m[2] };
}

function mapStatus(t) {
  const map = { PENDING: 'queued', IN_PROGRESS: 'processing', SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELED: 'canceled' };
  let status = map[t.status] ?? 'failed';
  if (status === 'succeeded' && typeof t.expires_at === 'number' && t.expires_at > 0 && t.expires_at < Date.now()) status = 'expired';
  return {
    status,
    progress: typeof t.progress === 'number' ? t.progress : undefined,
    queuePosition: t.status === 'PENDING' && typeof t.preceding_tasks === 'number' ? t.preceding_tasks : undefined,
    error: t.task_error?.message || undefined,
    expiresAt: typeof t.expires_at === 'number' ? t.expires_at : undefined,
  };
}

const server = http.createServer(async (req, res) => {
  const allowed = cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); return res.end(); }
  if (!allowed) return send(res, 403, { error: 'Origin not allowed' });
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'Bridge token required' });
  const url = new URL(req.url ?? '/', 'http://bridge');
  const parts = url.pathname.split('/').filter(Boolean); // ['v1','jobs',id,'model']
  try {
    if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
      return send(res, 200, {
        protocol: 'form-bridge/1', provider: 'Meshy', modes: ['single', 'multi'], maxImages: 4, progress: 'percent', cancel: 'pending-only', outputFormats: ['glb'],
        retentionNote: 'Meshy keeps generated files for 3 days on non-Enterprise plans (docs.meshy.ai, checked 2026-10-21). FORM//ENGINE stores a local copy on download.',
        pricingNote: 'Uses Meshy credits from the key holder\'s account. Exact cost is not verified by FORM//ENGINE — check the Meshy dashboard/pricing.',
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/jobs') {
      const body = await readBody(req);
      const mode = body.mode === 'multi' ? 'multi' : 'single';
      const images = Array.isArray(body.images) ? body.images : [];
      if (!images.length) return send(res, 400, { error: 'No images' });
      if (mode === 'single' && images.length !== 1) return send(res, 400, { error: 'Single-image mode takes exactly one image' });
      if (mode === 'multi' && (images.length < 1 || images.length > 4)) return send(res, 400, { error: 'Meshy multi-image accepts 1–4 images' });
      for (const im of images) {
        const m = IMAGE_RE.exec(typeof im === 'string' ? im : '');
        if (!m) return send(res, 400, { error: 'Images must be base64 PNG/JPEG/WebP data URIs' });
        if (Math.floor(m[2].length * 3 / 4) > 20 * 1024 * 1024) return send(res, 400, { error: 'Image exceeds Meshy 20 MB limit' });
      }
      const options = {};
      for (const [k, v] of Object.entries(body.options ?? {})) if (OPTION_KEYS.has(k) && ['string', 'number', 'boolean'].includes(typeof v)) options[k] = v;
      const payload = { ...options, target_formats: ['glb'], ...(mode === 'single' ? { image_url: images[0] } : { image_urls: images }) };
      const endpoint = mode === 'single' ? 'image-to-3d' : 'multi-image-to-3d';
      const up = await meshy(`/openapi/v1/${endpoint}`, { method: 'POST', body: JSON.stringify(payload) });
      if (up.status >= 300 || !up.json?.result) return upstreamError(res, up);
      log(`submitted ${mode} task ${up.json.result} (${images.length} image(s))`);
      return send(res, 202, { id: `${mode}:${up.json.result}` });
    }
    if (parts[0] === 'v1' && parts[1] === 'jobs' && parts[2]) {
      const id = parseId(decodeURIComponent(parts[2]));
      if (!id) return send(res, 400, { error: 'Bad task id' });
      if (req.method === 'GET' && parts.length === 3) {
        const up = await meshy(`/openapi/v1/${id.endpoint}/${id.taskId}`);
        if (up.status >= 300 || !up.json) return upstreamError(res, up);
        return send(res, 200, { id: parts[2], ...mapStatus(up.json) });
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        const up = await meshy(`/openapi/v1/${id.endpoint}/${id.taskId}`, { method: 'DELETE' });
        if (up.status === 200) return send(res, 200, { canceled: true, note: 'Task deleted at Meshy. Meshy refunds credits only for tasks that were still PENDING.' });
        if (up.status === 409) return send(res, 200, { canceled: false, note: 'Task is already IN_PROGRESS; Meshy cannot stop it and credits are not refunded. Local polling stopped.' });
        return upstreamError(res, up);
      }
      if (req.method === 'GET' && parts[3] === 'model') {
        const up = await meshy(`/openapi/v1/${id.endpoint}/${id.taskId}`);
        if (up.status >= 300 || !up.json) return upstreamError(res, up);
        const st = mapStatus(up.json);
        if (st.status === 'expired') return send(res, 410, { error: 'Result expired at provider' });
        if (st.status !== 'succeeded') return send(res, 409, { error: `Task not finished (${st.status})` });
        const glb = up.json.model_urls?.glb;
        if (!glb) return send(res, 404, { error: 'Provider returned no GLB for this task' });
        let target;
        try { target = new URL(glb); } catch { return send(res, 502, { error: 'Provider returned an invalid model URL' }); }
        const hostOk = ASSET_HOSTS.some((h) => target.hostname === h || target.hostname.endsWith('.' + h));
        if ((target.protocol !== 'https:' && !BASE.startsWith('http://127.0.0.1')) || !hostOk) return send(res, 502, { error: 'Model URL host not on the allowlist' });
        const dl = await fetch(target, { redirect: 'follow' });
        if (dl.status === 403 || dl.status === 404) return send(res, 410, { error: 'Signed result URL expired or missing' });
        if (!dl.ok || !dl.body) return send(res, 502, { error: `Model download failed (${dl.status})` });
        const len = Number(dl.headers.get('content-length') ?? 0);
        if (len > MAX_MODEL) return send(res, 413, { error: 'Model exceeds 300 MB' });
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'no-store', ...(len ? { 'Content-Length': String(len) } : {}) });
        let size = 0;
        for await (const chunk of dl.body) {
          size += chunk.length;
          if (size > MAX_MODEL) { res.destroy(); return; }
          res.write(chunk);
        }
        log(`delivered model for ${parts[2]} (${size} bytes)`);
        return res.end();
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e?.status ?? 502;
    if (!e?.status) log('error', e?.message);
    send(res, status, { error: status === 502 ? 'Bridge could not reach the provider' : String(e.message) });
  }
});

server.listen(PORT, HOST, () => log(`FORM bridge → ${BASE} listening on http://${HOST}:${PORT}; allowed origins: ${ORIGINS.join(', ')}${TOKEN ? '; token required' : ''}`));
