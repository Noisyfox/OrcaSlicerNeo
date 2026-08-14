# Renderer origin: loopback http (was app://) — 2026-08-14

**Decision:** the packaged renderer is served by an in-process http server on
`http://127.0.0.1:<ephemeral port>` instead of the custom `app://` scheme.
This reverses the M3 choice (`doc/2026-08-14-m3-implementation-notes.md`) and
unblocks the wasm64 (table64) module in the renderer, which requires
Chromium ≥ 133 → Electron ≥ 35, and Electron 36+ removed the worker
workaround that `app://` depended on.

## Why

Two stacked Chromium constraints:

1. **Workers cannot spawn from `file://`** (opaque origin) — the original
   reason M3 built the `app://` scheme.
2. **Out-of-process workers cannot fetch scripts from custom schemes.**
   Electron 32+ shipped `PlzDedicatedWorker` (dedicated workers in their own
   process), and for those the script fetch goes through the worker process's
   network stack, which has no route to an embedder scheme handler
   (electron#38774). M3 worked around it by disabling the feature
   (`--disable-features=PlzDedicatedWorker` → in-process workers load fine
   from `app://`). **Electron 36 removed the flag** — the workaround is gone
   on any supported version.

The wasm64 module forces the upgrade (Emscripten 6.0.4 MEMORY64 glue
requires Chromium ≥ 133; Electron 34 = Chromium 132 cannot instantiate the
table64 binary — see `doc/2026-08-14-wasm64-build-notes.md` if present, else
the CI env comment in `.github/workflows/ci.yml`).

## Evidence (Electron 43.4.0, Chromium 144, local probes)

| worker source | result |
|---|---|
| `new Worker(app://…, {type:'module'})` | `ERROR` — script fetch fails |
| `new Worker(app://…)` (classic) | `ERROR` — same |
| `new Worker(file://…, {type:'module'})` | HANG — script never arrives |
| blob-URL worker (from app:// and file:// pages) | works |
| http same-origin worker (module + wasm + preload `.data`) | works — full wasm64 module instantiates and runs `callMain` (RENDERER-OK test) |

Blob workers "work" but cannot host the Emscripten module: its relative
`.wasm`/`.data` resolution and the worker's dynamic `import()` all key off
`import.meta.url`, which is a pathless blob: URL. http is the only real
fetch origin that carries the whole stack.

## Implementation (`apps/desktop/src/main/index.ts`)

- `createServer` bound to `127.0.0.1`, port `0` (ephemeral, avoids conflicts).
- Serves `out/renderer` with the same MIME map as before (wasm →
  `application/wasm`, `.data` → `application/octet-stream`).
- **Host validation:** requests whose `Host` header isn't
  `127.0.0.1:<port>` / `localhost:<port>` get 403 — blocks DNS-rebinding
  attacks against the local server (the standard pitfall of in-app http
  servers; VS Code does the same).
- Path-traversal guard unchanged (never serve outside `RENDERER_ROOT`).
- Main-process `fs` reads are asar-aware, so the whole bundle (wasm/ +
  `.data`) works from inside `app.asar`; `asarUnpack: out/renderer/wasm/**`
  stays as a load-time win (skips asar decompression of the ~70 MB `.data`).
- Dev keeps the `ELECTRON_RENDERER_URL` branch (Vite dev server).
- `PlzDedicatedWorker` appendSwitch removed (no-op since E36).

## What improves over `app://`

- Workers over a real http origin: worker script, dynamic import of
  `orca_slice.js`, and Emscripten's `.wasm`/`.data` fetches all work.
- **COOP/COEP now actually apply** (M4 SharedArrayBuffer headroom): the
  `webRequest.onHeadersReceived` mutations were version-dependently ignored
  on custom-protocol responses (electron#20730, #45168) — with http they hit
  every renderer/worker response. The M3 carry-forward "set COOP/COEP on the
  protocol.handle Response" is obsolete.
- The CVE-2026-34767 upgrade-track item (custom protocol + webRequest on
  Electron < 38.8.6) is moot: no custom protocol, and E43 ≥ 38.8.6.

## Security posture (v1)

Loopback-only bind + ephemeral port + Host validation + path guard. No CORS
headers emitted (default: no cross-origin reads). DNS rebinding is the
primary threat to in-app http servers and Host validation addresses it.
M4 hardening candidates (not v1): a random per-session token in the URL
query, CSP with `connect-src 'self'`, `X-Content-Type-Options: nosniff`.

## Files touched

- `apps/desktop/src/main/index.ts` — http origin (scheme + protocol.handle
  removed).
- `apps/desktop/src/renderer/src/slicer/slicer.worker.ts` — comment only
  (the `../wasm/orca_slice.js` relative URL still resolves the same way).
- `apps/desktop/electron-builder.yml` — asarUnpack comment updated.
- `apps/desktop/e2e/packaged.e2e.ts` — comments updated; test unchanged
  (it only asserts presets render, origin-agnostic).
- `doc/2026-08-14-m3-implementation-notes.md` — app:// claims corrected.
