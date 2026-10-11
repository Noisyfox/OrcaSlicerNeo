# Surface Painting Verification and Benchmarks

**Updated:** 2026-10-11
**Status:** Functional delivery accepted; numerical performance thresholds pending
**Scope:** Reproducible engineering checks and measurement limitations.

The current product contract is
[Surface Painting Architecture](../spec/Surface%20Painting%20Architecture.md).
All six MMU tools and Support/Seam/Fuzzy adapters have completed functional
acceptance. This reference retains verification procedures rather than the
completed implementation steps, agent assignments and retry logs.

## Functional regression

Follow [testing guidelines](testing_guidelines.md) for ordinary edit/commit
scope. Native harnesses cover sessions, selectors, stale revisions, history,
annotation roundtrips, downstream slicing and resource lifetime. Real host
journeys verify input admission, every tool, reliable release/Escape terminals,
navigation, cleanup and instrumentation exclusion.

Relevant entry points, run from the repository root:

```powershell
pnpm --filter @orca/slicer-wasm painting-session-smoke
pnpm --filter @orca/slicer-wasm painting-backend-smoke
pnpm --filter @orca/slicer-wasm painting-engine-smoke
pnpm exec node scripts/run-painting-e2e.mjs
pnpm exec node scripts/check-painting-profile-elision.mjs
```

The package smoke scripts select serial artifacts. A release gate also needs
the applicable threaded harnesses, real Electron/Web journeys, profile/project
compatibility and packaged-runtime checks. These commands alone are not a
complete release matrix. Build/stage the current tree and record artifact
identity before claiming real-WASM evidence.

## Instrumented benchmark

Changing a CMake gate requires `build`, not `quick`. For a controlled serial
measurement on Windows:

```powershell
$env:NEO_PAINTING_PROFILE='1'
$env:NEO_PROJECT_HISTORY_TEST='0'
.\scripts\build-windows.bat build --variant serial
pnpm exec node scripts/run-painting-benchmark.mjs --host both --channels mmu,support,seam,fuzzy --trials 3
pnpm exec node scripts/summarize-painting-benchmark.mjs
$env:NEO_PAINTING_PROFILE='0'
$env:NEO_PROJECT_HISTORY_TEST='0'
.\scripts\build-windows.bat build --variant serial
```

Restore both gates and rebuild even after a failed measurement, then verify
production elision. The benchmark records the actual native cache flags,
fixture/source/artifact identities, host environment and cleanup. Its runner
supports `--cases`, `--output`, `--native-cache`, `--close-only`, `--close-edits`
and `--expect-incremental-close` for controlled subsets. Do not replace dated
reference archives as a side effect of a routine rerun.

## Evidence and limits

The [Windows reference summary](../packages/slicer-wasm/benchmarks/painting/reference-2026-09-29/summary.json)
and [index](../packages/slicer-wasm/benchmarks/painting/reference-2026-09-29/index.json)
describe 36 serial, instrumented samples on a Ryzen 9 5900X / 64 GiB / RTX 3080
machine. The archived native artifact also had history fault-test support
enabled; these measurements are not production timings. The 143,912-triangle
case measured release-to-logical-frame p95 of 215.84/263.20 ms and
close-to-disposal p95 of 444.20/480.30 ms (Electron/Web).

The 96-sample macOS four-channel baseline was retained locally, at the user's
request, under
`packages/slicer-wasm/.work/step19/benchmark-archive/reference-2026-10-02-macos-four-channel/`.
It is not a tracked/reproducible-from-checkout artifact. The record identifies
Apple M1, 16 GiB RAM, Darwin arm64 24.6.0, Node 26.7.0, Chrome 154.0.8037.93
and Electron 43.4.0. Its original Electron bundle SHA was not captured;
later eight-sample pilots add provenance for their own runs only.

Logical revision frames are not measured GPU execution or displayed pixels.
WebGL timings cover CPU submission. One-second working-set/RSS sums can miss
peaks and count shared pages more than once. Dropped inputs, unmatched release
events and no-op strokes remain explicit and are excluded from matched latency
aggregates. Dropping input does not demonstrate an equivalent-work speedup.
Resource cleanup and reliable terminal behavior remain functional requirements.

The supplemental object-scoped `layer_height=0` slice exposed
`RuntimeError: Aborted`. It remains unresolved; its cause and pre-existence
were not established. The recorded local evidence locations are
`packages/slicer-wasm/.work/step19/supplemental-slice-error-limit.json` and
`packages/slicer-wasm/.work/step19-handoff.json`; their availability is not
guaranteed on a fresh checkout. No passing qualification is claimed for it.

A comparable pinned native Orca benchmark and GPU timing remain unavailable.
Numerical latency/memory thresholds still require review; this consolidation
does not approve thresholds or rerun qualification.
