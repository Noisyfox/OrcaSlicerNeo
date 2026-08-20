# M9 Step 11 — release and regression audit

This note records the evidence collected while auditing the M9 Web–Electron
shared implementation against its approved plan. It is an evidence record, not
a replacement for the plan's release checklist.

## Automated evidence

The workspace regression gate completed successfully after the preference and
runtime corrections:

```powershell
pnpm test
pnpm typecheck
```

The test command reported 96 passing tests across platform-contract,
profile-resources, slicer-wasm, slicer-runtime, slicer-app, desktop, and web.
The typecheck command completed without TypeScript errors.

Real artifact and host checks completed with the currently staged full profile
set (66 packages), retaining per-package console progress from the installer:

```powershell
scripts\build-windows.bat quick
node packages/slicer-wasm/harness/profile-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js
pnpm --filter web test:e2e:serial
pnpm --filter web test:e2e:threaded
pnpm --filter web test:non-root
pnpm --filter desktop exec playwright test e2e/preferences-persistence.e2e.ts
```

The Windows quick build completed successfully. The serial real-module
profile smoke wrote `out.gcode` and installed the profile packages. The serial
and threaded Chrome E2E each passed their real import, profile, slice, layer,
and export flow; the serial run also asserts the non-blocking serial fallback
notice. The non-root static-host smoke passed. The Electron preference
persistence E2E passed (one test).

The packaged Electron real-runtime probe was added in `0977626` and reported
one passing test against the loopback packaged application, including real
threaded loader, wasm, data, import, slice, and export checks. Step 10's final
serial status and static-host correction is `8452ba3`; the deterministic
real-Electron E2E correction is `cd24f66`.

## Manual/environment-limited checks

The Windows audit environment did not perform the macOS title-bar safe-inset
manual check. It remains a release check and is not claimed as verified here.
Likewise, visual verification of Windows/Linux overlay behavior must be done
in the target desktop shells; automated browser and Electron checks above do
not substitute for that manual validation.
