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

Step 7 real slice/Preview semantics (tool changes, generated palette,
temperature, flushing/prime-tower markers):

```powershell
node packages/slicer-wasm/harness/multi-filament-slice-preview-smoke.mjs --module packages/slicer-wasm/out/serial/orca_slice.js
```

Step 8 acceptance inventory and machine-readable result runner:

```powershell
node packages/slicer-wasm/harness/multi-filament-acceptance-checklist.mjs
node packages/slicer-wasm/harness/multi-filament-acceptance-checklist.mjs --run-real
```

The first command validates and prints the complete command plan. `--run-real`
executes the selected real-WASM entries and emits JSON results; every other
entry remains visible as `delegated` or `not-selected`. The plate-local result
safety check runs in serial mode. `--force-fail <id>` is a deterministic probe
that verifies a failing check produces a nonzero exit code.

The acceptance inventory includes the separate 64-slot/4096-cell 3MF
round-trip, imported facet-painting and per-layer tool-change preservation plus
Delete/Merge remapping, and the serial/threaded history, project-round-trip,
preflight/rack, and embedded-preset restoration harnesses required by
Multi-Filament Support §13.2.
