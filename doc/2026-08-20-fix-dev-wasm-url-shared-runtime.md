# Fix: dev-mode wasm URL after the shared-runtime extraction — 2026-08-20

## Symptom

`pnpm --filter desktop dev` failed to boot the worker:

    Error: TypeError: Failed to fetch dynamically imported module:
    http://localhost:5173/@fs/D:/projects/OrcaSlicerNeo/packages/slicer-runtime/src/wasm/threaded/orca_slice.js

## Root cause

The pre-m9 worker lived in `apps/desktop/src/renderer/src/slicer/`, inside the
renderer root, so Vite dev served its chunk at `/src/slicer/...` and the
relative specifier `../wasm/<variant>/orca_slice.js` resolved against the
**public dir** (`/wasm/...`). Commit `eab3928` (m9 web asset portability)
replaced that with `resolveModuleAssetUrl('../wasm/...', import.meta.url)` —
correct for built bundles, where the chunk is emitted under `assets/` beside
`wasm/`, but wrong for dev: the shared chunk now lives in
`packages/slicer-runtime/`, *outside* the app root, so Vite serves it from
`/@fs/<abs-path>/...` and `../wasm/` resolves into the package source tree,
which has no `wasm/` directory → 404 → the dynamic import fails. The m9
verification (unit tests + packaged e2e) never exercised the dev server, so
the regression went unnoticed.

Profiles were unaffected: they already resolve against the deployment base
derived from `import.meta.env.BASE_URL` (`resolveProfileBaseUrl`), which in
desktop dev is `/` → `http://localhost:5173/profiles/` (public dir).

## Fix

Unify host-asset resolution on the deployment base. `profiles.ts` now exports
`resolveDeploymentBase(baseUrl, moduleUrl)` — the base computation previously
private to `resolveProfileBaseUrl` (relative `'.'`/`'./'` anchors one level
above the worker chunk, i.e. built `assets/`; absolute bases resolve directly)
— and `resolveProfileBaseUrl` is defined on top of it. The worker resolves the
wasm module and `locateFile` under `wasm/<variant>/` in that base.

| Deployment | BASE_URL | Result |
|---|---|---|
| Desktop dev (public dir) | `/` | `http://localhost:5173/wasm/<variant>/...` |
| Desktop prod (loopback server, `out/renderer/`) | `./` (or `/`) | root-relative `/wasm/<variant>/...` |
| Web static host, root or subpath | `./` | `<deployment>/wasm/<variant>/...` |

The dev URL stays **absolute**, preserving the invariant from
`2026-08-15-vite-public-module-worker-import.md`: vite's import-analysis
rewrites variable dynamic imports with `__vite__injectQuery(url, 'import')`,
and only absolute URLs pass through untouched — relative public-module
imports die with `ERR_LOAD_PUBLIC_URL`.

`resolveModuleAssetUrl` (the module-relative helper that only the worker
used) was removed; its prod/subpath behavior is covered by the
`resolveDeploymentBase` tests, which now include the dev `/@fs/` layout.

## Verification

- `pnpm --filter slicer-runtime test` — 16 pass (incl. new deployment-base
  cases for built bundles, subpaths, and dev `/@fs/`).
- `pnpm --filter slicer-runtime typecheck`, `--filter desktop typecheck`,
  `--filter web typecheck` — green.
- `pnpm --filter desktop dev`: worker chunk served from `/@fs/...` still
  fetches `GET /wasm/threaded/orca_slice.js` → 200; app boots (see the
  `2026-08-15` doc's CDP/boot checklist).
