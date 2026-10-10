# Preset Editor Dialog Implementation

**Date:** 2026-09-23

**Status:** Living implementation plan

**Scope:** Implement phase one of the approved
[Preset Editor Dialog](../spec/Preset%20Editor%20Dialog.md) specification for
Printer and Filament runtime drafts. This record fixes the execution and
acceptance boundaries; it does not reopen accepted product decisions.

## Implementation invariants

- Work remains on `dev/preset-editor-dialog`. The pre-existing dirty
  `packages/slicer-wasm/cpp` submodule is not part of this work. No step edits
  that pinned submodule; Neo bridge changes stay in `packages/slicer-wasm/`.
- `PresetDraftRegistry` is a C++/WASM-session abstraction keyed by
  `Preset::Type` plus canonical preset name. It holds sparse Printer and
  Filament overrides only. Print/Process editing and user-preset management
  remain outside phase one.
- Slicing, export, Prepare projections, and material/flush calculations use
  bridge-owned effective-configuration adapters. React never computes a preset
  configuration or keeps an independent draft copy.
- A draft is runtime and history state, not a Neo-private 3MF member. A saved
  project contains ordinary effective configuration and selections; load
  reconstructs active overlays from that ordinary state.
- Each step is implemented by one newly started implementation subagent. That
  subagent must finish its scoped change, run its scoped checks, and report
  evidence. The parent independently reviews the diff and reruns the defined
  acceptance checks. A later step starts only after that acceptance succeeds.

## Sequential implementation plan

### Step 1 — Native draft registry and effective configuration assembly

**Functional boundary.** Add a bridge-owned `PresetDraftRegistry` for sparse
Printer/Filament source overlays, and the native bridge command surface needed
to inspect and mutate one draft. Add `effective_full_config()` and
`effective_full_config_secure()` that copy the selected Printer and selected
Filaments, apply their matching overlays, and call
`PresetBundle::construct_full_config(...)`. Migrate every current Neo bridge
consumer of `full_config()` / `full_config_secure()` to those adapters. The
implementation must never swap or mutate a collection's `m_edited_preset`.

**Done when.** A native harness proves that two slots using the same canonical
Filament name receive one shared override, a different Filament source remains
independent, and a Printer override reaches a slice-relevant configuration.
The harness must also exercise at least one non-slicing effective-config
consumer (such as a Prepare or flush projection), so the migration is not a
slice-only code path. The change has no `packages/slicer-wasm/cpp` diff.

**Required acceptance.** Focused draft-registry harness; `git diff --check`;
serial and threaded WASM quick builds plus focused smoke because the common C++
bridge changes. The parent separately checks the complete caller migration and
that temporary copies cannot leak into source presets.

### Step 2 — Typed Worker/client/runtime editor contract and native history

**Functional boundary.** Make the Step-1 bridge operations available only
through typed client and runtime methods: open/read a source, obtain metadata
and effective values, set/reset one override, reset a category, and reset a
preset. Extend native project history capture/restore and committed snapshots
so every accepted draft command has the specified one-entry history behavior,
while rejected or incomplete input has none. Extend the mock module with the
same observable semantics.

**Done when.** A client/Worker test performs set, field reset, category reset,
and reset-preset operations; verifies shared same-source Filament visibility;
and proves Undo/Redo restores draft state before slot resolution. Stale or
invalid commands return a typed error without mutating history, a draft, or a
slice revision.

**Required acceptance.** Focused client and Worker tests, affected package
typechecks, the native draft harness from Step 1, and the affected WASM smoke.
The parent independently runs the public contract test against the mock and a
real serial artifact.

### Step 3 — Atomic Printer transition and remembered-rack integration

**Functional boundary.** Replace the split Printer-selection / remembered-rack
application sequence with one native composite transition: activate the target
Printer source/draft, restore its remembered source selections and actual slot
colours, normalize compatibility in native `Always` behavior, initialize
replacement colours from effective material defaults, and publish one committed
projection. Persist the normalized remembered rack only after the committed
transition, outside project history.

**Done when.** One command creates one history item and one slice invalidation;
Undo/Redo restores Printer, the complete rack, actual colours, and drafts.
Missing or incompatible remembered sources select the Printer default first and
then a compatible fallback. Direct Printer-draft field edits do not normalize
or replace the rack. 3MF initial load retains project-owned rack priority.

**Required acceptance.** Focused native transition/history harness, preference
publication unit test, client/runtime typecheck, and both common-bridge quick
builds. The parent independently verifies the transition is atomic to React
and that the preference write is absent from Undo/Redo.

### Step 4 — Explicit Orca-derived layout manifests and read-only modal

