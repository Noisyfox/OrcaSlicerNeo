# Multi-Plate Support

**Status:** Implementation in progress — Steps 1–6 accepted; Steps 7–9 pending

**Date:** 2026-09-05

**Scope:** The shared Electron and Web application's Prepare workspace, up to
36 plates.

## Accepted interaction model

- Prepare renders all plates simultaneously in an OrcaSlicer-style, automatically
  reflowed grid. The first release supports at most **36** plates, matching
  OrcaSlicer's product/UI limit.
- Grid column counts and plate-origin ordering exactly follow native OrcaSlicer
  so add, delete, and project reload reproduce the same layout.
- One plate is the current plate. Selecting a plate through plate UI changes
  the current plate and supplies the context for plate-scoped operations.
- Clicking a non-current plate's empty bed selects it. Switching plates keeps
  the current camera position and zoom; it does not automatically frame the
  selected plate.
- Clicking a model on a non-current plate does **not** automatically select
  that plate.
- Object selection and editing remain global across the visible grid. Users may
  select objects or instances from different plates together and move, scale,
  rotate, or delete them in one operation.
- Newly imported models start at the center of the current plate, including
  `Plate 1`, and initially belong to that plate. They may overlap existing
  objects there; automatic placement is deferred with automatic arrangement.
- The object list groups entries by plate and has a separate Unprintable group;
  choosing an entry does not change the current plate. For this first release,
  a multi-instance model appears only in the group of its first instance rather
  than being split across every plate containing an instance.
- Plate membership is not an editing restriction. After each committed geometry
  or transform edit, the application recomputes each affected instance's plate
  membership from its resulting placement. An instance outside every printable
  plate is reported as unprintable rather than silently assigned to a plate.
- Membership follows native OrcaSlicer's convex-hull bounding-box intersection
  rule. If an instance intersects multiple plates, it belongs to the
  lowest-numbered matching plate.
- Membership and printability are separate states. An instance that intersects
  a plate but is partly outside its printable volume remains a member of that
  plate, is visibly marked as out of bounds, and makes that plate unavailable
  for slice, export, and send until the instance is fully back in bounds.
- Slice, G-code export, and send-to-printer operate on the current plate only
  in the first implementation. Batch "Slice all" and multi-plate export/send
  behaviour are deferred decisions.

## Plate lifecycle and grid reflow

- The first implementation exposes only **Add plate** and **Delete plate**.
  Plate duplication, reordering, and renaming are deferred.
- Adding a plate automatically makes that new plate the current plate.
- At least one plate always remains; the sole remaining plate cannot be
  deleted.
- Plate add/delete does not introduce a separate undo/redo facility in the
  first release. Deletion proceeds without a confirmation dialog.
- Removing every object from a plate leaves that plate in place; only an
  explicit Delete plate action removes it. An empty current plate cannot be
  sliced, exported, or sent.
- Deleting the current plate selects the plate that compacts into its former
  position; when the deleted plate was last, the preceding plate becomes
  current. Deleting a non-current plate preserves the current plate's identity,
  even if grid compaction changes its index and world position.
- Deleting a plate never deletes its model instances. Its instances move to
  the final vacant grid position and retain their local coordinates relative
  to their deleted plate. They are unprintable until a later editing operation
  places them on a printable plate.
- Deleting an intermediate plate compacts the following plates forward. Each
  moved plate's instances move by the same world-space delta, preserving their
  local coordinates relative to that plate.
- Adding or deleting a plate may change the automatically calculated grid
  dimensions. Whenever that reflow moves an existing plate, its instances move
  with it and preserve their local coordinates.

## Slice results and configuration scope

- Each plate retains its own completed G-code and preview result when the user
  switches to another plate. Returning to an unchanged plate restores that
  result without a new slice.
- A committed edit invalidates the results of every plate that contained an
  affected instance immediately before or immediately after that edit. Results
  for all other plates remain available.
- Grid reflow caused only by adding or deleting a plate preserves surviving
  plates' slice results because their local placement is unchanged. A new plate
  starts unsliced, and deleting a plate discards its result.
- Only one slice job runs at a time, but users may switch, view, and edit other
  plates while it runs. Its result is bound to the plate selected when the job
  started, not whichever plate is current when it completes.
- If an edit affects the plate currently being sliced, that job is cancelled
  immediately and the plate becomes unsliced. An edit to another plate does
  not interrupt the running job.
- Preview-mode plate switching follows native OrcaSlicer. A valid target result
  is shown immediately; an unsliced but valid target starts slicing
  automatically; and an empty or invalid target remains in Preview with its
  unavailable state shown rather than returning to Prepare.
