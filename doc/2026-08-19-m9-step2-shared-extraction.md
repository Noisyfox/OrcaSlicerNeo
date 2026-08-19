# M9 step 2 — shared application/runtime extraction

Date: 2026-08-19  
Status: implemented pending acceptance

Step 2 moves the existing platform-neutral renderer feature layer into
`packages/slicer-app`, the Worker-backed runtime orchestration into
`packages/slicer-runtime`, and the injected platform contracts/provider into
`packages/platform-contract`. Electron retains only its renderer entry and
native adapter. The extraction preserves the existing component/store/slicing
code and keeps host APIs behind the adapter/provider boundary; profile delivery
and Web host work remain subsequent steps.

Verification: after an escalated dependency restore, `pnpm test` passes (24
slicer-wasm tests, 3 runtime tests, 36 shared-app tests; contract and desktop
test projects intentionally have no local test files and use
`--passWithNoTests`). `pnpm typecheck` passes for all five workspace projects.
Electron E2E builds successfully and starts the app, but the existing suite
has three assertion failures (layer scrubber visibility, move-panel selection,
and select-scroll) plus one intentional skipped test; no renderer crash or
page error occurred. These failures are recorded for the parent review and
are not unrelated behavior redesign work for this extraction step.