**Functional boundary.** Add explicit Printer and Filament manifests
transcribed from the pinned Orca `TabPrinter::build()` and
`TabFilament::build()` page/group/field ordering. Implement the single shared
`PresetEditorDialog` shell that renders source identity, Project-draft marker,
Filament referencing slots, all manifest fields, cross-page label/key/tooltip
search, and the top-right X close action. Native metadata supplies labels,
types, help and constraints; it does not synthesize layout. Unsupported or
structural fields are visibly read-only, including all specified
topology-changing Printer fields.

**Done when.** Component tests demonstrate page/group ordering, search context,
modified-marker rules, shared-slot title content, and read-only structural and
specialized fields. Exactly one modal can be active, and it contains no mode
filter, Save, Apply, or Cancel control.

**Required acceptance.** Focused `@orca/slicer-app` component tests and
typecheck, import-direction guard, and parent visual/source review against the
pinned Orca layout functions.

### Step 5 — Editable controls, resets, and Prepare entry points

**Functional boundary.** Connect generic scalar, boolean, enum, text, and
colour controls to the typed contract. Reuse the current Scoped Project Config
commit state machine: discrete changes commit immediately; free text commits
on Enter/blur; Escape restores only local display text; native rejection stays
inline. Highlight overridden option labels with the same color as the Print
configuration overlay, and clear the highlight on reset. Add field, category,
and preset reset actions. Add the Printer-picker
Edit entry point and each Filament-slot menu Edit entry point. Preserve the
separation between material `default_filament_colour` and project-owned actual
slot colours.

**Done when.** A component interaction test proves an accepted edit immediately
updates native effective UI state, creates one history entry and invalidates
the relevant slice result; failed input creates none. Field/category reset
removes sparse overrides, while only Reset preset deletes the empty overlay.
Editing a Filament default colour leaves actual slot colour unchanged; selecting
a replacement source initializes that actual colour from its effective default.

**Required acceptance.** Focused application/component tests and typecheck,
the client contract suite, and a focused primary-host E2E proving both entry
points and one edit/reset path. The parent repeats the user journey and checks
the native history receipt rather than a DOM-only proxy.

### Step 6 — Project persistence reconstruction and phase-one closure

**Functional boundary.** Complete the project-load/save integration required
by the runtime-only-draft rule. Saving must emit normal effective configuration
and source selections without a draft object, key, or source-to-draft map.
Loading must reconstruct active Printer/Filament overlays from those ordinary
effective values, preserve dormant drafts only in current-session history, and
continue to handle embedded sources through the existing project safety path.
Add focused coverage for shared drafts, project-embedded sources, reset,
Printer transitions, and 3MF reload.

**Done when.** A real 3MF round trip reproduces the effective slice inputs but
contains no Neo draft serialization. Reopening reconstructs active overlays;
dormant unreferenced drafts do not return. Embedded Printer/Filament sources
remain editable for the open project only. The full phase-one regression suite
passes on the primary host plus the required common bridge checks.

**Required acceptance.** Focused persistence/3MF and history harnesses,
affected package tests/typechecks, both common-bridge quick builds and smoke,
one real primary-host E2E, and `git diff --check`. Before handoff, the parent
runs `pnpm test`, `pnpm typecheck`, focused Electron E2E, and the documented
serial/threaded WASM checks; unavailable checks are reported explicitly rather
than treated as passed.

**Implementation result.** The standard BBS 3MF writer stores the current
source selections and flattened effective configuration, with active draft
fields represented by Orca's ordinary per-preset difference metadata; no Neo
draft registry is serialized. Load reconstructs only selected Printer and
Filament overlays from the imported effective values, keyed by canonical
source name. Dormant drafts therefore remain session/history-only and do not
return after reopening. The native BBS loader still resolves embedded sources;
their archive configurations are preserved separately from runtime overlays.
The real serial and threaded WASM round trips, embedded-source round trip,
focused persistence/history and Printer-transition smokes, workspace tests and
typechecks, and primary Electron preset-editor E2E passed for this closure.

## Completion boundary

After Step 6 passes parent acceptance, this implementation record is updated
only with the accepted final phase-one boundary and promoted or consolidated
with the approved specification according to repository documentation policy.
Phase two remains a separate task: Save As, rename, deletion, user-preset
repository persistence, and management UI are excluded from this branch.

## Accepted generic element extension — 2026-10-10

- On `dev/extruder-indexed-editor`, share native typed vector reads, writes,
  range validation and source-element reset across Printer/Filament drafts and
  the Project Print configuration. The current source adapter stays in the Neo
  bridge; runtime-only Print ownership adds the documented submodule adapter.
- Preserve native variant cardinality and the Printer motion-limit stride of
  two. Require `indexCount` in every vector projection; do not infer a valid
  range from a short serialized option or universally use physical nozzle count.
- Keep Print in its existing embedded-preset/Project ownership and application
  transaction path. Add its typed read and indexed set/explicit batch reset
  contracts together with the client, Worker transport, mock and tests.
