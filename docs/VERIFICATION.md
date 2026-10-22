# Verification — proof-state matrix

Evidence was produced in this repository's build environment on 2026-10-21/22:

- **Machine:** Linux container, 4 cores.
- **Browser:** headless Chromium 141.
- **GPU:** **SwiftShader** (CPU software rendering, via ANGLE/Vulkan).
- **Machine-readable evidence:** [`docs/evidence/e2e-results.json`](evidence/e2e-results.json) and [`docs/evidence/artifact-results.json`](evidence/artifact-results.json).
- **Screenshots:** [`docs/screenshots/`](screenshots/).
- **Commands:** `npm test` (36 unit/contract tests), `npm run test:e2e` (10 browser journeys), `npm run test:artifact`.

Status values:

- **PASS** — executed, with evidence.
- **UNVERIFIED** — implemented but not executed against the real dependency.
- **BLOCKED** — could not be done here.
- **NOT IMPLEMENTED** — out of this release.

## P0 matrix

| Requirement | Status | Evidence |
|---|---|---|
| Brush strokes change vertex coordinates | PASS | J1: a UI mouse stroke gave `maxDelta 0.088` over 15,872 components. Unit tests cover all 9 brushes (`tests/unit/brushes.test.ts`) |
| Distinct brush math (Draw, Clay, Inflate, Smooth, Grab, Flatten, Pinch, Crease, Mask) | PASS | Unit tests:<br>• Smooth lowers Laplacian energy by more than 40%<br>• Grab moves coherently, leaving the far side at 0<br>• Flatten reduces footprint variance<br>• Clay ≠ Draw; Pinch ≠ Draw ≠ Smooth<br>• Crease cuts inward<br>• Inflate pushes radially |
| Volumetric change visible from other angles | PASS | `screenshots/j1-2-orbited-side.png`. J1 also checks that orbiting does not deform the mesh (`maxDelta 0`) |
| Undo / redo restore exact geometry | PASS | J1: undo → `maxDelta 0` versus post-draw; redo → `0` versus post-smooth. Unit tests cover cancel rollback and stale-patch refusal after a topology change |
| X symmetry | PASS | J1: one stroke moved 2,039 vertices with x<0 and 2,097 with x>0. Unit test: mirror error < 1e-4 |
| Mask protects vertices | PASS | Unit test: masked vertices bit-identical; unmasked neighbours moved. Mask undo verified |
| World ↔ local mapping on transformed objects | PASS | Unit test on a translated, rotated and scaled object: every moved vertex lies within the world-space radius |
| Normals refreshed after edits | PASS | Unit test: stored normals equal a fresh recompute (< 1e-5) after 12 overlapping, partly deferred dabs |
| Subdivide creates real vertices / decimate reduces | PASS | Unit tests: 4× triangles with new vertices; meshoptimizer decimation to 20–70% |
| Import real GLB, inspect, transform, sculpt | PASS | J2: Khronos *Duck.glb* (4,212 tris, textured). Numeric transform applied; sculpt `maxDelta 16.2` (duck local units) |
| Save → reload → reopen → continue editing | PASS | J2: autosave restore Hausdorff `0`; `.formengine` reopened in a new page Hausdorff `0`; texture retained; editing continues |
| GLB export contains post-edit geometry | PASS | J1: downloaded GLB re-imported in a fresh page, Hausdorff `0` to the edited shape and `0.138` to an unedited sphere. J2: edited textured duck GLB, Hausdorff `0`, texture retained |
| OBJ export round trip | PASS | J7: Hausdorff `0` on an asymmetric sculpture (asymmetry vs its mirror: `0.06`). Warning about missing MTL shown |
| STL export round trip (mm) | PASS | J7: Hausdorff `2.5e-5` m after ×1000 unit conversion. Unit-less and no-material warnings shown |
| Malformed / invalid imports don't harm work | PASS | J6: broken GLB, NaN OBJ and junk STL each produce a clear error; scene `maxDelta 0`. A corrupt `.formengine` leaves the open work untouched |
| Autosave recovery and corruption fallback | PASS | J6: reload restores exactly; corrupting the latest slot falls back to the previous slot, with a message |
| WebGL context loss | PASS | J6: `WEBGL_lose_context` shows the recovery overlay; after restore it clears and the objects are intact |
| Image Lab, no provider: honest state | PASS | J4: "Provider not connected", no submit button; reference plane placed (not exported); watertight 2.5D relief labelled as such; sculpting continues |
| Consent before upload | PASS | J3: zero bridge POSTs before consent; Submit stays disabled until the box is ticked |
| Provider job pipeline (state machine, polling, download, verify, adopt, sculpt, export) | PASS (fixture) | J3 and `tests/unit/reconstruction.test.ts` drive the **real** bridge server and runner against a **test-fixture** Meshy-shaped upstream:<br>• exactly 1 submission<br>• real state log queued → processing → downloading → verifying → ready-to-edit<br>• adopted as a `reconstruction` object (4,096 tris)<br>• sculpted (`maxDelta 0.073`); exported GLB re-imports with Hausdorff `0` |
| Failure, expiry, rate-limit (no resubmit), malformed output, cancel semantics, offline → resume, auth | PASS (fixture) | 10 contract tests in `tests/unit/reconstruction.test.ts` |
| **Free on-device image → 3D** | PASS | E2E J8: real Depth Anything V2 download and inference in Chromium (13.1 s).<br>• the mushroom photo became a 47,988-tri, watertight, single-shell, textured mesh<br>• no uploads (only GETs to huggingface.co, its CDN, and jsDelivr)<br>• sculpted (`maxDelta 0.11`); GLB export re-imports with Hausdorff `0`, texture kept<br>Unit tests: `tests/unit/depthMesh.test.ts` (closed/manifold, concave silhouettes, depth-faithful front, sculptable).<br>Also PASS on the live site (`docs/evidence/live-pages-j8.json`): 12.8 s, no uploads |
| Free cloud 3D (TRELLIS Space) | UNVERIFIED (quota) | API verified (connect, session, preprocess OK). Generation refused: "exceeded your ZeroGPU quota" for the container's anonymous allowance. Needs a free HF token to complete a live job |
| **Live image-to-3D with Meshy (paid, optional)** | **UNVERIFIED** | No API key was available. The adapter follows the docs at docs.meshy.ai (2026-10-21). To verify: `MESHY_API_KEY=… npm run proxy`, then run Journey 3 in the UI with a real photo |
| Touch: one-finger sculpt; two-finger navigates without deforming | PASS (emulated) | J5 (CDP touch events, 1024×768): one finger `maxDelta 0.051`; two fingers moved the camera, geometry `maxDelta 0`, no history entry |
| Pen pressure | PASS (emulated) | J5: CDP pen events — force 0.15 → `0.0149`, force 1.0 → `0.0547` |
| Tablet & S Pen behaviour | PASS (emulated) | E2E J9 at 1232×770 (Tab S9 Ultra class):<br>• Size slider drag 0.25 → 0.48<br>• pen stroke raises the surface; **side button** pushes it in<br>• after pen use, a finger drag on the mesh moves nothing (`maxDelta 0`)<br>• two-finger tap undoes, three-finger tap redoes to the exact geometry<br>• manifest is installable (`display: fullscreen`, PNG 192/512 + maskable)<br>Accessibility: `docs/ACCESSIBILITY.md` (all touch targets ≥ 44 px, contrast ≥ 5.8:1) |
| Real tablet / phone hardware | UNVERIFIED | No physical devices here. Layout verified only by emulated viewports (below) |
| Responsive layouts 1440×900, 1024×768, 768×1024, 390×844 | PASS | `screenshots/vqa-*.png`; no horizontal overflow; phone inspector drawer and Image Lab checked |
| No leaked GPU resources / loops | PASS | 20 new-project + import cycles: GPU geometries 6 → 6, textures 7 → 7, overlays = 2 × objects |
| Single-file Claude Artifact build runs the same editor | PASS (local) | `artifact-results.json`. Top level and inside an `allow-scripts`-only sandboxed iframe:<br>• stroke `maxDelta 0.056`; undo and redo exact<br>• IndexedDB correctly reported blocked → save state "unavailable" |
| Published Claude Artifact | PASS (private) | Published with your approval on 2026-10-22. Tested before publishing in a host-style wrapper inside a sandboxed iframe: fits the frame (800/800 px), stroke `maxDelta 0.056`, and export reports "cannot save files" instead of claiming success. The live viewer itself was not automated |
| Static deployment | PASS | https://westkitty.github.io/Form_Engine_CC/ (from the `gh-pages` branch). Live check in Chromium: boots, real stroke `maxDelta 0.056`, no page errors, service worker registered |

