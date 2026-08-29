# Profile Compatibility and Preset Selection

**Date:** 2026-08-30
**Status:** Draft — decision groups 1–6 accepted; further interactive review pending
**Scope:** Compatibility-driven system preset selection in the shared Electron/Web application.

## 1. Purpose

The Process and Filament pickers must expose only the profiles compatible with
the active Printer, using OrcaSlicer's own compatibility semantics. The user
must never be left with a selected Process or Filament that is absent from its
strictly filtered picker.

This is a product-behaviour specification. The precise bridge/API shape,
custom-profile scope, and test fixture design remain open until later decision
groups are reviewed.

## 2. Compatibility Authority

Compatibility must be evaluated by the bundled OrcaSlicer profile engine, not
reimplemented in TypeScript. This preserves the upstream semantics for
resolved `inherits` chains, explicit compatible-printer/profile lists,
condition expressions, profile-library exclusions, and parent-printer rules.

For FFF profiles, the effective compatibility set is:

- Process: compatible with the active Printer.
- Filament: compatible with both the active Printer and the active Process.

The active Process therefore participates in the Filament list even though
the initiating user action may have been a Printer change.

## 3. Accepted Behaviour — Selection Lifecycle

### 3.1 Strict picker contents

For the current version, both pickers contain only installed/visible profiles
that are also compatible with the active selection context:

```text
process picker  = visible AND compatible-with(active printer)
filament picker = visible AND compatible-with(active printer, active process)
```

There is no "show incompatible presets" mode in this version. A future
advanced inspection or preset-editing feature may add such a mode in a
separate approved change.

### 3.2 Selecting a Printer

Changing Printer is one atomic compatibility transition:

```text
select printer
  -> resolve/retain or select a compatible process
  -> resolve/retain or select a compatible filament using the final process
  -> replace the UI's process and filament lists and all three selections
```

The UI must not leave the old Process or Filament candidate lists visible
after the Printer changes.

### 3.3 Selecting a Process

Changing Process re-evaluates Filament compatibility against the active
Printer and the newly selected Process. The Filament list and, when required,
the selected Filament update as the same completed transition.

### 3.4 Fallback selection

When an existing Process or Filament becomes incompatible, the application
uses OrcaSlicer's native compatible-preset fallback behaviour. This permits
the profile engine to preserve a suitable existing profile where possible and
otherwise select its preferred compatible/default/first-compatible candidate.
The application does not implement a separate TypeScript fallback heuristic.

### 3.5 Startup and preference restoration

Restoring a saved selection uses the same compatibility model as an interactive
selection. Restore in this order:

```text
Printer -> Process -> Filament
```

At each stage the profile engine may substitute a compatible fallback. The
final resolved triple is written back to preferences, so the persisted state
matches what the user sees and what slicing uses.

## 4. Interaction Requirement

During a compatibility transition, the UI must not accept a selection from a
stale picker list. The eventual interaction treatment (for example, temporary
disabled controls or a local loading state) remains an implementation decision,
but the transition result must be applied coherently.

## 5. Accepted State Delivery and Interaction

### 5.1 Atomic preset snapshot

A successful preset selection returns one atomic compatibility snapshot from
the C++ bridge. The snapshot contains the final selections and the complete
Printer, Process, and Filament lists including their visibility and
compatibility state. It is created only after the profile engine has completed
compatibility evaluation and any required fallback selection.

The shared UI replaces its complete preset state from that snapshot. It must
not compose a new selection with independently fetched, potentially stale
Process or Filament lists. Initial loading should use the same coherent
snapshot model.

### 5.2 In-flight interaction

While a selection transition is in progress, all three preset selectors are
temporarily disabled and the preset area presents a lightweight loading state.
They return to an interactive state only after a completed compatibility
transition is applied.

### 5.3 Failure handling

Detailed failure behaviour is deliberately deferred. The implementation must
retain a code-level TODO at the selection error boundary so this is resolved
before compatibility transitions are relied on for production workflows.

## 6. Accepted Slice and Preference Side Effects

### 6.1 Slice result invalidation

Every successful preset transition changes a slicing input. As soon as its
atomic compatibility snapshot is applied, the application invalidates any
existing slice result, toolpath preview, layer state, and G-code export. A
new slice is required before previewing or exporting G-code again.

A failed transition does not itself invalidate an existing result; detailed
failure-state handling remains deferred.

### 6.2 Preference persistence

After applying a successful snapshot, persist the engine-resolved Printer,
Process, and Filament names together as `selectedProfiles`. This includes any
fallback selected by the profile engine rather than the name originally
requested by the user.

Preference write failures do not roll back the active in-memory preset state
or its UI. The session remains usable and the failure is logged.

## 7. Accepted Verification Strategy

Compatibility is complete only when all of the following verification layers
pass:

1. **Bridge / real WASM:** validate native OrcaSlicer compatibility behaviour,
   including explicit name lists, condition expressions, Printer-to-Process-to-
   Filament recalculation, and fallback selection.
2. **Client and shared-UI unit tests:** validate atomic snapshot replacement,
   strict hiding, in-flight selector locking, and persistence of the resolved
   selection triple.
3. **Electron and Web E2E:** switch Printer and verify that Process and
   Filament contents update, old slice output is invalidated, and G-code cannot
   be exported until a new slice completes.

Most real-WASM assertions use a small deterministic profile fixture designed
for compatibility tests. It must cover explicit `compatible_printers`, a
`compatible_printers_condition`, `compatible_prints`, and fallback behaviour.
This prevents routine upstream profile renames or edits from weakening test
determinism. A separate smoke/E2E path uses the complete packaged system
profile tree to verify production packaging and real data.

## 8. Explicitly Deferred Questions

- Exact failure semantics for a rejected selection or an invalid/incomplete
  compatibility snapshot.
- Exact automated test matrix and the choice of real-profile fixtures.

## 9. Accepted Scope and Editing Boundary

### 9.1 Profile scope

Current acceptance covers every installed system profile supplied by the
profile packages. This feature does not add user-profile creation, importing,
external profiles, profile editing, or profile persistence.

The compatibility boundary remains the C++ profile engine rather than a
system-profile-specific TypeScript implementation. Therefore later support
for user/imported/external presets may use the same engine and inherit its
parent-preset and compatibility semantics, but its product behaviour requires
a separate specification change.

### 9.2 Printer technology and material slots

This specification covers FFF/FDM only. The app exposes the FFF `printer`,
`print`, and `filament` preset collections; it does not expose SLA printers,
SLA print presets, or SLA material presets as compatibility candidates.

The current application supports one active Filament selection. Compatibility
and fallback are defined for that single selection only. OrcaSlicer's
multi-extruder filament-slot list, per-slot fallback, UI, persistence, and
slice mappings are explicitly deferred to a separate specification. The
snapshot contract must not make a future slot-array extension impossible.

### 9.3 Temporary option edits

The current version does not expose temporary Printer or profile-definition
edits that can change compatibility. Compatibility is recomputed only after a
system preset selection or preference restoration.

This is deliberate. OrcaSlicer distinguishes selection/restoration from
editing: selection paths may choose an automatic compatible fallback, whereas
an edit that makes a profile incompatible normally preserves the edited
selection and marks it incompatible. That native editing behaviour conflicts
with the current strict-hide rule, which allows no selected incompatible item.

When compatibility-relevant profile editing is introduced, the product must
choose and specify one of these behaviours before implementation:

1. Preserve the selected incompatible profile and present an explicit warning
   state, matching OrcaSlicer's editing UX; or
2. Preserve strict hiding and automatically select a compatible fallback.
