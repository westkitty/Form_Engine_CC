# `.formengine` project format (schema v1)

A `.formengine` file is a standard ZIP archive, written with `fflate`. You can inspect it with any unzip tool. A sample produced by the test suite is at `docs/samples/asymmetric-sculpture.formengine`.

```
manifest.json                       project manifest (below)
materials.json                      three.js Object3D JSON of placeholder meshes carrying each object's material
                                    (textures embedded as data-URI images). Restored with THREE.ObjectLoader.
geometry/<objectId>/<attr>.f32      raw little-endian Float32 attribute data (position, normal, uv, color, aMask, …)
geometry/<objectId>/index.u32       raw little-endian Uint32 triangle index
images/<referenceId>                reference image bytes (PNG/JPEG/WebP as added)
```

## manifest.json

```jsonc
{
  "format": "formengine-project",
  "schemaVersion": 1,
  "generator": "FORM//ENGINE 0.1.0",
  "savedAt": "2026-10-21T23:06:00.000Z",
  "id": "proj_…",
  "name": "Untitled sculpture",
  "units": "m",            // m | cm | mm | in (scene units)
  "upAxis": "Y",
  "camera": { "position": [x,y,z], "target": [x,y,z], "ortho": false },
  "settings": { "viewMode": "studio", "symmetry": {"x":true,"y":false,"z":false}, "brush": "draw" },
  "objects": [{
    "id": "obj_…", "name": "Clay Sphere", "visible": true, "locked": false,
    "transform": { "position": [3], "quaternion": [4], "scale": [3] },
    "materialParams": { "kind": "clay"|"imported", "color": "#c9b8a3", "roughness": 0.62, "metalness": 0 },
    "materialRef": 0,      // index into materials.json children
    "geometry": {
      "vertexCount": 24012,
      "index": "geometry/obj_…/index.u32",
      "attributes": { "position": { "file": "…/position.f32", "itemSize": 3, "normalized": false, "type": "f32" }, … },
      "groups": [{ "start": 0, "count": 72060, "materialIndex": 0 }]
    },
    "provenance": { "source": "primitive"|"import"|"reconstruction"|"relief"|"project", "detail": "…",
                    "provider": "…", "jobId": "…", "sourceImages": ["img_…"], "inferredWarning": "…", "createdAt": "…" }
  }],
  "references": [{ "id": "ref_…", "name": "front.png", "view": "front", "mime": "image/png",
                   "opacity": 0.5, "visible": true, "position": [3], "quaternion": [4], "scale": [3] }],
  "jobs": [{ "id": "job_…", "provider": "bridge:http://127.0.0.1:8787", "mode": "single", "remoteId": "single:…",
             "status": "ready-to-edit", "createdAt": "…", "updatedAt": "…", "sourceImageIds": ["img_…"],
             "error": null, "consent": { "at": "…", "provider": "…", "imageCount": 1 } }]
}
```

## Guarantees

- **Geometry is exact.** Positions, normals, UVs, colours, the sculpt mask (`aMask`) and the index are stored as raw typed arrays, so a save/open round trip reproduces them bit for bit (tested in `tests/unit/io.test.ts` and E2E J2).
- **No secrets.** No provider keys, bridge tokens or local file paths are written. Job records hold only remote task ids and status.
- **Validation on open.** Missing buffers, wrong lengths, non-finite values and out-of-range indices raise a `ProjectError`. The open project is not touched until the whole file has parsed.
- **Versioning.** `schemaVersion` greater than the reader's version → refused with a clear message. Lower versions run through `MIGRATIONS` in `src/persistence/projectFile.ts` (none exist yet for v1).

## Autosave (IndexedDB `formengine`)

| Store | Contents |
|---|---|
| `meta` | `{ id, name, updatedAt, bytes, thumbnail, generation, latestSlot, checksums{A,B}, generations{A,B} }` |
| `blobs` | `<id>:A`, `<id>:B` — the `.formengine` bytes |
| `kv` | `lastProjectId`, `prefs`, `bridgeUrl`, `jobresult:<jobId>` |

Each save writes the slot that is not currently latest, with a SHA-256 checksum, then flips `latestSlot`, all in one transaction. A save whose generation is lower than the stored one is rejected as stale. On load, the latest slot is verified; if its checksum fails, the older slot is used and the user is told.
