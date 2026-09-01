# Preview v2 fixture manifest

`manifest.json` is the repository-owned index for the G-code Preview v2
fixture matrix. It records provenance and reproducible commands; it is not a
runtime bridge/client schema.

The B4 evidence pass now includes one real bridge probe. The existing
`packages/slicer-wasm/fixtures/cube.stl` and
the feature probe config are the only real inputs claimed by B4. Run the
probe with the real serial or threaded artifact:

```powershell
node packages/slicer-wasm/harness/preview-v2-real-fixtures.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --fixture feature-rich-single-material
```

The probe is intentionally marked `verified-real-probe-not-full-fixture`:
it does not substitute for the planned dedicated feature-rich model and does
not prove support/bridge categories. The multi-material entry is explicitly
blocked because the current bridge has no object/part extruder assignment
operation and no repository-owned two-colour fixture. Synthetic command and
performance streams remain test-owned; no mock result is used as real-slice
evidence. Generated G-code and screenshots are not retained by the probe.

All paths are repository-relative. Native references must use the clean Orca
baseline recorded in the manifest. Native OpenGL captures are manually
reviewed against the fixed SHA; they are not cross-renderer pixel-diff goldens.

The generation and verification sequence is maintained in
`doc/2026-09-01-gcode-preview-v2-implementation.md`.
