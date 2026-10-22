# FORM//ENGINE

A browser-native 3D sculpting workbench. You can:

- sculpt real mesh geometry with nine brushes;
- import GLB/glTF/OBJ/STL/PLY and edit the vertices;
- turn images into editable geometry through an honest, clearly labelled pipeline;
- export GLB/OBJ/STL files that contain your edits.

Everything except provider-backed image→3D reconstruction runs locally in the browser. There is no account, backend, telemetry or paid service.

> Status: see [docs/VERIFICATION.md](docs/VERIFICATION.md) for what is proven, with test evidence, and what is not yet verified.

## Quick start

```bash
npm ci
npm run dev            # http://localhost:5173 (temporary dev server)
npm run build          # typecheck + production build → dist/
npm run preview        # serve dist/ at http://localhost:4173
npm test               # geometry, IO round-trip and provider-contract tests (Vitest)
npm run fetch:samples  # download Khronos sample GLBs used by the browser tests
npm run test:e2e       # 7 user journeys + visual QA + leak + perf in headless Chromium (needs `npm run preview` build)
npm run build:artifact # single self-contained HTML → dist-artifact/index.html
npm run test:artifact  # runs that single file top-level and inside a sandboxed iframe
```

Node ≥ 20. The browser tests use Playwright's Chromium. If a project pins a different Playwright version, set `executablePath`.

## What works (local, no provider needed)

| Area | Implemented |
|---|---|
| Brushes | Draw, Clay Build, Inflate, Smooth (Laplacian, boundary-protecting), Grab, Flatten, Pinch, Crease, Mask. Each brush is a distinct operation, documented in `src/sculpt/brushes.ts` |
| Brush controls | World-space radius, strength, falloff (smooth/sphere/linear/sharp/constant), spacing, invert, pen pressure, X/Y/Z symmetry with on-plane snapping, mask clear/invert/fill, per-brush remembered settings |
| Strokes | Transactions: begin → dab → commit/cancel. `pointercancel`, Esc and a second touch roll back exactly. Large pointer jumps are resampled and re-projected onto the surface |
| History | Undo/redo of strokes (compact vertex patches), masks, transforms, add/delete/duplicate/rename, material, topology ops (full snapshots), reference images |
| Topology | Midpoint subdivision (real new vertices, attributes interpolated). Decimation (three.js `SimplifyModifier` = meshoptimizer). Remove debris, flip winding, centre pivot |
| Scene | Multiple objects, outliner with rename/visibility/lock, numeric transforms, transform gizmo, provenance per object |
| View | Orbit/pan/zoom, front/right/top/iso views, ortho toggle, frame, view-mode "Material Theater" (studio, clay, matcap, flat, normals, UV checker, silhouette), wireframe overlay, presentation turntable, diagnostics HUD |
| Mesh anatomy | Watertightness, shells, boundary/non-manifold edges, winding conflicts, degenerate/thin triangles, with explanations |
| Import | GLB, glTF (+ .bin/textures dropped together), OBJ (+ MTL/textures), STL, PLY. Content sniffing, size/complexity limits, validation before anything touches the scene |
| Export | GLB (binary glTF, materials/textures, node transforms or baked), OBJ (geometry/normals/UVs), STL (binary/ASCII, unit conversion, printability warnings) |
| Projects | `.formengine` portable ZIP project ([schema](docs/PROJECT_FORMAT.md)); IndexedDB autosave with two checksummed slots; corruption fallback; local gallery |
| Image Lab | PNG/JPEG/WebP intake (EXIF orientation, size limits), crop/rotate/fit-to-subject, view labels, **Reference sculpt** (guide planes), **2.5D relief** (labelled, not 3D), **provider reconstruction** through a FORM bridge with consent, job state machine and review/adopt |
| Devices | Mouse, pen (pressure), touch (one finger sculpts, two fingers navigate and cancel any stroke), pen-only mode, tablet and phone layouts, high-contrast mode, reduced motion, keyboard access |
| Offline | PWA service worker caches the editor shell and assets (HTTPS only). Reconstruction always needs the network |

## Image → 3D: what is real

