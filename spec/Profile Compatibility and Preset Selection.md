# Profile Compatibility and Preset Selection

**Date:** 2026-08-30  
**Status:** Draft — decision groups 1–2 accepted; further interactive review pending  
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

## 5. Explicitly Deferred Questions

- The bridge response design: separate refreshed lists versus an atomic preset
  snapshot returned from selection.
- Exact automated test matrix and the choice of real-profile fixtures.

## 6. Accepted Scope and Editing Boundary

### 6.1 Profile scope

Current acceptance covers every installed system profile supplied by the
profile packages. This feature does not add user-profile creation, importing,
external profiles, profile editing, or profile persistence.

The compatibility boundary remains the C++ profile engine rather than a
system-profile-specific TypeScript implementation. Therefore later support
for user/imported/external presets may use the same engine and inherit its
parent-preset and compatibility semantics, but its product behaviour requires
a separate specification change.

### 6.2 Temporary option edits

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
