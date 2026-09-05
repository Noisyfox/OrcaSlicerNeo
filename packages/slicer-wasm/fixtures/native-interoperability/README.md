# Opt-in native multi-plate interoperability fixture

This directory is deliberately outside the normal fixture/test path. It
contains the manifest and checksum-pinned binary for a two-plate project
exported by a native OrcaSlicer build. The archive is not downloaded
automatically, included in `pnpm test`, or run by PR/nightly/release
automation.

## Acquire and pin the fixture

1. Use the native OrcaSlicer build at commit
   `b97ca3c0ace8cb04eb520d86417fbe13b7ddde` (or a locally built binary from
   that exact source) to create a project with two plates. Put one cube on
   each plate, name the plates `Native Plate 1` and `Native Plate 2`, leave
   both plates unlocked, and save the project as
   `orca-native-multi-plate.3mf`.
2. Add one unknown per-plate metadata key to each native `<plate>` record in
   `Metadata/model_settings.config` if the native build does not already
   preserve one. The expected values are recorded in `manifest.json`; these
   keys verify opaque round-tripping.
3. Replace the placeholder `size` and `sha256` in `manifest.json` with the
   archive's byte length and SHA-256. The acquisition tool refuses any later
   mismatch.

The controlled acquisition/check command is:

```text
node packages/slicer-wasm/harness/acquire-native-interoperability-fixture.mjs --from C:\path\to\orca-native-multi-plate.3mf
node packages/slicer-wasm/harness/acquire-native-interoperability-fixture.mjs --check
```

`--from` copies the file only after the manifest has a real checksum. Teams
may also provision the exact bytes from an approved secure artifact cache, but
the checked-in copy must continue to match the manifest.

## Run the suite manually

Build/stage both production artifacts first. Then run the same opt-in suite
once for each artifact:

```text
node packages/slicer-wasm/harness/native-interoperability.mjs --module packages/slicer-wasm/out/serial/orca_slice.js
node packages/slicer-wasm/harness/native-interoperability.mjs --module packages/slicer-wasm/out/threaded/orca_slice.js
```

The suite checks the pinned fixture checksum, native parser acceptance,
canonical plate order/membership/local coordinates/names/locks/opaque data,
legacy one-plate fallback, over-36 rejection, omission of derived
G-code/preview artifacts, and controlled mismatch detection. Include one
negative checksum run when recording evidence:

```text
node packages/slicer-wasm/harness/native-interoperability.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --negative-checksum
```

The suite exits non-zero for a missing fixture, checksum mismatch, parser
failure, or any failed assertion. It is intentionally not referenced by a
package script or CI workflow.

The parser verifier is a small, dependency-free archive checker whose native
format rules are pinned to `src/libslic3r/Format/bbs_3mf.cpp` at the commit in
`manifest.json`. It is paired with `orc_load_project` so the production bridge
also proves that its native reader accepts Neo output.