- Native invalid/stale requests publish no mutation. Indexed resets preserve
  other elements and native nullable defaults; batch resets are atomic.
- Continue using the current internal contract without legacy response fallbacks.
  Update these existing documents rather than creating new task documents.
- Filament/Print selectors, per-field Extruder/Variant mapping, motion-mode UI,
  and parameter synchronization are outside this mechanism increment.
- Editable vectors use sparse per-index entries: `null` inherits and `{value}`
  explicitly owns the typed value, including `{value: null}` for native nil.
  Require `overrideValues` in every vector projection. Explicit Source-equal
  writes remain owned; indexed Reset clears only that entry, and all-null
  arrays remove the key while retaining the empty draft. Other pages stay
  modified independently and the current page Reset becomes unavailable.
- Printer/Filament entries remain in the existing draft/history owner. Print
  ownership follows its native embedded preset and existing history root via
  runtime-only `Preset::neo_vector_overrides`. Modify and commit this adapter
  directly on `dev/orcaslicerneo-wasm`, with an intentional documented pin.
- Whole vector Set owns all valid indices. Ordinary 3MF stays flattened: import
  reconstructs whole-vector ownership for changed options; per-index masks and
  Source-equal explicit entries are session/history state, not archive state.
- Multi. diameter edits, explicit Reset, nullable values and Undo/Redo must keep
  native ownership, sidebar markers and editor field/group/page states aligned.

Validation covers native U1 physical/variant/motion ranges, short vectors,
nonzero Filament and Print edits/resets, nullable source restoration, failed
batch isolation, and Undo/Redo. Shared client/Worker tests cover the typed
contract, and the existing Printer/Filament editor journey remains applicable.

Verification completed for this increment:

- `pnpm test`: 1,825 passed, 3 skipped; `pnpm typecheck`: passed.
- `scripts\build-windows.bat quick --variant serial -j 8` and
  `scripts\build-windows.bat quick --variant threaded -j 8`: passed.
- `node packages/slicer-wasm/harness/extruder-indexed-editor-smoke.mjs`
  with each fresh serial/threaded module: passed. The existing
  `preset-draft-registry-smoke.mjs` and
  `native-project-preset-history-smoke.mjs` also passed on serial.
- Freshly staged real Electron build: `playwright test e2e/preset-editor.e2e.ts`
  passed both tests. Real Web: `playwright test --config
  ../../apps/web/playwright.config.ts web.e2e.ts --grep
  'Print edits followed by Filament edits'` passed its selected test.
- `git diff --check`: passed. Full release E2E matrices were not run for this
  focused mechanism increment.

The override-highlight follow-up passed `pnpm test` (1,828 passed, 3 skipped),
`pnpm typecheck`, the 30-test `PresetEditorDialog` component suite, and all three
real Electron `e2e/preset-editor.e2e.ts` tests after fresh staging/build.
`extruder-indexed-editor-smoke.mjs` passed on serial and threaded, covering
equal-value diameter ownership, explicit Reset and Undo/Redo. The serial quick
build was rerun; native production code is unchanged and the threaded artifact
retains the same source contract. `git diff --check` passed. The full release
host matrix was not rerun for this shared presentation correction.

## Sparse vector override verification — 2026-10-10

The deliberate Orca submodule adaptation is commit
`306650f0f5518d8d34defbf67f7175b8b40d3021` on
`dev/orcaslicerneo-wasm`: `Preset` carries runtime-only sparse vector ownership,
and overwriting a native preset preserves it. The superproject pins this
validated commit; no Orca source patch or new document was added.

- `pnpm test`: 1,833 passed, 3 skipped. `pnpm typecheck`: passed.
- `scripts\build-windows.bat quick --variant serial -j 8` and
  `scripts\build-windows.bat quick --variant threaded -j 8`: passed.
- Fresh serial and threaded `extruder-indexed-editor-smoke.mjs`: passed,
  including sparse masks, whole-vector Set, independent indexed Reset,
  explicit nullable nil, equal-value ownership and Print Undo/Redo.
- Serial `preset-draft-registry-smoke.mjs` and
  `native-project-preset-history-smoke.mjs`: passed, including native 3MF
  round trips and preservation of distinct Filament variant values.
- Fresh real Electron `playwright test e2e/preset-editor.e2e.ts`: 3 passed,
  including two modified indices and current-page Reset becoming disabled
  while the other page remains highlighted.
- Real Web `playwright test --config ../../apps/web/playwright.config.ts
  web.e2e.ts --grep 'Print edits followed by Filament edits'`: 1 passed.
- Superproject and submodule `git diff --check`: passed. Full release matrices
  and deferred Filament/Print Variant selection UI were outside this change.
