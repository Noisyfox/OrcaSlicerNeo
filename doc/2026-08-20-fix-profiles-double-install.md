# Fix: profiles fetched and installed twice on dev boot — 2026-08-20

## Symptom

At app launch, the dev console logs the manifest fetch twice:

    [profiles] fetch-complete {"url":"http://localhost:5173/profiles/manifest.json","bytes":7336}

followed by a duplicate set of `[profiles] package` / `package-installed` lines
— i.e. the whole profile install ran twice, not just the manifest fetch.

## Root cause

`App.tsx` boots the runtime from a `useEffect`, and `apps/desktop/.../main.tsx`
wraps the app in `<React.StrictMode>`. In development React StrictMode mounts →
unmounts → remounts every component, running the boot effect twice. Both runs
post an `init` request to the worker.

In the worker, `createClient().init()` ran its `beforeInit` hook on **every**
call. The WASM module is memoized, but the hook — `installProfiles` in
`slicer.worker.ts`, which fetches `manifest.json` and every profile ZIP,
unzips, and writes them into MEMFS — was not. The two in-flight boots both
fetched and installed everything concurrently. Production builds are
unaffected (StrictMode double-invocation is dev-only), but any future second
`init()` (reconnect, re-init after failure) would silently re-download and
re-mount the full profile tree.

## Fix

`packages/slicer-wasm/src/client/client.ts`: `init()` now runs `beforeInit`
**once per client** via a memoized promise, instead of once per call.
Concurrent or repeated `init()` calls await the same install. A *rejected*
install clears the memo, so a retry (e.g. StrictMode run 2 after a transient
fetch failure) re-attempts instead of inheriting the failure.

The worker (`slicer.worker.ts`) is unchanged — its `beforeInit` hook now
benefits from the idempotency at the client seam, which is where the
double-`init` bug lives.

## Verification

- New tests in `packages/slicer-wasm/src/client/client.test.ts`:
  - `beforeInit` runs exactly once across two `init()` calls (the StrictMode
    double-mount shape) — red before the fix (`expected 2 to be 1`).
  - `beforeInit` retries a rejected install on the next `init()`.
- `pnpm test` — 98 pass across all workspaces (slicer-wasm 24 incl. the two
  new cases).
- `pnpm typecheck` — green on all packages.
