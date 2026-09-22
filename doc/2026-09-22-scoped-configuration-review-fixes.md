# Scoped configuration review corrections

**Date:** 2026-09-22

**Status:** Delivered

## Accepted scope

- Preserve the current simplifying history policy: Undo/Redo clears all renderer
  slice results. This task does not change that policy or narrow restore invalidation.
- Mixed selections accept a complete editable draft. Percentage and
  float-or-percentage values retain their native string and unit semantics.
- Equal-value configuration commands succeed without dirtying the project,
  invalidating slices, or creating a history entry. Escape discards a draft.
- Ordinary scoped edits project only requested targets. Configuration maps are
  sparse; an absent local map does not mean that the native entity is unknown.
- Incremental renderer updates copy only changed configuration buckets and retain
  unrelated maps. Native rollback captures only values an operation can change.
- Remove the reviewed old-host API aliases and migration paths: menu snapshots
  require Project state and the full current command set, model import uses its
  current name, and dropped Electron files resolve only through webUtils.
  Normalized preferences expose a required send-navigation boolean; the UI does
  not migrate missing fields. Defaults and validation remain at the external
  preferences boundary. Orca/BBS file interoperability remains supported.
- Avoid repeated linear entity lookup during history restoration without changing
  the accepted result invalidation policy.

The authority and persistence boundaries remain those in
[Project and Scoped Configuration](../spec/Project%20and%20Scoped%20Configuration.md)
and [Undo and Redo](../spec/Undo%20and%20Redo.md). Both application hosts use the
same controls and Worker protocol. Mobile support is unchanged.

## Verification scope

Cover draft input, Escape, no-op commands, sparse first edits and reset/re-edit,
unrelated-map identity, and native multi-target rollback. Run repository tests
and typechecks, targeted Electron UI coverage, and quick builds plus focused
native configuration harnesses for serial and threaded WASM.

Full qualification requires a Process-only override to save and reopen without
a compatibility confirmation. Embedded preset presence alone is not a warning:
confirmation follows the pinned Orca `PresetBundle::validate_presets` return
codes, plus the existing native filament-slot substitution flow. Validate after
loading embedded presets and before `load_config_model`, matching Orca Plater.
Do not supplement Orca's result with independent preset diffs. Cover both the clean
roundtrip and actual warning conditions through the real native bridge.
