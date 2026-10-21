import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/**
 * Canonical editable mesh. Owns a single indexed BufferGeometry whose typed arrays are mutated in place
 * by sculpt brushes. Rendering, history, persistence and export all read these same arrays.
 *
 * Vertices that share a position (UV / normal seams) are "welded" into a canonical vertex so a brush
 * moves every copy identically and never tears seams; the copies keep their own UVs and attributes.
 */
export class EditableMesh {
  geometry: THREE.BufferGeometry;
  positions!: Float32Array;
  normals!: Float32Array;
  index!: Uint32Array;
  /** Per-vertex mask weight in [0,1]; 1 = fully protected from sculpting. Stored as the `aMask` attribute. */
  mask!: Float32Array;
  vertexCount = 0;
  triangleCount = 0;

  /** vertex -> canonical vertex (lowest vertex index at that position). */
  weldOf!: Int32Array;
  /** CSR: canonical vertex -> all vertices sharing its position. */
  dupStart!: Int32Array;
  dupList!: Int32Array;
  /** CSR: canonical vertex -> neighbouring canonical vertices (edge-connected). */
  adjStart!: Int32Array;
  adjList!: Int32Array;
  /** CSR: vertex -> incident triangles. */
  triStart!: Int32Array;
  triList!: Int32Array;
  /** 1 if the canonical vertex lies on an open boundary edge. */
  boundary!: Uint8Array;
  /** Scratch stamp array for dedupe without allocation. */
  private stamp!: Int32Array;
  private stampId = 1;

  bvh!: MeshBVH;
  /** Incremented every time vertex positions change (refit is valid). */
  positionVersion = 0;
  /**
   * Identity of the current vertex set (count + order). Globally unique per new topology; restoring a
   * snapshot restores its version so vertex patches recorded against it become valid again.
   */
  topologyVersion = 0;
  static nextTopology = 1;

  constructor(geometry: THREE.BufferGeometry) {
    this.geometry = prepareGeometry(geometry);
    this.rebuildTopology();
  }

  /** Rebuild every derived structure. Call after any topology change. */
  rebuildTopology(restoreVersion?: number) {
    const g = this.geometry;
    this.positions = g.attributes.position.array as Float32Array;
    if (!g.attributes.normal) g.computeVertexNormals();
    this.normals = g.attributes.normal.array as Float32Array;
    this.vertexCount = g.attributes.position.count;
    if (!g.attributes.aMask || g.attributes.aMask.count !== this.vertexCount) {
      g.setAttribute('aMask', new THREE.BufferAttribute(new Float32Array(this.vertexCount), 1));
    }
    this.mask = g.attributes.aMask.array as Float32Array;

    // BVH build reorders the index buffer in place; build it first so all triangle adjacency matches.
    this.bvh = new MeshBVH(g, { targetLeafSize: 16 });
    (g as any).boundsTree = this.bvh;
    this.index = g.index!.array as Uint32Array;
    this.triangleCount = this.index.length / 3;

    this.buildWeld();
    this.buildAdjacency();
    this.stamp = new Int32Array(this.vertexCount);
    this.stampId = 1;
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.topologyVersion = restoreVersion ?? EditableMesh.nextTopology++;
    this.positionVersion++;
  }