## Import / export format matrix

| Format | Import | Export | What survives | What does not |
|---|---|---|---|---|
| GLB | ✔ (Draco, meshopt, KHR materials via three.js) | ✔ | Edited positions, normals, UVs, vertex colours, PBR materials and textures, node transforms (or baked), names | Skinning and morph targets (dropped on import, with a warning); hierarchy flattened to one node per mesh; editor mask |
| glTF + .bin + textures (dropped together) | ✔ | — (P1) | As GLB | Missing sidecar files are reported, not fetched |
| OBJ (+ MTL + textures) | ✔ | ✔ geometry | Positions, normals, UVs; transforms baked | Export writes no `.mtl` or textures (three.js `OBJExporter` limitation) |
| STL (binary/ASCII) | ✔ | ✔ | Triangle surface; unit conversion on export | Colours, UVs, materials, units; triangle soups are welded on import |
| PLY | ✔ (meshes; point clouds refused) | — | Positions, vertex colours | — |
| `.formengine` | ✔ | ✔ | Everything editable (see PROJECT_FORMAT.md) | Provider-side data |
| FBX, USDZ, 3MF | — | — | Not offered: no round-trip was verified | |

## Performance (measured, SwiftShader software GPU — not representative of real GPUs)

These are RAF-paced, scripted 3-second strokes through the same code path as pointer input. Geometry time is CPU time per pointer sample: all dabs including X symmetry, normals, BVH refit and upload range. Frame interval is dominated by SwiftShader's CPU rasterisation at 1440×900; plain orbiting with no sculpting costs the same.

