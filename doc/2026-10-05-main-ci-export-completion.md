# Main CI G-code Export Completion

Date: 2026-10-05
Status: Implemented and verified locally.

## Cause and accepted behavior

Main CI run [37300151169](https://github.com/Noisyfox/OrcaSlicerNeo/actions/runs/37300151169)
failed in the real-module Prime Tower project journey after returning to the
first plate. The test read the overwritten G-code as soon as its modification
time changed. Electron awaits an asynchronous `writeFile`; creation and mtime
changes can precede completion, leaving the trailing `wipe_tower_x/y`
configuration absent from the bytes read by the test.

All three exports in this journey now wait for file creation/replacement and
the Export button to become enabled again, which follows completion of the
awaited save operation. They also assert that no slicer error was reported
before reading the file. Existing native per-plate coordinates, toolpath
footprints, Preview bounds, and retained-result isolation assertions remain.
The change is confined to test synchronization.

## Verification

Following the [testing guidelines](testing_guidelines.md):

- `pnpm test`: 164 files / 1,547 tests passed, including the desktop suite.
- `pnpm typecheck`: all workspace packages passed.
- `pnpm stage:assets` and
  `VITE_USE_MOCK=0 VITE_E2E=1 pnpm --filter @orca/desktop exec electron-vite build`:
  passed. Fresh public assets were copied into `apps/desktop/out/renderer`.
- Downloaded threaded and serial WASM artifacts from the failing CI run;
  staged WASM SHA-256 values matched the downloads:
  threaded `1af6901fbc4c11bee6d383538423fed48a200f6866219a71961eb5974933a401`,
  serial `cca31591e8340b4855dd270caad99aed07e1659d9ed637efd61ea4c21d603e09`.
- A temporary diagnostic version of the real-project E2E replaced only its
  Electron write handler: write the first 1,024 bytes, wait two seconds, then
  finish writing. The original synchronization failed by parsing that partial
  header; the repaired synchronization passed the complete three-export
  journey in 1.6 minutes. Initial diagnostic setup attempts failed because
  dynamic imports and `require` were unavailable in Electron's evaluation
  context; `process.getBuiltinModule` resolved the diagnostic setup. No
  diagnostic code is retained in the repository.
- `ORCA_E2E_REAL=1 ORCA_E2E_PRIME_TOWER_PROJECT=<verified temporary copy>
  pnpm --filter @orca/desktop exec playwright test e2e/prime-tower-project.e2e.ts`:
  final uninstrumented real-project journey passed in 1.6 minutes.
- `pnpm --filter @orca/desktop typecheck`: passed after removing the temporary
  diagnostic tests.
- Source fixture and temporary copy retained the expected 44,473,498 bytes
  and SHA-256 `de8afeac2e7b53a63fe5925d8b05ddfe0c0b7f0a7b3f88fbc2a5fc29c0524ce0`.
- `git diff --check`: passed. The local testing-guideline link and recorded
  commands were checked against package scripts and the real-project runner.

Native builds, the full mock E2E suite, Web E2E, and release packaging are
intentionally skipped: only synchronization in one Electron test changed,
and the real journey uses artifacts built from the current main source.
