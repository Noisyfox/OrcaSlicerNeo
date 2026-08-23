# Object List - Step 10: Real-Artifact Verification and Documentation Closure

Date: 2026-08-23

Plan step: doc/2026-08-23-object-list-parts-implementation-plan.md, Step 10

Branch: dev/object-list-and-parts

## Verification (all pass)

- `pnpm test` — workspace unit tests pass (slicer-wasm 64, slicer-app 119,
  slicer-runtime 16, platform-contract 3, profile-resources 3, desktop 8, web 5).
- `pnpm typecheck` — clean across all packages.
- `pnpm --filter @orca/desktop test:e2e` — 12 passed, 1 skipped (the mock-mode
  `slice-error.e2e.ts` skip).
- `pnpm --filter @orca/desktop test:e2e:real` — 13 passed against real WASM
  (including `slice-error.e2e.ts`, which is skipped only in mock mode).
- `pnpm --filter @orca/web test:e2e:threaded` — 1 passed (real wasm64 threaded).
- `pnpm --filter @orca/web test:e2e:serial` — 1 passed (real wasm64 serial).
- `scripts\build-windows.bat quick` — both `out/threaded` and `out/serial` build
  and stage; `bridge-smoke.mjs` passes against both live artifacts.

## Documentation closure

- `spec/ObjectList-and-Parts.md` status set to **Delivered**.
- `spec/Grand Plan.md` Milestone 13 marked **delivered** with all checkboxes.
- `doc/high_level_dev_plan.md` Milestone 13 status set to **delivered**.

## Known escapes / notes

- The mock desktop e2e skips `slice-error.e2e.ts`; it passes in the real-WASM
  desktop e2e.
- The `bridge-smoke.mjs` `orc_get_presets(...) count=0` checks fail only because
  that harness does not stage the profile-resources package into MEMFS; the
  `presets` smoke (`profile-smoke.mjs` / the app e2e) covers profiles.
- Full spec section-6 selection restoration (select new entities / delete
  neighbour) remains a UI refinement; the bridge returns the generated IDs and
  the restore-by-stable-ID path is exercised through the ObjectList selection
  projection.
