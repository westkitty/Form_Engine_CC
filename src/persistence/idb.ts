/**
 * Local project store in IndexedDB. Each project keeps two blob slots (A/B). A save writes the slot not
 * currently marked latest, with a SHA-256 checksum and a monotonically increasing generation, then flips
 * the pointer in the same transaction. A stale queued write (lower generation) is rejected, and a slot
 * whose checksum fails falls back to the other slot.
 */
export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: string;
  createdAt: string;
  bytes: number;
  thumbnail?: string;
  generation: number;
  latestSlot: 'A' | 'B';
  checksums: { A?: string; B?: string };
  generations: { A?: number; B?: number };
}

const DB = 'formengine';
const VERSION = 1;

export function storageAvailable() { return typeof indexedDB !== 'undefined'; }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
}

let dbp: Promise<IDBDatabase> | null = null;
const db = () => (dbp ??= open());

function p<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error ?? new Error('aborted')); });
}

async function sha(data: Uint8Array) {
  const h = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const d = await db();
  const all = await p(d.transaction('meta').objectStore('meta').getAll()) as ProjectMeta[];
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Save; `generation` must exceed the stored one or the write is skipped (stale). */
export async function saveProject(id: string, name: string, data: Uint8Array, generation: number, thumbnail?: string): Promise<'saved' | 'stale'> {
  const checksum = await sha(data);
  const d = await db();
  const tx = d.transaction(['meta', 'blobs'], 'readwrite');
  const metaStore = tx.objectStore('meta');
  const existing = await p(metaStore.get(id)) as ProjectMeta | undefined;
  if (existing && existing.generation >= generation) { tx.abort(); return 'stale'; }
  const slot: 'A' | 'B' = existing?.latestSlot === 'A' ? 'B' : 'A';
  tx.objectStore('blobs').put(new Blob([data as Uint8Array<ArrayBuffer>]), `${id}:${slot}`);
  const now = new Date().toISOString();
  const meta: ProjectMeta = {
    id, name, updatedAt: now, createdAt: existing?.createdAt ?? now, bytes: data.byteLength, thumbnail: thumbnail ?? existing?.thumbnail,
    generation, latestSlot: slot,
    checksums: { ...existing?.checksums, [slot]: checksum }, generations: { ...existing?.generations, [slot]: generation },
  };
  metaStore.put(meta);
  try { await done(tx); } catch (e) { if ((e as DOMException)?.name === 'AbortError') return 'stale'; throw e; }
  return 'saved';
}

/** Load the newest slot whose checksum verifies; falls back to the older slot. */
export async function loadProject(id: string): Promise<{ data: Uint8Array; slot: 'A' | 'B'; recoveredFromOlder: boolean } | null> {
  const d = await db();
  const tx = d.transaction(['meta', 'blobs']);
  const meta = await p(tx.objectStore('meta').get(id)) as ProjectMeta | undefined;
  if (!meta) return null;
  const order: ('A' | 'B')[] = meta.latestSlot === 'A' ? ['A', 'B'] : ['B', 'A'];
  const blobs = await Promise.all(order.map((s) => p(tx.objectStore('blobs').get(`${id}:${s}`)) as Promise<Blob | undefined>));
  for (let i = 0; i < order.length; i++) {
    const b = blobs[i];
    if (!b) continue;
    const data = new Uint8Array(await b.arrayBuffer());
    if ((await sha(data)) === meta.checksums[order[i]]) return { data, slot: order[i], recoveredFromOlder: i > 0 };
  }
  return null;
}

export async function deleteProject(id: string) {
  const d = await db();
  const tx = d.transaction(['meta', 'blobs'], 'readwrite');
  tx.objectStore('meta').delete(id);
  tx.objectStore('blobs').delete(`${id}:A`);
  tx.objectStore('blobs').delete(`${id}:B`);
  await done(tx);
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return p(d.transaction('kv').objectStore('kv').get(key)) as Promise<T | undefined>;
}
export async function kvSet(key: string, value: unknown) {
  const d = await db();
  const tx = d.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(value, key);
  await done(tx);
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch { return null; }
}
