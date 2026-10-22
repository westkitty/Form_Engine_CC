# Image → 3D providers

FORM//ENGINE never fabricates a reconstruction. Image-to-mesh inference runs on a real service you configure, through a small **bridge** server you control. The static web app never contains provider API keys.

```
Browser (FORM//ENGINE) ──FORM Bridge v1 (HTTP+JSON, CORS-restricted)──▶ bridge ──provider API + key──▶ Meshy / your model
```

## Supported today

| Provider | Path | Status |
|---|---|---|
| **Meshy** Image-to-3D and Multi-Image-to-3D (1–4 images) | `server/reconstruction-proxy.mjs` | Adapter implemented against the docs checked on 2026-10-21 (`/openapi/v1/image-to-3d`, `/openapi/v1/multi-image-to-3d`). **Live calls are UNVERIFIED**: no API key was available during development. Exercised against a test fixture that imitates the documented API |
| **Your own local model** (e.g. a TRELLIS-class server on your GPU box) | Implement the 5 routes below | Contract documented; no model ships with FORM//ENGINE |
| Tripo | — | Not implemented. Its API and terms were not reviewed for this release |

## Running the Meshy bridge

```bash
MESHY_API_KEY=msy_xxx \
ALLOWED_ORIGINS=http://localhost:5173,https://you.github.io \
node server/reconstruction-proxy.mjs
# → listening on http://127.0.0.1:8787
```

Then open the **Image Lab** → *Connect Reconstruction* → Bridge URL `http://127.0.0.1:8787` → *Test connection*.

| Variable | Meaning |
|---|---|
| `MESHY_API_KEY` | Required. Kept only in the bridge process; never logged or returned |
| `HOST`, `PORT` | Default `127.0.0.1:8787`, which is local-only. Do not expose it publicly without `BRIDGE_TOKEN` and TLS |
| `ALLOWED_ORIGINS` | CORS allowlist. Requests from other origins get 403 |
| `BRIDGE_TOKEN` | Optional shared secret. The browser sends it as `Authorization: Bearer …`, holds it **in memory only**, and never persists it to projects, IndexedDB, URLs or logs |
| `ASSET_HOSTS` | Host suffixes allowed for result downloads (default `meshy.ai`) |

The bridge validates inputs (PNG/JPEG/WebP data URIs ≤ 20 MB, 1 or 1–4 images) and forwards only allowlisted options (`ai_model`, `should_texture`, `enable_pbr`, `should_remesh`, `target_polycount`, `topology`, `texture_prompt`, `pose_mode`). It always requests GLB, and streams results only from allowlisted hosts with a 300 MB cap.

For a hosted static site, deploy the bridge as your own small server or serverless function behind HTTPS, with `ALLOWED_ORIGINS` set to your site and a `BRIDGE_TOKEN`.

## Costs, retention, cancellation (from Meshy docs, 2026-10-21; verify before use)

- Jobs consume credits from the key holder's Meshy account. FORM//ENGINE does **not** know or display exact prices; the consent dialog says so.
- Meshy keeps generated files for **3 days** on non-Enterprise plans, and signed URLs expire. FORM//ENGINE downloads the GLB immediately and keeps a verified local copy in IndexedDB (`jobresult:<id>`).
- Cancel = `DELETE` the task. Meshy refunds credits only for tasks still `PENDING`. An `IN_PROGRESS` task returns 409: it keeps running and is charged. The UI reports exactly which case happened.
- A failed task consumes 0 credits, according to Meshy.

## Privacy and consent

- Images stay local until you press **Review & submit…** and tick the consent box. The dialog lists:
  - the provider and bridge URL;
  - the number of images, their views and total size;
  - the cost and retention notes;
  - a warning that unseen surfaces will be inferred.
- Only the cropped/rotated image bytes (≤ 2048 px) are sent. No project data, meshes or names leave the device.
- The Image Lab shows a permanent **LOCAL** / **REMOTE** banner.
- The consent record (time, provider, image count) is stored with the job in the project, without the images or any secret.

## Job lifecycle (`src/reconstruction/jobMachine.ts`)

`idle → validating → ready → awaiting-consent → submitting → queued → processing → downloading → verifying → ready-to-edit`, plus `failed`, `canceled`, `expired`, `offline` and `needs-auth`.

- `submit` is called **once**. Poll and download failures never re-submit, so they cannot cause duplicate charges.
- Polling backs off, honours `Retry-After`, and moves to `offline` on network loss. **Resume** continues by task id after a reload.
- Progress bars show a percentage **only** when the provider reports one; otherwise they are indeterminate.
- `ready-to-edit` requires the returned bytes to parse as a mesh and pass validation.
- **Review & adopt** offers:
  - submesh selection, mesh statistics and issues;
  - re-centre/scale, debris removal, winding flip and Y rotation;
  - a side-by-side view with the source image.

  Adopting adds a **new** object tagged with provenance; it never overwrites existing work.

## FORM Bridge v1 protocol (for local/private servers)

| Route | Response |
|---|---|
| `GET /v1/capabilities` | `{ provider, modes: ["single","multi"], maxImages, progress: "percent"\|"discrete", cancel: "pending-only"\|"any"\|"none", outputFormats, retentionNote?, pricingNote? }` |
| `POST /v1/jobs` body `{ mode, images: [dataURI…], views: [...], options: {...} }` | `202 { id }` |
| `GET /v1/jobs/:id` | `{ status: "queued"\|"processing"\|"succeeded"\|"failed"\|"canceled"\|"expired", progress?, queuePosition?, error?, expiresAt? }` |
| `DELETE /v1/jobs/:id` | `{ canceled: boolean, note }` |
| `GET /v1/jobs/:id/model?format=glb` | GLB bytes (`model/gltf-binary`) |

Errors: 401/403 → `needs-auth`, 402 → insufficient credits, 404/410 → expired/missing, 429 (+ `Retry-After`) → rate-limited, 5xx → server. Support CORS for the editor's origin.

A local inference server that implements these routes appears as provider "Mode 4 — local private reconstruction". Bind it to `127.0.0.1` unless you deliberately configure otherwise.