| Mesh | Geometry p50 / p95 (ms) — draw, smooth, clay, grab, pinch | Frame interval p50 while orbiting |
|---|---|---|
| 10.6k tris | 1.3/9.1 · 1.0/2.4 · 0.9/3.4 · 0.7/1.7 · 1.0/2.5 | 117 ms |
| 107k tris | 8.8/24 · 8.5/26 · 8.6/20 · 7.9/20 · 8.7/46 | 300 ms |
| 204k tris | 21/54 · 17/50 · 25/47 · 13/24 · 16/39 | 450 ms |
| 426k tris | 37/92 · 32/81 · 34/91 · 27/38 · 32/90 | 767 ms |

Interpretation:

- **Up to ~100k triangles:** sculpt geometry cost per sample fits a 60 FPS budget on this 4-core container CPU only at p50.
- **~200–430k triangles:** the cost exceeds a frame. The app keeps working (no crash, no data loss) and warns at >500k triangles on import, but interaction will be sluggish.
- **Real-GPU frame rates:** UNVERIFIED. No hardware GPU was available. Run `npm run test:e2e Performance` on a real machine to measure.

## Limitations

1. **Live Meshy** reconstruction is unverified (needs your API key). Tripo is not implemented.
2. **Web Workers are not used.** Decimation, import parsing, validation and export run on the main thread, so very large files freeze the UI briefly.
3. **No dynamic topology, voxel remesh, booleans, sculpt layers, alpha brushes or multires** (P1).
4. **Imported hierarchies are flattened** to one object per mesh (world transforms preserved). Skinning and morphs are dropped.
5. **Brush radius is world-space with average-scale conversion:** on strongly non-uniformly scaled objects the brush footprint is ellipsoidal.
6. **No background removal model is bundled.** "Fit subject" crops using alpha or border-colour difference only.
7. **Smooth-shaded welds:** sculpted regions get smooth (welded) normals. Hard edges on untouched regions are kept.
8. **Revision branches / A–B compare view** (Section 09 premium features) are not implemented. Re-running reconstruction always adds a new object instead.
9. **Not tested on real devices:** iPad, Android tablets, Safari and Firefox. Only Chromium was automated here.