- Each plate retains its own slice result for the lifetime of the session, but
  the renderer loads GPU toolpaths for only the current plate. Switching plate
  replaces that one active GPU preview from the target's retained result.
- The first implementation uses one shared printing configuration for every
  plate. Per-plate configuration controls are explicitly out of scope.
- Changing the shared configuration invalidates every plate's slice result.
- Changing the printer or its build-volume dimensions or shape preserves plate
  count; the grid is recomputed, plates carry their instances to their new
  origins, and membership and printability are recalculated. All slice results
  are then invalidated.
- The plate-session data model and bridge contract must nevertheless reserve a
  per-plate settings/override slot, so a later release can add Orca-compatible
  per-plate configuration without changing plate identity or result ownership.
- Per-plate configuration overrides imported from a native OrcaSlicer project
  are retained as opaque metadata and written back unchanged. They have no UI
  and do not affect first-release slicing, which uses the shared configuration.
- Plate lock state imported from native OrcaSlicer is likewise retained and
  written back unchanged. It has no first-release UI or behaviour because its
  native purpose is to constrain automatic rearrangement, which is deferred.

## Project persistence

- Project 3MF files must persist and restore the complete multi-plate model:
  plate count, layout, instance membership, and the information needed to
  reconstruct every plate's editing state.
- Neo-generated multi-plate projects must be reopenable by native OrcaSlicer,
  and native OrcaSlicer projects must be reopenable by Neo with the same plate
  layout and membership.
- The project file does not embed per-plate G-code or preview data. Those
  derived slice artifacts remain session-only data.
- On project reload, every plate is treated as unsliced. A user must slice the
  selected plate again before preview, export, or send-to-printer is available.
- Except for those intentionally omitted derived artifacts, unsupported native
  per-plate metadata is retained as opaque data and written back unchanged so
  an open/save cycle does not discard it.
- Plate add/delete, model edits, and shared configuration changes mark the
  project unsaved. Slice results, preview changes, and current-plate selection
  do not. The existing save-prompt flow applies before closing or replacing a
  project with unsaved multi-plate changes.

## Project import compatibility

- Importing a multi-plate project produced by native OrcaSlicer must preserve
  its plate layout and object membership; it must not be flattened into one
  plate.
- A plain 3MF or legacy project with no plate metadata imports into one default
  plate, `Plate 1`. Instance membership is then recalculated from current
  coordinates.
- A project with duplicate, missing, or out-of-order `plate_index` values is
  normalized like native OrcaSlicer: record order becomes a contiguous plate
  order, rather than rejecting the project.
- Import rejects a project with more than 36 plates with a clear error. This
  deliberately replaces native OrcaSlicer's unsafe over-limit load path while
  retaining its 36-plate product limit.

## Architectural direction

The implementation will mirror OrcaSlicer's state model without importing its
wxWidgets/OpenGL GUI classes: a headless, WASM-owned plate session maintains
per-plate membership, metadata, settings, and slice-result state, while the
shared React layer renders the grid and controls. The existing platform
contracts remain host-neutral.

React consumes an authoritative `PlateSessionSnapshot` from WASM and never
maintains or derives instance membership independently. Plate selection,
addition, deletion, and post-edit membership recomputation are bridge commands.
An add/delete response atomically includes the session snapshot and every
instance world transform changed by grid reflow; the frontend applies these
returned transforms rather than calculating movement itself.

To slice a plate, WASM derives a temporary model containing only that plate's
instances and translated into the plate's local printer origin; slicing never
mutates the global editing model. Exported G-code always uses this local machine
coordinate system, so identical local placement on different plates produces
identical printer coordinates and G-code.

Within a running session, each plate has an immutable opaque `plateId`.
Frontend selection, preview ownership, and slice jobs use this identity rather
than the display index, which may change during compaction. Project 3MF remains
native-compatible and persists plate order with `plate_index`; fresh internal
IDs are created on load. A slice job records its target `plateId` and input
revision, and its result is accepted only if both still match on completion;
cancelled or stale completions are discarded.

## Execution protocol and quality gates

The following is an executable plan, but does not itself authorize product-code
implementation. Every numbered step is a strict gate.

1. Begin at the preceding accepted commit on `dev/multi-plate-spec` (or its
   implementation successor). Preserve the pre-existing dirty
   `packages/slicer-wasm/cpp` submodule; it is never part of a step commit.
2. Start a **new** `gpt-5.6-luna` sub-agent with **high** reasoning effort for
   that one step. Its prompt includes this specification, the exact scope,
   exclusions, and acceptance commands. Never reuse an agent on a later step.
3. The agent implements only that step, adds/updates its required tests, runs
   all listed commands successfully, reports their actual output, and makes
   one focused commit. A failure is fixed and re-tested by the same agent;
   unsupported claims of verification do not pass the gate.
