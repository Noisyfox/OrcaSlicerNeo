# External 3MF compatibility fixtures

This directory intentionally stores only the manifest and acquisition tooling.
The three archives are upstream test/calibration data and are not copied into
the repository. This keeps the repository small while retaining exact,
reviewable provenance and licensing information.

The manifest pins each source repository, commit, path, raw URL, byte length,
SHA-256, and AGPL-3.0 license URL. The selected samples are:

- OrcaSlicer `flowrate-test-pass1.3mf` (Orca-origin calibration geometry).
- BambuStudio `flowrate-test-pass1.3mf` (Bambu-origin calibration geometry).
- PrusaSlicer `fdm_roundtrip1.3mf` (Prusa geometry and metadata).

The two calibration archives deliberately do not contain embedded project
preset settings in the pinned upstream revisions. The bridge therefore
correctly classifies all three as `generic` and the gate asserts the documented
geometry-only compatibility fallback. The Bambu-compatible project-settings
path is covered by the self-save/reopen harness (`project-roundtrip.mjs`),
which asserts `compatibility: bambu` on the generated archive.

Acquire and verify them before running the real compatibility gate:

```text
node packages/slicer-wasm/harness/acquire-project-fixtures.mjs --download
node packages/slicer-wasm/harness/acquire-project-fixtures.mjs --check
node packages/slicer-wasm/harness/project-compatibility.mjs --module packages/slicer-wasm/out/serial/orca_slice.js
```

`--download` is deterministic and refuses a content or size mismatch. The
archives remain ignored by git. CI/release must run acquisition (or provision
the exact files from an approved cache), `--check`, and the compatibility
harness for both `out/serial/orca_slice.js` and `out/threaded/orca_slice.js`.
Network-less jobs must provide the three exact archives as an artifact; a
missing fixture is a gate failure, not a passing/skipped compatibility result.

All source repositories are AGPL-3.0 projects. Distributors must preserve the
root AGPL license and the upstream source-offer obligations.
