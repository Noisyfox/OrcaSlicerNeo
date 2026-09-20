# Project and Scoped Configuration

**Date:** 2026-09-20
**Status:** Implementation in progress — Steps 1–6 accepted

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

### Step 3 — Native mutation, exact history roots, and invalidation

Accepted on 2026-09-20. The former single-key native mutation ABI is replaced by
one canonical JSON request for atomic multi-target `set`, `reset`,
`reset-category`, and `reset-all` operations. It stages every target before
publication, parses through native PrintConfig, clamps direct numeric limits, and
leaves native state, plate revisions, and history unchanged on parse or target
failure. Individual reset erases the local key. Category and all resets preserve
the approved excluded domains: extruder, filament/rack/material fields, Layer
Range, Custom G-code, and scene-only coordinates.

The Project history root is now a complete native map replacement: restoration
removes keys absent from the historical root instead of merging them. Project
configuration is absent from both the filament/rack history root and the filament
metadata sidecar; ordinary native project settings retain valid local Project
values. Invalidation is the target union: Project affects all plates; Plate only
itself; Object and Part every plate containing one of the target object's
instances. History restore applies the same minimal-set rule.

Parent acceptance checks passed against freshly staged `out/serial` and
`out/threaded` artifacts:

- Native mutation smoke on serial and threaded WASM — passed (atomic rollback,
  clamp, bad parse no-op, erase reset Undo/Redo, and reset exclusions).
- Native persistence precedence smoke on serial and threaded WASM — passed
  (no removed sidecar, injected legacy sidecar ignored, native round trip, and
  geometry-only extruder-only import).
- Threaded history smoke, serial configuration-scope invalidation smoke, and
  threaded multi-filament command smoke — passed; the latter reports all measured
  undo/redo operations within its existing 100 ms budget.
- `pnpm --filter @orca/slicer-wasm test` — 159/159 passed;
  `pnpm --filter @orca/slicer-wasm typecheck` and `git diff --check` — passed.

### Step 4 — Versioned bridge/client/runtime transport

Accepted on 2026-09-20. Native scoped configuration now crosses the bridge as a
version-1 transport with a monotonic committed revision. Open, history restore,
and explicit refresh publish a complete snapshot; ordinary edits publish complete
per-target replacements. Deleted object, part, and plate targets are expressed as
stable `removed_targets` tombstones. The client/store replaces complete maps,
never shallow-merges them, and marks stale, gapped, or unknown-target receipts
refresh-required until it accepts a full snapshot. History commit publishes its
scene, plate, history status, and native scoped-config receipt at the same
revision.

Parent acceptance checks passed: WASM client tests 160/160, application tests
580/580, both package typechecks, and staged history/precedence harness coverage
including explicit part and deleted-object tombstones. The immutable Odyssey source
fixture remained unchanged.

### Step 5 — Shared Project / Scoped React surface

Accepted on 2026-09-20. The Settings surface now has a transient `Project | Scoped`
toggle. Both modes use the same metadata-derived native catalogue: Project mode reads
and writes only the Project map, while Scoped mode resolves the active Plate, Object,
or ModelVolume from Neo's existing selection contract. A mixed non-empty selection is
explicitly non-writable and never falls back to a Plate. The projection hides Plate
provenance for Object and Volume selections, shows selection-local provenance and
mixed values, and supports categories, search, typed and serialized draft fields,
individual/category/all-local reset, and non-interactive local-override markers in
the existing Object List. Generic material, Custom G-code, Layer Range, unknown, and
scene-owned coordinate keys remain excluded.

The mode resets to Project when a project session is initialized or reset and is not
persisted. Every configuration command captures its native targets and enters one
project-history transaction. Scoped commands now share the existing pending-field
queue, so a Slice command waits for an immediately preceding blur commit before it
reads the effective configuration.

Parent acceptance checks passed:

- `pnpm --filter @orca/slicer-app test -- --run` — 77 files, 588 tests passed.
- `pnpm --filter @orca/slicer-app typecheck` — passed.
- `pnpm --filter @orca/slicer-wasm test -- --run` — 5 files, 161 tests passed.
- `git diff --check` — passed (only Windows line-ending warnings).

### Step 6 — Slice-time and structural-operation integration

Accepted on 2026-09-20. The serial Worker admission gate now explicitly rejects the
multi-target scoped command with `slice_busy` before it posts a native mutation or
history transaction. For threaded execution, an accepted configuration or structural
receipt invalidates exactly its native affected-Plate set and begins cancellation
asynchronously only when that set contains the active slice target. Unaffected plate
results remain available. The existing input-revision receipt checks continue to
reject stale Slice results.

Structural bridge operations now return authoritative native plate/session receipts
with complete native scoped-config transport and exact before/after affected Plate
sets. This covers the actual current structural API: deletion, cloning, object/volume
reorder, split-to-parts, split-to-objects, merge-to-multipart, separate instances,
instance add/remove, volume type changes, printable changes, and Plate reordering or
deletion. React consumes those receipts directly; it maintains no old-to-new scoped
configuration mapping. Test mocks mirror the observed native clone, split, and
separate-instance map ownership rules. The repository has no cut or generic
replacement bridge API, so this step does not invent one; any future endpoint must
return the same native receipt contract.

Parent acceptance checks passed:

- `cmd /c scripts\\build-windows.bat quick` — serial and threaded staged WASM builds
  validated successfully.
- `pnpm --filter @orca/slicer-wasm test -- --run` — 5 files, 165 tests passed.
- `pnpm --filter @orca/slicer-app test -- --run` — 77 files, 592 tests passed.
- `pnpm typecheck` and `git diff --check` — passed (only Windows line-ending warnings).
