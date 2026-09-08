# Multi-filament fixture inventory

`manifest.json` is the Step 0 inventory and stable data matrix for the
multi-filament implementation. IDs and expected-field names are contract
anchors for later bridge/client/runtime/app steps.

`independent-reader-basic.3mf` is assembled by
`harness/multi-filament-fixture-builder.mjs` with a dependency-free stored ZIP
writer and hand-authored 3MF XML plus native BBS project/model settings. It
contains a closed cube, `Metadata/model_settings.config` object/part extruder
assignment, per-plate native `<filament>`/`<nozzle>` records, a two-slot
`project_settings.config`, and two embedded `filament_settings_*.config`
presets. It never invokes the bridge or an exporter. The harness self-test
verifies native keys, byte determinism, and that the checked-in archive is
exactly the builder output.

Entries marked `matrix-only` intentionally record future writer/round-trip and
behavioural cases without executable assertions. They become executable only
when their owning bridge, runtime, or application step introduces the contract;
Step 0 contains no pending or expected-failing tests.

Run the self-test from the repository root:

```powershell
node packages/slicer-wasm/harness/multi-filament-fixtures.mjs
```

When a built WASM artifact is available, the existing reader API can be probed
without asserting the later slot contract:

```powershell
node packages/slicer-wasm/harness/multi-filament-reader-smoke.mjs --module packages/slicer-wasm/out/serial/orca_slice.js
```