- **Reference sculpt** and **2.5D relief** run locally. Relief objects are labelled "2.5D relief — not a 3D reconstruction" in their provenance.
- **Provider reconstruction** uses a real image-to-mesh service through a bridge you run. The bridge for Meshy is `server/reconstruction-proxy.mjs`; a local private inference server can speak the same protocol. Success is declared only after a mesh has been downloaded, parsed and validated. The adopted mesh becomes an ordinary editable object.
- No provider is configured by default. The Image Lab then says **"Provider not connected"**, and nothing fake is offered.
- Setup, security model, consent and costs: [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Keyboard and gestures

| Key | Action | Key | Action |
|---|---|---|---|
| V / T / R | Select / transform / reference | B C N S G | Draw, Clay, Inflate, Smooth, Grab |
| Shift+F, P, E, M | Flatten, Pinch, Crease, Mask | I / X | Invert brush / X symmetry |
| `[` `]` | Radius | Shift+`[` `]` | Strength |
| F | Frame | 1 / 3 / 7 / 0 / 5 | Front, right, top, iso, ortho toggle |
| Ctrl/⌘+Z, Ctrl/⌘+Shift+Z | Undo / redo | Ctrl/⌘+S / E / K / D | Save project, export, commands, duplicate |
| Shift+W, H, Shift+P | Wireframe, HUD, presentation | ? | All shortcuts |
| W/E/R in transform tool | Move / rotate / scale | Space / Alt + drag | Orbit even over the mesh |

**Mouse:** left-drag on the mesh sculpts. Left-drag on the background orbits, right-drag pans, and the wheel zooms.

**Pen:** sculpts, with pressure when the device reports it.

**Touch:** one finger on the mesh sculpts. Two fingers orbit, pan and zoom; if a stroke was in progress, it is rolled back.

## Live

- **Standalone app (GitHub Pages):** https://westkitty.github.io/Form_Engine_CC/. Served from the `gh-pages` branch.
- **Claude Artifact (private):** the single-file build (`npm run build:artifact` → `dist-artifact/form-engine.html`). In the artifact, sculpting, import, the Image Lab, references and relief all work. Export and Save are blocked by the artifact host, and the app says so and links to the standalone app.

## Deploying

To update the live site:

```bash
npx vite build --sourcemap false --outDir /tmp/pages && touch /tmp/pages/.nojekyll
# commit the contents of /tmp/pages to the gh-pages branch (e.g. via `git worktree add ../ghp gh-pages`) and push
```

The `dist/` output is a static site with no secrets. The default `base` is relative (`./`), so it works on nested paths such as GitHub Pages project sites. For absolute URLs, set `BASE_PATH=/<repo>/` at build time.

`.github/workflows/deploy-pages.yml` is an alternative Actions-based deploy and is **manual only** (`workflow_dispatch`). It applies once it is on `main` and Pages' source is switched to "GitHub Actions"; the current source is the `gh-pages` branch. `ci.yml` runs typecheck, tests and both builds on pull requests.

**Supported browsers:** current Chrome/Edge, Firefox and Safari with WebGL 2. Without WebGL 2 the app shows an explanation instead of failing silently.

## Architecture

```
src/geometry/    EditableMesh (welded seams, CSR adjacency, BVH, dirty normals, topology versions), primitives, subdivide/decimate
src/sculpt/      brush math (pure), stroke transactions, symmetry, vertex patches
src/history/     undo/redo stack with memory budget
src/scene/       scene model, objects, provenance
src/viewport/    renderer, cameras, controls, light rig, overlays, render-on-demand loop, context-loss handling
src/io/          importers (sniffing, validation), exporters, mesh diagnostics/repair
src/persistence/ .formengine read/write with migrations, IndexedDB two-slot store
src/reconstruction/ provider contract, job state machine, bridge provider, relief, image intake
src/app/         App controller (commands, autosave), pointer arbitration
src/ui/          DOM shell, Image Lab, export/gallery/palette dialogs
server/          reconstruction bridge (Meshy), zero dependencies
tests/unit/      numeric geometry, IO/project round-trips, provider contract (real bridge + fixture upstream)
tests/e2e/       Playwright journeys, artifact sandbox check
```

The geometry core is imperative and typed-array based. UI panels never hold mesh arrays, and the viewport renders only when something changed.

## Known limitations

See the ledger in [docs/VERIFICATION.md](docs/VERIFICATION.md#limitations). In short:

- No dynamic topology, voxel remesh or booleans.
- Heavy operations (decimate, import parsing) run on the main thread, not in Web Workers.
- Live Meshy reconstruction has not been verified (no credentials in the build environment).
- Performance was measured only on a software (SwiftShader) GPU.