4. I independently inspect the committed diff and rerun every acceptance
   command listed for the step. I must confirm the functional boundary, the
   normal single-plate flow, and a clean in-scope worktree before explicitly
   accepting it. Only then may the next step receive a fresh agent.
5. If my acceptance fails, the same agent remediates the current step and
   repeats self-verification. No future step runs early or in parallel.

Every implementation and acceptance run includes `pnpm test` and
`pnpm typecheck`. A change to the bridge, C++, WASM client, or staged WASM
artifact also runs `scripts\\build-windows.bat quick` and the stated serial and
threaded harnesses. A shared UI or host-flow change also runs
`pnpm --filter @orca/desktop test:e2e`,
`pnpm --filter @orca/web test:e2e:threaded`, and
`pnpm --filter @orca/web test:e2e:serial`. A command that cannot run fails the
gate unless the user explicitly changes it.

## Detailed implementation plan

### Step 1 — Plate-session contract and deterministic layout

**Implement.** Add a headless WASM-owned session around the global editing
model: default `Plate 1`, immutable runtime `plateId`, current plate,
native-compatible grid origins/display indices, and typed
`PlateSessionSnapshot` read/reset/select bridge-client-runtime contracts.
React receives the snapshot but renders no new plate UI yet.

**Do not implement.** Add/delete, membership, 3MF format, model transforms,
visible multi-bed UI, or slice results.

**Accept when.** Fresh, cleared, and legacy-loaded projects each expose one
current plate; reads are deterministic; reset/load creates new runtime IDs;
malformed calls fail without mutating state; existing single-plate calls stay
compatible.

**Evidence.** Focused bridge/client/runtime tests plus
`project-roundtrip.mjs` against `out/serial` and `out/threaded` after the quick
WASM build.

### Step 2 — Authoritative membership and plate lifecycle

**Implement.** Add native convex-hull AABB membership with lowest-index tie
breaking and independent out-of-bounds validity. Add/select/delete/recompute
commands return one atomic snapshot and all reflowed instance transforms.
Implement the 36-plate ceiling, sole-plate guard, new-plate selection,
empty-plate retention, deletion selection, deleted-instance parking, and grid
reflow rules.

**Do not implement.** React controls, object-list grouping, 3MF persistence,
slice jobs, or automatic arrangement.

**Accept when.** Tests demonstrate overlap ties, unprintable and out-of-bounds
states, local-coordinate preservation during add/delete/reflow, specified
current selection after deleting current/non-current plates, and atomic
rejection of the 37th add or sole-plate deletion.

**Evidence.** Deterministic session tests and a direct bridge harness covering
all mutations in both WASM variants; existing single-plate slice harnesses
remain green.

### Step 3 — Editing integration, dirty state, and invalidation inputs

**Implement.** Route model creation/import, deletion, and committed
move/scale/rotate through membership recomputation. New models use the current
plate's local center and may overlap. Apply bridge-returned transforms without
restricting global selection. Track per-plate input revisions, before/after
affected plates, and dirty reasons; current-plate selection stays clean.

**Do not implement.** Visible multi-plate controls/list groups, persistence,
actual result storage, undo/redo, or auto-arrange.

**Accept when.** One edit can act on selections across plates; membership is
recomputed only after commit; affected plates are exactly those holding an
instance before or after the edit; unrelated plates remain unaffected; only
specified structural/model/configuration operations mark the project dirty.

**Evidence.** Store/action and transform-sync tests, mock-client tests, a
real-WASM focused harness, and existing save-prompt coverage.

### Step 4 — Native-compatible 3MF persistence

**Implement.** Replace synthesized single `PlateData` save output with all
native-format plate records. Round-trip `plate_index`, layout/membership,
names, locks, settings slots, and unsupported per-plate metadata opaquely. On
load normalize invalid index sequences by record order, re-create runtime IDs,
recompute membership, clear results, fall back to one legacy plate, and reject
over-36 input before session mutation.

**Do not implement.** G-code/preview persistence, per-plate settings UI/effect,
or the native fixture suite.

**Accept when.** Canonical Neo save/load preserves order, local coordinates,
membership, names, locks and opaque fields; no-metadata 3MF becomes `Plate 1`;
bad ordering normalizes; 37 plates fails clearly without altering prior state;
reload is unsliced with first plate current.

**Evidence.** Extend `project-roundtrip.mjs` and
`project-compatibility.mjs` with generated cases, run both variants, and add
client/runtime safe-failure tests.

### Step 5 — Prepare grid and plate controls

**Implement.** Render all authoritative beds in the shared Prepare viewport
with current and out-of-bounds state. Add Add/Delete plate controls and their
availability rules. Empty-bed click selects its plate; add/delete use the
session result; every selection/reflow retains the camera viewport.

