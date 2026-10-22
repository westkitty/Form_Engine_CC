# FORM//ENGINE — P0 task ledger

Status values: PASS (with evidence) · UNVERIFIED (reason) · BLOCKED (reason) · NEEDS-APPROVAL. Full evidence: docs/VERIFICATION.md

| # | P0 item | Status | Evidence |
|---|---------|--------|----------|
| 1 | Editable mesh core (weld, adjacency, BVH, normals, topology versions) | PASS | tests/unit/brushes.test.ts |
| 2 | Brushes: Draw, Inflate, Clay, Smooth, Grab, Flatten, Pinch, Crease, Mask | PASS | unit tests + E2E J1 |
| 3 | Symmetry + mask protection | PASS | unit tests + J1 |
| 4 | Undo/redo transactions, cancel rollback | PASS | unit tests + J1, J5 |
| 5 | Viewport: orbit/pan/zoom, views, ortho, cursor, render-on-demand, context loss | PASS | J1, J6 |
| 6 | Transform tools + numeric entry | PASS | J2 |
| 7 | Subdivide (real) / decimate (meshoptimizer) | PASS | unit tests |
| 8 | Import GLB/glTF/OBJ/STL/PLY + validation | PASS | io.test.ts, J2, J6 |
| 9 | Export GLB/OBJ/STL + roundtrip | PASS | io.test.ts, J1, J2, J7 |
| 10 | Native project file (.formengine) save/open | PASS | io.test.ts, J2 |
| 11 | IndexedDB autosave + recovery + gallery | PASS | J2, J6 |
| 12 | Image lab: intake, reference planes, consent | PASS | J3, J4 |
| 13 | Provider contract + Meshy bridge + job state machine | PASS (fixture upstream) | reconstruction.test.ts, J3 |
| 14 | 2.5D relief mode (labelled) | PASS | J4 |
| 15 | Touch / pen / two-finger navigation | PASS (emulated) | J5 |
| 16 | Diagnostics HUD + perf measurement | PASS (SwiftShader only) | e2e-results.json Performance |
| 17 | Responsive layout + a11y basics | PASS (emulated viewports) | vqa screenshots |
| 18 | Single-file artifact build | PASS locally · publish NEEDS-APPROVAL | artifact-results.json |
| 19 | README, provider guide, format matrix, schema | PASS | README.md, docs/ |
| 20 | Live image-to-3D (Meshy) | UNVERIFIED | needs MESHY_API_KEY |
| 21 | Real-GPU performance, real tablets, Safari/Firefox | UNVERIFIED | no hardware/browsers in build env |
| 22 | Public deployment | NEEDS-APPROVAL | manual workflow prepared |
