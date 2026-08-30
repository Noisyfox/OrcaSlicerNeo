# Deterministic preset compatibility fixture

The profile-compatibility bridge must be tested independently of the upstream
system profile library, whose names and relationships may change. The checked-in
fixture source at `packages/slicer-wasm/harness/fixtures/compatibility-profiles`
is a minimal FFF vendor package with two printers:

- **Compatibility Alpha** exposes one process through an explicit
  `compatible_printers` list and a second through
  `compatible_printers_condition` (`printer_notes == "alpha"`).
- Its two installed filaments use printer compatibility plus distinct
  `compatible_prints` lists, so changing Alpha's process forces a different
  compatible filament.
- **Compatibility Beta** has disjoint process and filament candidates.
  Switching from Alpha after selecting the condition-based profiles verifies
  the C++ engine's printer -> process -> filament fallback.

`profile-compatibility-smoke.mjs` builds this source at runtime with the
production `@orca/profile-resources` package builder, installs the resulting
versioned ZIP packages in WASM MEMFS, and calls the C++ bridge directly. It
asserts the exact native snapshot candidate order and resolved selections; no
TypeScript compatibility implementation participates in the assertions.

Run it against each built variant:

```powershell
pnpm --filter @orca/slicer-wasm profile-compatibility-smoke -- out/serial/orca_slice.js
pnpm --filter @orca/slicer-wasm profile-compatibility-smoke -- out/threaded/orca_slice.js
```

The command creates its package output under the OS temporary directory and
removes it in `finally`. It requires a built `orca_slice.js` variant but does
not require a WASM rebuild when only fixture or harness files change.
