# Preview v2 fixture manifest

`manifest.json` is the repository-owned index for the G-code Preview v2
fixture matrix. It records provenance and reproducible commands; it is not a
runtime bridge/client schema.

At B0 the matrix contains only metadata. The existing
`packages/slicer-wasm/fixtures/cube.stl` and
`packages/slicer-wasm/fixtures/config.json` are the sole real inputs claimed
by this step. Feature-rich
and multi-material models, synthetic command streams, performance streams,
generated G-code, and screenshots are added only after their corresponding
contracts and generators are accepted.

All paths are repository-relative. Native references must use the clean Orca
baseline recorded in the manifest. Native OpenGL captures are manually
reviewed against the fixed SHA; they are not cross-renderer pixel-diff goldens.

The generation and verification sequence is maintained in
`doc/2026-09-01-gcode-preview-v2-implementation.md`.
