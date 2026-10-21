import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { analyzeGeometry, blockingProblems, dropBadTriangles, LIMITS, type MeshReport } from './validate';
import { makeClayMaterial, type MaterialParams } from '../scene/SceneModel';

export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'ply';

export interface ImportedMesh {
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  materialParams: MaterialParams;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  report: MeshReport;
}

export interface ImportResult {
  format: ModelFormat;
  fileName: string;
  meshes: ImportedMesh[];
  warnings: string[];
}

export class ImportError extends Error {
  constructor(message: string, readonly remedies: string[] = []) { super(message); }
}

const MODEL_EXT = /\.(glb|gltf|obj|stl|ply)$/i;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const isModelFile = (f: File) => MODEL_EXT.test(f.name);
export const isImageFile = (f: File) => IMAGE_TYPES.includes(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name);

/** Identify the format by content, not just extension. */
export function sniffFormat(buf: ArrayBuffer, name = ''): ModelFormat | null {
  const u8 = new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024));
  if (buf.byteLength >= 12 && new DataView(buf).getUint32(0, true) === 0x46546c67) return 'glb';
  if (buf.byteLength >= 84) {
    const tris = new DataView(buf).getUint32(80, true);
    if (84 + tris * 50 === buf.byteLength) return 'stl';
  }
  const head = new TextDecoder().decode(u8);
  if (/^ply\s/.test(head)) return 'ply';
  if (/^\s*solid\b/.test(head) && /facet|endsolid/.test(new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 65536))))) return 'stl';
  if (/^\s*\{/.test(head) && /"asset"/.test(new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 65536))))) return 'gltf';
  if (/^\s*(#|v |vn |vt |o |g |mtllib |f |s |usemtl )/m.test(head)) return 'obj';
  const ext = name.toLowerCase().match(MODEL_EXT)?.[1] as ModelFormat | undefined;
  return ext ?? null;
}

let dracoLoader: DRACOLoader | null = null;
function gltfLoader(manager?: THREE.LoadingManager) {
  const l = new GLTFLoader(manager);
  if (typeof window !== 'undefined') {
    if (!dracoLoader) { dracoLoader = new DRACOLoader(); dracoLoader.setDecoderPath(`${import.meta.env?.BASE_URL ?? './'}draco/`); }
    l.setDRACOLoader(dracoLoader);
  }
  l.setMeshoptDecoder(MeshoptDecoder);
  return l;
}

/**
 * Import a model from a primary file plus optional sidecar resources (.bin, .mtl, textures).
 * Every mesh is validated before it is returned; blocking problems throw ImportError and nothing is
 * added to the scene.
 */
export async function importModelFiles(files: File[]): Promise<ImportResult> {
  const primary = files.find((f) => /\.(glb|gltf)$/i.test(f.name)) ?? files.find((f) => isModelFile(f));
  if (!primary) throw new ImportError('No supported model file found.', ['Supported: .glb, .gltf (+ .bin/textures), .obj (+ .mtl/textures), .stl, .ply']);
  if (primary.size > LIMITS.maxFileBytes) throw new ImportError(`${primary.name} is ${(primary.size / 1e6).toFixed(0)} MB; the limit is ${LIMITS.maxFileBytes / 1e6} MB.`, ['Decimate the model in another tool first', 'Export as binary GLB with Draco/meshopt compression']);
  const resources = new Map<string, Blob>();
  for (const f of files) if (f !== primary) resources.set(f.name, f);
  return parseModel(await primary.arrayBuffer(), primary.name, resources);
}

export async function parseModel(buf: ArrayBuffer, fileName: string, resources = new Map<string, Blob>()): Promise<ImportResult> {
  const format = sniffFormat(buf, fileName);
  const warnings: string[] = [];
  if (!format) throw new ImportError(`Could not recognise ${fileName} as a 3D model.`, ['Check the file is not corrupted', 'Supported: GLB, glTF, OBJ, STL, PLY']);
  const extFmt = fileName.toLowerCase().match(MODEL_EXT)?.[1];
  if (extFmt && extFmt !== format) warnings.push(`File extension says .${extFmt} but contents look like ${format.toUpperCase()}; reading as ${format.toUpperCase()}.`);

  // Map sidecar file names to blob URLs; untrusted remote URLs inside the model are refused.
  const urls = new Map<string, string>();
  const manager = new THREE.LoadingManager();
  const hasURL = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
  if (hasURL) for (const [name, blob] of resources) urls.set(name.toLowerCase(), URL.createObjectURL(blob));
  const missing: string[] = [];
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    const base = decodeURIComponent(url.split(/[\\/]/).pop() ?? '').toLowerCase();
    const mapped = urls.get(base);
    if (mapped) return mapped;
    missing.push(base);
    return 'data:,'; // never fetch arbitrary network/file paths named by an untrusted model
  });

  let root: THREE.Object3D;
  try {
    switch (format) {
      case 'glb':
      case 'gltf': {
        const gltf = await gltfLoader(manager).parseAsync(format === 'glb' ? buf : new TextDecoder().decode(buf), '');
        root = gltf.scene;
        break;
      }
      case 'obj': {
        const text = new TextDecoder().decode(buf);
        const loader = new OBJLoader(manager);
        const mtlName = text.match(/^mtllib\s+(.+)$/m)?.[1]?.trim();
        if (mtlName) {
          const mtlBlob = resources.get(mtlName) ?? [...resources].find(([n]) => n.toLowerCase() === mtlName.toLowerCase())?.[1];
          if (mtlBlob) {
            const mtl = new MTLLoader(manager).parse(await mtlBlob.text(), '');
            mtl.preload();
            loader.setMaterials(mtl);
          } else warnings.push(`OBJ references material library "${mtlName}" which was not provided; using clay material. Drop the .mtl (and textures) together with the .obj to keep materials.`);
        }
        root = loader.parse(text);
        break;
      }
      case 'stl': {
        const g = new STLLoader().parse(buf);
        root = new THREE.Mesh(g, makeClayMaterial());
        root.name = fileName.replace(/\.[^.]+$/, '');
        warnings.push('STL carries geometry only: no materials, UVs or units. Assumed scene units.');
        break;
      }
      case 'ply': {
        const g = new PLYLoader().parse(buf);
        if (!g.index && g.attributes.position.count % 3 !== 0) throw new ImportError('PLY contains points only (no faces); point clouds cannot be sculpted.');
        root = new THREE.Mesh(g, g.attributes.color ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }) : makeClayMaterial());
        root.name = fileName.replace(/\.[^.]+$/, '');
        break;
      }
    }
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(`Failed to parse ${fileName}: ${(e as Error)?.message ?? e}`, ['The file may be corrupted or use an unsupported extension', 'Try re-exporting as binary GLB']);
  } finally {
    // Textures have been requested by now; revoke on a delay so in-flight image decodes complete.
    if (hasURL) setTimeout(() => { for (const u of urls.values()) URL.revokeObjectURL(u); }, 30_000);
  }
  if (missing.length) warnings.push(`Missing referenced resources (not loaded): ${[...new Set(missing)].slice(0, 6).join(', ')}`);

  const meshes = collectMeshes(root!, warnings);
  if (!meshes.length) throw new ImportError(`${fileName} contains no triangle meshes.`, ['Points, lines and empty scenes cannot be sculpted']);
  const total = meshes.reduce((s, m) => s + m.report.triangles, 0);
  if (total > LIMITS.maxTriangles) throw new ImportError(`${fileName} has ${total.toLocaleString()} triangles; the limit is ${LIMITS.maxTriangles.toLocaleString()}.`, ['Decimate before importing']);
  return { format, fileName, meshes, warnings };
}

