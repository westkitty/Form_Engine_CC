/**
 * Provider contract tests: real BridgeProvider + real bridge server (server/reconstruction-proxy.mjs) +
 * real JobRunner, against a TEST FIXTURE upstream (tests/fixtures/mock-meshy-server.mjs). These prove the
 * pipeline mechanics; they do NOT prove live Meshy reconstruction (that requires credentials).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { BridgeProvider } from '../../src/reconstruction/bridgeProvider';
import { JobRunner, newJob, transition, type JobRecord } from '../../src/reconstruction/jobMachine';
import type { SourceImage } from '../../src/reconstruction/types';
import { parseModel } from '../../src/io/importers';

const FIX = 'test-results/fixtures';
let meshy: ChildProcess, bridge: ChildProcess, meshyPort = 0, bridgePort = 0;

function waitFor(proc: ChildProcess, re: RegExp): Promise<RegExpMatchArray> {
  return new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${re}: ${buf}`)), 10000);
    proc.stdout!.on('data', (d) => { buf += d; const m = buf.match(re); if (m) { clearTimeout(t); res(m); } });
    proc.stderr!.on('data', (d) => { buf += d; });
  });
}

beforeAll(async () => {
  if (typeof (globalThis as any).FileReader === 'undefined') {
    (globalThis as any).FileReader = class {
      result: any = null; onload: any = null; onloadend: any = null; onerror: any = null;
      readAsArrayBuffer(b: Blob) { b.arrayBuffer().then((r) => { this.result = r; this.onload?.(); this.onloadend?.(); }); }
      readAsDataURL(b: Blob) { b.arrayBuffer().then((r) => { this.result = `data:${b.type};base64,${Buffer.from(r).toString('base64')}`; this.onload?.(); this.onloadend?.(); }); }
    };
  }
  mkdirSync(FIX, { recursive: true });
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.4, 0.12, 128, 16), new THREE.MeshStandardMaterial({ color: 0x8899aa }));
  knot.name = 'FixtureReconstruction';
  const glb = await new GLTFExporter().parseAsync(knot, { binary: true }) as ArrayBuffer;
  writeFileSync(`${FIX}/fixture-reconstruction.glb`, Buffer.from(glb));
  meshy = spawn('node', ['tests/fixtures/mock-meshy-server.mjs'], { env: { ...process.env, FIXTURE_GLB: `${FIX}/fixture-reconstruction.glb`, MOCK_KEY: 'test-key' } });
  meshyPort = +(await waitFor(meshy, /MOCK_MESHY_PORT=(\d+)/))[1];
  bridgePort = 18000 + Math.floor(Math.random() * 2000);
  bridge = spawn('node', ['server/reconstruction-proxy.mjs'], { env: { ...process.env, MESHY_API_KEY: 'test-key', MESHY_BASE: `http://127.0.0.1:${meshyPort}`, ASSET_HOSTS: '127.0.0.1', PORT: String(bridgePort), BRIDGE_TOKEN: 'bridge-secret' } });
  await waitFor(bridge, /listening/);
}, 20000);

afterAll(() => { meshy?.kill(); bridge?.kill(); });

const img = (): SourceImage => ({ id: 'img1', name: 'front.png', view: 'front', mime: 'image/png', width: 1, height: 1, blob: new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }) });
const fast = { pollMs: 5, maxPollMs: 50, maxPollErrors: 4, timeoutMs: 20000 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 30)));
const stats = async () => (await fetch(`http://127.0.0.1:${meshyPort}/__stats`)).json();

function run(provider: BridgeProvider, scenario: string, mode: 'single' | 'multi' = 'single', images = [img()]) {
  const updates: JobRecord[] = [];
  let job = newJob('j1', provider.id, mode, images);
  job = transition(transition(transition(job, 'validating'), 'ready'), 'awaiting-consent');
  const runner = new JobRunner(provider, job, {
    onUpdate: (j) => updates.push(j),
    verify: async (data, name) => { const r = await parseModel(data, name); if (!r.meshes.length) throw new Error('no meshes'); },
    sleep: (ms, signal) => new Promise((res, rej) => { if (signal.aborted) return rej(new Error('aborted')); sleep(ms).then(res); }),
  }, fast);
  return { runner, updates, go: () => runner.submitAndRun(images, { texture_prompt: scenario }, 'test consent') };
}

describe('FORM bridge + Meshy-shaped upstream (fixture)', () => {
  const provider = () => new BridgeProvider(`http://127.0.0.1:${bridgePort}`, 'bridge-secret');

  it('reports needs-auth without the bridge token and offline for an unreachable bridge', async () => {
    const noTok = new BridgeProvider(`http://127.0.0.1:${bridgePort}`, null);
    await expect(noTok.capabilities()).rejects.toMatchObject({ info: { code: 'needs-auth' } });
    const dead = new BridgeProvider('http://127.0.0.1:1', null);
    await expect(dead.capabilities()).rejects.toMatchObject({ info: { code: 'offline' } });
    const caps = await provider().capabilities();
    expect(caps.provider).toBe('Meshy');
    expect(caps.maxImages).toBe(4);
  });

  it('single image: real states → download → verify → ready-to-edit; mesh parses', async () => {
    const before = await stats();
    const { runner, updates, go } = run(provider(), 'ok');
    const job = await go();
    expect(job.state).toBe('ready-to-edit');
    expect(job.remoteId).toMatch(/^single:fixture-/);
    const seen = updates.map((u) => u.state);
    expect(seen).toContain('queued');
    expect(seen).toContain('processing');
    expect(seen.indexOf('downloading')).toBeLessThan(seen.indexOf('verifying'));
    // progress values come from the provider, not invented
    expect(updates.filter((u) => u.state === 'processing').every((u) => typeof u.progress === 'number')).toBe(true);
    const parsed = await parseModel(runner.resultBytes!, runner.resultFileName);
    expect(parsed.meshes[0].report.triangles).toBeGreaterThan(1000);
    expect((await stats()).submissions - before.submissions).toBe(1);
  });

  it('multi-view sends the actual image set (not a collage)', async () => {
    const imgs = [img(), { ...img(), id: 'img2', view: 'right' as const }, { ...img(), id: 'img3', view: 'back' as const }];
    const { go } = run(provider(), 'ok', 'multi', imgs);
    const job = await go();
    expect(job.remoteId).toMatch(/^multi:/);
    expect(job.state).toBe('ready-to-edit');
  });

  it('provider failure → failed with provider message', async () => {
    const job = await run(provider(), 'fail').go();
    expect(job.state).toBe('failed');
    expect(job.error?.message).toMatch(/Fixture: generation failed/);
  });

  it('expired result → expired', async () => {
    const job = await run(provider(), 'expire').go();
    expect(job.state).toBe('expired');
  });

  it('rate limit (429 + Retry-After) is retried by polling without re-submitting', async () => {
    const before = await stats();
    const job = await run(provider(), 'ratelimit').go();
    expect(job.state).toBe('ready-to-edit');
    expect((await stats()).submissions - before.submissions).toBe(1);
  });

  it('malformed returned model → failed at verification (never ready-to-edit)', async () => {
    const job = await run(provider(), 'garbage').go();
    expect(job.state).toBe('failed');
    expect(job.history.map((h) => h.state)).toContain('verifying');
  });

  it('cancel while running reports what upstream actually allowed', async () => {
    const { runner, go } = run(provider(), 'slow');
    const p = go();
    await new Promise((r) => setTimeout(r, 150));
    const note = await runner.cancel();
    await p;
    expect(runner.job.state).toBe('canceled');
    expect(note).toMatch(/IN_PROGRESS|refund/i);
  });

  it('network loss → offline; resume by task id completes without a second submission', async () => {
    const before = await stats();
    const { runner, go } = run(provider(), 'ok');
    // Kill the bridge mid-flight by pointing at a dead port after submission.
    const p = provider();
    const realPoll = p.poll.bind(p);
    let calls = 0;
    (runner as any).provider = Object.assign(Object.create(Object.getPrototypeOf(p)), p, {
      poll: async (id: string, s?: AbortSignal) => { if (++calls === 2) return new BridgeProvider('http://127.0.0.1:1', null).poll(id, s); return realPoll(id, s); },
    });
    let job = await go();
    expect(job.state).toBe('offline');
    job = await runner.resume();
    expect(job.state).toBe('ready-to-edit');
    expect((await stats()).submissions - before.submissions).toBe(1);
  });

  it('job machine rejects illegal transitions (cannot jump to ready-to-edit)', () => {
    const j = newJob('x', 'p', 'single', [img()]);
    expect(() => transition(j, 'ready-to-edit')).toThrow(/Illegal/);
    expect(() => transition(transition(transition(j, 'validating'), 'ready'), 'submitting')).toThrow(/Illegal/); // consent required first
  });
});