  private buildWeld() {
    const n = this.vertexCount;
    const p = this.positions;
    const box = new THREE.Box3().setFromBufferAttribute(this.geometry.attributes.position as THREE.BufferAttribute);
    const diag = Math.max(box.getSize(new THREE.Vector3()).length(), 1e-9);
    const q = 1 / (diag * 1e-6);
    const map = new Map<string, number>();
    const weld = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const key = `${Math.round(p[i * 3] * q)},${Math.round(p[i * 3 + 1] * q)},${Math.round(p[i * 3 + 2] * q)}`;
      const c = map.get(key);
      if (c === undefined) { map.set(key, i); weld[i] = i; } else weld[i] = c;
    }
    this.weldOf = weld;
    const count = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) count[weld[i] + 1]++;
    for (let i = 0; i < n; i++) count[i + 1] += count[i];
    const list = new Int32Array(n);
    const fill = count.slice(0, n);
    for (let i = 0; i < n; i++) list[fill[weld[i]]++] = i;
    this.dupStart = count;
    this.dupList = list;
  }

  private buildAdjacency() {
    const n = this.vertexCount;
    const idx = this.index;
    const w = this.weldOf;
    const triCount = idx.length / 3;
    // vertex -> triangles
    const tc = new Int32Array(n + 1);
    for (let t = 0; t < idx.length; t++) tc[idx[t] + 1]++;
    for (let i = 0; i < n; i++) tc[i + 1] += tc[i];
    const tl = new Int32Array(idx.length);
    const tf = tc.slice(0, n);
    for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) tl[tf[idx[t * 3 + k]]++] = t;
    this.triStart = tc;
    this.triList = tl;

    // canonical edges, counted to detect boundaries
    const edgeCount = new Map<number, number>();
    const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const a = w[idx[t * 3 + k]], b = w[idx[t * 3 + ((k + 1) % 3)]];
        if (a === b) continue;
        const kk = key(a, b);
        edgeCount.set(kk, (edgeCount.get(kk) ?? 0) + 1);
      }
    }
    const deg = new Int32Array(n + 1);
    const boundary = new Uint8Array(n);
    for (const [kk, c] of edgeCount) {
      const a = Math.floor(kk / n), b = kk - a * n;
      deg[a + 1]++; deg[b + 1]++;
      if (c === 1) { boundary[a] = 1; boundary[b] = 1; }
    }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const adj = new Int32Array(deg[n]);
    const af = deg.slice(0, n);
    for (const kk of edgeCount.keys()) {
      const a = Math.floor(kk / n), b = kk - a * n;
      adj[af[a]++] = b; adj[af[b]++] = a;
    }
    this.adjStart = deg;
    this.adjList = adj;
    this.boundary = boundary;
  }

  /** Begin a dedupe pass; returns a stamp id for use with `mark`. */
  nextStamp() {
    if (++this.stampId > 0x7ffffff0) { this.stamp.fill(0); this.stampId = 1; }
    return this.stampId;
  }
  mark(v: number, id: number) {
    if (this.stamp[v] === id) return false;
    this.stamp[v] = id;
    return true;
  }

  /**
   * Collect canonical vertices within `radius` of `center` (local space).
   * Uses BVH shapecast; returns traversed node indices for incremental refit.
   */
  queryCanonical(center: THREE.Vector3, radius: number, out: number[], traversed?: Set<number>): number[] {
    out.length = 0;
    const sphere = _sphere.set(center, radius);
    const r2 = radius * radius;
    const id = this.nextStamp();
    const idx = this.index, p = this.positions, w = this.weldOf;
    this.bvh.shapecast({
      intersectsBounds: (box, _isLeaf, _score, _depth, nodeIndex) => {
        if (traversed) traversed.add(nodeIndex);
        return sphere.intersectsBox(box) ? (box.containsPoint(center) ? 2 : 1) as any : 0 as any;
      },
      intersectsTriangle: (_tri, triIndex) => {
        for (let k = 0; k < 3; k++) {
          const c = w[idx[triIndex * 3 + k]];
          if (!this.mark(c, id)) continue;
          const dx = p[c * 3] - center.x, dy = p[c * 3 + 1] - center.y, dz = p[c * 3 + 2] - center.z;
          if (dx * dx + dy * dy + dz * dz <= r2) out.push(c);
        }
        return false;
      },
    });
    return out;
  }

  /** Write the canonical position to every welded copy. */
  setCanonical(c: number, x: number, y: number, z: number) {
    const p = this.positions;
    for (let j = this.dupStart[c]; j < this.dupStart[c + 1]; j++) {
      const v = this.dupList[j] * 3;
      p[v] = x; p[v + 1] = y; p[v + 2] = z;
    }
  }

  setCanonicalMask(c: number, m: number) {
    for (let j = this.dupStart[c]; j < this.dupStart[c + 1]; j++) this.mask[this.dupList[j]] = m;
  }

  /**
   * Recompute smooth (welded, area-weighted) normals for the given canonical vertices and their one-ring.
   * Untouched vertices keep their original (possibly hard-edged) normals.
   */
  updateNormals(canonical: ArrayLike<number>) {
    const p = this.positions, nrm = this.normals, idx = this.index, w = this.weldOf;
    const id = this.nextStamp();
    const verts: number[] = [];
    const pushC = (c: number) => { if (this.mark(c, id)) verts.push(c); };
    for (let i = 0; i < canonical.length; i++) {
      const c = canonical[i];
      pushC(c);
      for (let j = this.adjStart[c]; j < this.adjStart[c + 1]; j++) pushC(this.adjList[j]);
    }
    for (const c of verts) {
      let nx = 0, ny = 0, nz = 0;
      for (let d = this.dupStart[c]; d < this.dupStart[c + 1]; d++) {
        const v = this.dupList[d];
        for (let t = this.triStart[v]; t < this.triStart[v + 1]; t++) {
          const tri = this.triList[t] * 3;
          const a = idx[tri] * 3, b = idx[tri + 1] * 3, cc = idx[tri + 2] * 3;
          const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
          const e2x = p[cc] - p[a], e2y = p[cc + 1] - p[a + 1], e2z = p[cc + 2] - p[a + 2];
          nx += e1y * e2z - e1z * e2y; ny += e1z * e2x - e1x * e2z; nz += e1x * e2y - e1y * e2x;
        }
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (let d = this.dupStart[c]; d < this.dupStart[c + 1]; d++) {
        const v = this.dupList[d] * 3;
        nrm[v] = nx; nrm[v + 1] = ny; nrm[v + 2] = nz;
      }
    }
    void w;
  }

  /** Mark buffers dirty and refit the BVH (topology unchanged). */
  commitPositions(traversed?: Set<number>) {
    const g = this.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    if (traversed && traversed.size) this.bvh.refit(traversed);
    else this.bvh.refit();
    this.positionVersion++;
  }

  commitMask() {
    this.geometry.attributes.aMask.needsUpdate = true;
  }

  finalizeBounds() {
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
  }

  /** Replace the whole geometry (topology change). */
  replaceGeometry(geometry: THREE.BufferGeometry, restoreVersion?: number) {
    const old = this.geometry;
    const prepared = prepareGeometry(geometry);
    // Swap arrays into the existing geometry object so meshes referencing it stay valid.
    for (const name of Object.keys(old.attributes)) old.deleteAttribute(name);
    for (const [name, attr] of Object.entries(prepared.attributes)) old.setAttribute(name, attr);
    old.setIndex(prepared.index);
    old.clearGroups();
    for (const gr of prepared.groups) old.addGroup(gr.start, gr.count, gr.materialIndex);
    old.boundingBox = null; old.boundingSphere = null;
    this.rebuildTopology(restoreVersion);
  }

  /** Snapshot of all geometry arrays (for topology-change undo and persistence). */
  snapshot(): GeometrySnapshot {
    const attrs: GeometrySnapshot['attributes'] = {};
    for (const [name, a] of Object.entries(this.geometry.attributes)) {
      const attr = a as THREE.BufferAttribute;
      attrs[name] = { array: (attr.array as Float32Array).slice(), itemSize: attr.itemSize, normalized: attr.normalized };
    }
    return { attributes: attrs, index: this.index.slice(), groups: this.geometry.groups.map((g) => ({ ...g })), topologyVersion: this.topologyVersion };
  }

  stats() {
    const bb = this.geometry.boundingBox ?? new THREE.Box3();
    return {
      vertices: this.vertexCount,
      triangles: this.triangleCount,
      welded: this.dupStart ? countUnique(this.weldOf) : 0,
      boundaryVertices: this.boundary.reduce((s, b) => s + b, 0),
      bounds: { min: bb.min.toArray(), max: bb.max.toArray() },
    };
  }
}

