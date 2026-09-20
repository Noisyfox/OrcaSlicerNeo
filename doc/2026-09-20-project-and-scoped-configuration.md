# Project and Scoped Configuration

**Date:** 2026-09-20
**Status:** Implementation in progress — Steps 1–2 accepted

The normative, incrementally accepted feature specification is
[`Project and Scoped Configuration`](../spec/Project%20and%20Scoped%20Configuration.md).
This living record contains the implementation sequence and verification evidence. It
intentionally does not duplicate the normative decisions.

## Approved implementation sequence

Each numbered step is implemented by one new subagent. That subagent must complete its
own focused verification. The parent independently reviews the resulting diff and
runs the stated acceptance checks before any later step starts. No step may redefine
the approved semantics in the normative specification.

1. **Fixture-safe baseline and history measurement harness**
   - Implement the test-only fixture-copy mechanism and refactor the real-project
     history profile so the immutable source helmet project is verified by identity but
     every operation targets a freshly created temporary copy.
   - Establish structured baseline measurements for the specified history scenarios;
     do not claim the 200 ms gate before the later post-change measurement.
   - Acceptance: source SHA-256/length are unchanged; profile refuses a non-identical
     fixture; a temporary copy is the only opened/saved/sliced path; the profile emits
     raw per-sample timing and metadata without production instrumentation.

2. **Native persistence authority and sidecar removal**
   - Remove `project_config_overlay` as live state and from 3MF read/write. Make native
     Project, Plate, `ModelObject`, and `ModelVolume` configuration locations the only
     persisted owners, retaining valid native values not exposed by the first UI.
   - Keep geometry-only import clearing semantics and preserve only its required native
     extruder assignment.
   - Acceptance: normal save writes no sidecar; open does not read/replay a legacy
     sidecar; native scopes survive normal open/save; geometry-only import clears the
     specified override scopes.

3. **Native scoped mutation, exact history roots, and invalidation**
   - Add Worker-owned typed set/reset/category-reset/reset-all operations over native
     scope maps, native option parsing and clamp validation, and exact Project-config
     history replacement. Remove Project config from the filament/rack history root.
   - Preserve native entity lifecycle and copy semantics, emit affected-Plate input
     changes only, and keep material, Layer Range, Custom G-code, and inaccessible keys
     outside generic reset-all.
   - Acceptance: atomic multi-target mutations and erase-only reset undo/redo exactly;
     missing historical Project keys are removed on restore; unrelated plates stay
     valid; Object/Volume edits invalidate every and only their instance plates.

4. **Versioned bridge/client/runtime configuration transport**
   - Expose versioned full native scoped snapshots on open/history/refresh and complete
     affected-target map replacements on ordinary mutations through the typed client and
     runtime boundary. Include monotonic revisions and deleted-target representation;
     remove overlay client APIs, mocks, and store authority.
   - Acceptance: no shallow merge can retain erased keys; stale/gapped responses force a
     full refresh; history/open responses publish scene, plate, history, and config at
     one committed revision; shared code remains free of direct Emscripten access.

5. **Shared Project / Scoped React surface**
   - Implement the transient mode toggle, existing-selection target resolution,
     selection-limited React projection, categories/search, mixed multi-edit, typed and
     serialized fields, draft/error behaviour, reset controls, and non-interactive tree
     markers.
   - Acceptance: Project always starts a project session; Scoped never auto-switches;
     Object/Volume selections hide Plate provenance while empty selection exposes Plate;
     invalid selections are disabled; material/Custom G-code remain outside the generic
     surface; all UI writes use committed runtime commands and one history transaction.

6. **Slice-time and structural-operation integration**
   - Connect scoped transactions to the existing serial `slice_busy` policy, threaded
     commit-then-asynchronous-cancel path, revision-based stale-result rejection, and
     native structural-operation receipts for delete, clone, split, cut, replacement,
     and plate movement.
   - Acceptance: serial mutation during slicing changes neither config nor history;
     threaded mutation invalidates/cancels only affected work; unchanged plate work
     continues; no renderer-side old-to-new config mapping exists.

7. **3MF interoperability and compatibility acceptance**
   - Add the complete scoped-configuration golden and normal Neo → Orca → Neo test;
     compare normalized native key maps. Add separate unknown-key compatibility-fallback
     and legacy-sidecar-negative coverage.
   - Acceptance: golden covers every approved scope and preserved inaccessible data;
     no sidecar is produced or replayed; recognized native values round trip; unknown
     input follows the established fallback rather than claiming a native round trip.

8. **End-to-end performance gate and release regression**
   - Repeat the fixture benchmark on real release/non-mock serial and threaded artifacts
     using the full scenario/process/sample matrix. Add the required focused package,
     bridge, host, persistence, and real-project checks for the delivered change.
   - Acceptance: every eligible measured Undo/Redo event-to-next-editable-frame sample
     is at most 200 ms, warm median target is 100 ms, source fixture remains unchanged,
     and all required regressions pass or are reported with evidence.

## Accepted implementation evidence

### Step 1 — Fixture-safe baseline and history measurement harness

Accepted on 2026-09-20. The profile now pins the licensed source project by its
same-basename path, 45,586,816-byte length, and SHA-256
`6db07e50b4692f95bfef65595e9fcd0bf902c9660b7b1d7bc1a4f98b4d7d2425` before
creating a fresh same-basename copy below the system temporary directory. Only that
copy is supplied to the real Electron/WASM profile; the runner verifies the source
again before cleanup. The profile rejects an identity mismatch and records the
source/copy identities plus raw mutation, undo, and redo samples in its temporary
baseline report. This is measurement infrastructure only, not a performance-gate
claim.

Parent acceptance checks passed:

- `node --test scripts/real-project-fixture.test.mjs` — 3/3 passed.
- `node --check scripts/real-project-fixture.mjs` and
  `node --check scripts/run-real-project-profile.mjs` — passed.
- `pnpm --filter @orca/desktop test:e2e:real-project-profile` — passed (the real
  visible Electron/WASM profile; Playwright `.last-run.json` reports `passed`).
- Final source identity check — unchanged at the length and SHA-256 above.

### Step 2 — Native persistence authority and sidecar removal

Accepted on 2026-09-20. `project_config_overlay`, its C ABI, typed client and
runtime transport, Worker/mock state, React-store authority, and the
`Metadata/orca_neo_config_overlay_v1.json` production read/write/replay path have
been removed without an internal compatibility alias. Native Project, Plate,
`ModelObject`, and `ModelVolume` configuration is the sole persisted authority;
the Worker-to-React map is explicitly a disposable native snapshot. Existing
plate-session and filament metadata are separate, non-configuration sidecars and
remain outside this decision.

Normal export omits the removed sidecar. A focused negative test injects it into an
otherwise valid archive and proves that opening the archive preserves the native
values and slice result without parsing or replaying the injected data.
Geometry-only import clears imported object and volume values while preserving only
the valid native object `extruder` assignment. This step deliberately leaves
versioned receipts, revision-gap recovery, and exact key-erasing history roots to
later approved steps.

Parent acceptance checks passed:

- `pnpm typecheck` and `pnpm --filter @orca/slicer-wasm test` — passed; the latter
  reports 159/159 tests.
- Native scoped-configuration persistence and native interoperability harnesses —
  passed independently on both serial and threaded WASM artifacts.
- `git diff --check` — passed (only line-ending warnings); the immutable Odyssey
  source remains 45,586,816 bytes with SHA-256
  `6db07e50b4692f95bfef65595e9fcd0bf902c9660b7b1d7bc1a4f98b4d7d2425`.