**Do not implement.** Object-list changes, model-click plate switching,
cross-plate edit restrictions, or Preview behaviour.

**Accept when.** Electron and Web show the same grid through 36 plates;
controls enforce limits; empty-bed click switches current, non-current model
click does not, and camera state stays unchanged. The UI never calculates
layout or instance offsets itself.

**Evidence.** Viewport/component tests and Electron, threaded-Web, and
serial-Web Playwright flows for add, intermediate delete/reflow, selection,
and camera preservation.

### Step 6 — Object list and global editing UI

**Implement.** Project snapshots into plate groups and Unprintable; list a
multi-instance model only under its first instance's group. Wire import,
transform, and delete UI to Step 3's global commands and show validity state.
List selection keeps the current plate.

**Do not implement.** Auto-arrange, per-plate settings UI, rename/reorder/
duplicate, or active lock behaviour.

**Accept when.** Cross-plate objects can be edited/deleted together; a commit
updates groups and beds from the returned snapshot; list clicks do not switch
current; empty plates persist; deleted-plate instances appear Unprintable at
the prescribed parked coordinates.

**Evidence.** Object-list projection/action and shared UI tests, followed by
all three host flows for global edits and list/current independence.

### Step 7 — Current-plate local slice, export, and send

**Implement.** Derive an isolated local model containing only current-plate
members translated to that plate's printer origin. Bind start data to
`plateId`/revision and use it for slice/export/send. Gate those actions on a
non-empty, fully printable current plate.

**Do not implement.** Slice queue/result cache, Preview auto-reslice, per-plate
settings, or batch slice/export/send.

**Accept when.** G-code excludes other plates; equivalent local geometry on
different plates yields equivalent local G-code; empty/invalid plates cannot
act; temporary slicing never mutates the global editing model; public actions
reject a non-current target.

**Evidence.** Serial/threaded real-WASM multi-plate harnesses, action/
coordinator tests, and all three host flows for guards and export.

### Step 8 — Results, Preview, job lifecycle, and global invalidation

**Implement.** Own results by plate for the session, with one active job.
Accept completion only when `plateId` and revision still match; discard stale
or cancelled output. Invalidate before/after affected plates, cancel only an
affected active job, preserve unaffected results through reflow, discard a
deleted plate result, and load GPU toolpaths only for the current plate.
Implement Orca Preview switching and all-plate invalidation/reflow for shared
configuration or printer/build-volume changes.

**Do not implement.** Parallel/batch slices, result persistence across reopen,
inactive GPU caches, per-plate configuration UI, or active lock semantics.

**Accept when.** Unchanged results restore without reslice; a valid unsliced
Preview target slices; empty/invalid Preview remains unavailable; unrelated
edits do not interrupt a job; affected edits cancel and suppress late output;
reflow preserves surviving results; config/printer changes invalidate all;
only one GPU toolpath is live; reopen has none.

**Evidence.** Deterministic fake-worker race tests, result/preview component
tests, real-WASM serial/threaded checks, and all three host flows for
switching, cancellation, invalidation, and restoration.

### Step 9 — Opt-in native interoperability suite

**Implement.** Add a checksum-pinned native OrcaSlicer multi-plate fixture,
canonical-state comparison, pinned native 3MF parser verifier for Neo output,
and documented manual acquisition/run commands for both production variants.

**Do not implement.** Inclusion in `pnpm test`, PR/nightly/release automation,
or product behaviour changes.

**Accept when.** The manual command passes a pinned native fixture and detects
controlled differences in order, membership, local coordinates, names, locks,
opaque data, legacy fallback, over-limit rejection, omitted derived artifacts,
and fixture checksum tampering.

**Evidence.** The agent and parent each run the opt-in suite in both variants,
including one controlled negative checksum/fixture case. Normal test scripts
remain unchanged.

## Compatibility verification

- A dedicated compatibility suite will validate both production WASM variants:
  multi-plate save/load canonical state, import of a checksum-pinned project
  generated by native OrcaSlicer, and validation of Neo output through the
  pinned Orca 3MF parser without a GUI.
- The canonical comparison covers plate order, instance membership, local
  coordinates, names, locks, and retained opaque metadata. It also covers the
  ordinary-3MF fallback, over-36 rejection, and intentionally omitted derived
  G-code/preview artifacts.
- This suite is not part of normal tests, PR checks, nightly runs, or release
  gates at this stage. It remains an explicit manual verification tool until a
  later decision schedules it.

The detailed wire format remains an implementation detail, but it must satisfy
the Step 1 snapshot contract and every later acceptance boundary above.