const _sphere = new THREE.Sphere();

function countUnique(weld: Int32Array) {
  let n = 0;
  for (let i = 0; i < weld.length; i++) if (weld[i] === i) n++;
  return n;
}

export interface GeometrySnapshot {
  attributes: Record<string, { array: Float32Array | Uint16Array | Uint8Array | Int16Array | Int8Array | Uint32Array; itemSize: number; normalized: boolean }>;
  index: Uint32Array;
  groups: { start: number; count: number; materialIndex?: number }[];
  topologyVersion: number;
}

export function geometryFromSnapshot(s: GeometrySnapshot): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(s.attributes)) g.setAttribute(name, new THREE.BufferAttribute(a.array.slice(), a.itemSize, a.normalized));
  g.setIndex(new THREE.BufferAttribute(s.index.slice(), 1));
  for (const gr of s.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  return g;
}

/**
 * Normalize any incoming geometry into the editable layout: indexed (Uint32), Float32 positions/normals,
 * no interleaving, no morph targets. Non-indexed geometry gets a trivial index (welding handles sharing).
 */
export function prepareGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(src.attributes)) {
    const attr = a as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    if (name === 'position' || name === 'normal' || name === 'aMask') {
      const arr = new Float32Array(attr.count * attr.itemSize);
      for (let i = 0; i < attr.count; i++) for (let k = 0; k < attr.itemSize; k++) arr[i * attr.itemSize + k] = attr.getComponent(i, k);
      g.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize));
    } else if (name === 'uv' || name === 'uv1' || name === 'color' || name === 'tangent') {
      const arr = new Float32Array(attr.count * attr.itemSize);
      for (let i = 0; i < attr.count; i++) for (let k = 0; k < attr.itemSize; k++) arr[i * attr.itemSize + k] = attr.getComponent(i, k);
      g.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize));
    }
    // skin/morph attributes are intentionally dropped: sculpting a skinned mesh's bind pose is out of scope.
  }
  const count = g.attributes.position.count;
  let index: Uint32Array;
  if (src.index) {
    index = new Uint32Array(src.index.count);
    for (let i = 0; i < src.index.count; i++) index[i] = src.index.getX(i);
  } else {
    index = new Uint32Array(count);
    for (let i = 0; i < count; i++) index[i] = i;
  }
  g.setIndex(new THREE.BufferAttribute(index, 1));
  for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  // tangents become stale after sculpting; drop them rather than export wrong data.
  if (g.attributes.tangent) g.deleteAttribute('tangent');
  return g;
}