function collectMeshes(root: THREE.Object3D, warnings: string[]): ImportedMesh[] {
  root.updateMatrixWorld(true);
  const out: ImportedMesh[] = [];
  let skinned = 0, morph = 0, nonTri = 0, idx = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as any).isMesh) { if ((o as any).isPoints || (o as any).isLine) nonTri++; return; }
    if ((mesh as any).isSkinnedMesh) skinned++;
    if (mesh.geometry.morphAttributes && Object.keys(mesh.geometry.morphAttributes).length) morph++;
    let g = mesh.geometry.clone();
    if ((mesh as any).isInstancedMesh) warnings.push(`Instanced mesh "${mesh.name}" imported as a single instance.`);
    if (!g.attributes.position) return;
    if (!g.index) {
      // Non-indexed soups (STL, OBJ): weld identical positions for sculpt connectivity; normals become smooth.
      const hadNormals = !!g.attributes.normal;
      g.deleteAttribute('normal');
      g = mergeVertices(g, 1e-6);
      g.computeVertexNormals();
      if (hadNormals) warnings.push(`"${mesh.name || 'mesh'}" was a non-indexed triangle soup; vertices were welded and normals recomputed smooth.`);
    } else if (!g.attributes.normal) g.computeVertexNormals();
    const dropped = dropBadTriangles(g);
    if (dropped) warnings.push(`Removed ${dropped} invalid/degenerate triangles from "${mesh.name || 'mesh'}".`);
    const report = analyzeGeometry(g);
    const blocking = blockingProblems(report);
    if (blocking.length) throw new ImportError(`Mesh "${mesh.name || idx}" is invalid: ${blocking.join(' ')}`, ['Repair the mesh in a DCC tool', 'Re-export with "apply transforms" and triangulation enabled']);
    // decompose world transform; bake shear into geometry if the decomposition can't represent it
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    mesh.matrixWorld.decompose(pos, q, s);
    const recomposed = new THREE.Matrix4().compose(pos, q, s);
    if (!matricesClose(recomposed, mesh.matrixWorld)) {
      g.applyMatrix4(mesh.matrixWorld);
      pos.set(0, 0, 0); q.identity(); s.set(1, 1, 1);
      warnings.push(`"${mesh.name}" had a sheared transform; it was baked into the vertices.`);
    }
    const material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : (mesh.material as THREE.Material).clone();
    const first = (Array.isArray(material) ? material[0] : material) as THREE.MeshStandardMaterial;
    out.push({
      name: mesh.name || `Mesh ${++idx}`, geometry: g, material, position: pos, quaternion: q, scale: s, report,
      materialParams: { kind: 'imported', color: '#' + (first.color?.getHexString?.() ?? 'cccccc'), roughness: first.roughness ?? 0.6, metalness: first.metalness ?? 0 },
    });
  });
  if (skinned) warnings.push(`${skinned} skinned mesh(es): skinning was dropped; the bind pose is sculpted.`);
  if (morph) warnings.push(`${morph} mesh(es) had morph targets; they were dropped.`);
  if (nonTri) warnings.push(`${nonTri} point/line object(s) ignored.`);
  return out;
}

function matricesClose(a: THREE.Matrix4, b: THREE.Matrix4) {
  for (let i = 0; i < 16; i++) if (Math.abs(a.elements[i] - b.elements[i]) > 1e-5 * (1 + Math.abs(b.elements[i]))) return false;
  return true;
}
