# Vite dev: importing a /public ESM from a module worker — 2026-08-15

## Symptom

`build-windows.bat dev` failed in the renderer with:

    Failed to load url /wasm/orca_slice.js (resolved id: /wasm/orca_slice.js).
    This file is in /public and will be copied as-is during build without
    going through the plugin transforms, and therefore should not be imported
    from source code. It can only be referenced via HTML tags.

The app's only legal route into the WASM module is the worker's dynamic
`import(/* @vite-ignore */ wasmUrl)` in `slicer.worker.ts` — which is exactly
what vite rewrote.

## Root cause (vite 5.4.21 internals)

1. **`vite:import-analysis` rewrites EVERY variable-argument dynamic import**
   into `__vite__injectQuery(url, 'import')` (dist: `dep-*.js` 64532-64539).
   The `/* @vite-ignore */` comment only silences the "cannot be analyzed"
   warning (64512-64529) — it does NOT prevent the rewrite.
2. At runtime `__vite__injectQuery('/wasm/orca_slice.js', 'import')` appends
   `?import` → the browser requests `/wasm/orca_slice.js?import`.
3. `servePublicMiddleware` deliberately **passes `?import` requests through**
   to the transform pipeline (51661: `isImportRequest(url)` falls through).
4. `loadAndTransform` cannot read the file (drive-relative path) and refuses
   public files → 500 `ERR_LOAD_PUBLIC_URL`.

A **literal** public-JS specifier is equally dead: import-analysis throws
`Cannot import non-asset file ... inside /public` outright (64431-64438) —
the error message's own suggestion (`?url`) does not help, because importing
the resulting URL string hits step 2 again.

## Fix (`apps/desktop/src/renderer/src/slicer/slicer.worker.ts`)

Make the dev URL **absolute** so the injected helper becomes a no-op:

```ts
const wasmUrl = import.meta.env.PROD
  ? '../wasm/orca_slice.js'                       // prod: relative to chunk URL
  : new URL('/wasm/orca_slice.js', import.meta.url).href;  // dev: absolute
```

- `__vite__injectQuery` returns URLs that don't start with `.` or `/`
  **unchanged** (64772-64775) → no `?import`.
- The browser imports `http://localhost:5173/wasm/orca_slice.js` — a plain
  GET → public middleware serves it statically (200).
- `workerImportMetaUrlPlugin` only rewrites `import.meta.url` inside
  `new Worker(new URL(...))` patterns (48072-48076) — the bare `new URL(...)`
  here stays live at runtime and resolves against the worker script URL.
- Prod branch untouched; `locateFile` still maps `.wasm`/`.data` fetches to
  `/wasm/` (dev) / `../wasm/` (prod).

## Verification (2026-08-15)

- Served worker module (`/src/slicer/slicer.worker.ts?worker_file&type=module`)
  contains `new URL('/wasm/orca_slice.js', import.meta.url).href` in the dev
  branch and `import.meta.env = {...PROD: false...}` prepended.
- `GET /wasm/orca_slice.js` → 200, 1516055 bytes, `text/javascript`.
- App boot (CDP probe on `--remote-debugging-port=9222`): worker script
  fetched, no `boot:` error in the DOM (init → module factory → dynamic
  import resolved; a failure would surface as `setError('boot: …')`), no
  `Failed to load url` 500 in the vite log (the pre-fix error printed there).
- `pnpm --filter desktop typecheck` green.
