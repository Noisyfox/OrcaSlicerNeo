# Painted facet Preview fixture

`painted-facet-instances.3mf` is a deterministic imported-project fixture for
the shared model renderer. The dependency-free builder starts from the
checked-in two-slot 3MF reader fixture, adds BBS `paint_color` triangle metadata
for a split facet, and records two placed instances of the same object on one
plate. Both instances start at positive H2D bed coordinates so they remain
sliceable through the transform/history round-trip.

The palette is slot 1 `#FF0000`, slot 2 `#00FF00`, with the part assigned to
slot 2. Native paint groups are states 0 through 4: state 0 and state 2 use
slot 2; states 1, 3, and 4 use slot 1 (the last two exercise the missing-slot
fallback). This makes recolouring and fallback behavior observable.

The static archive is the exact output of
`packages/slicer-wasm/harness/painted-facet-fixture-builder.mjs`; the
`painted-facet-fixture-smoke.mjs` check verifies its byte length, SHA-256,
instances, split state, palette arrays, and bed placement. The native scene
geometry smoke checks the imported group-state mapping and shared two-instance
paint resource. This archive is imported through the real WASM project loader
by focused Desktop and Web E2E. It is not a mocked GLVolume fixture.

```powershell
node packages/slicer-wasm/harness/painted-facet-fixture-builder.mjs
node packages/slicer-wasm/harness/painted-facet-fixture-smoke.mjs
```
