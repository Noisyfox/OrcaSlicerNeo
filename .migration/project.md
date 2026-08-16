# project

2026-08-16 — radix → Base UI migration of the OrcaSlicerNeo desktop renderer.
Progressive-mode execution over all 3 radix wrappers (this project's full
radix surface). One commit per component, then the dependency swap.

## Dependency swap

- Installed `@base-ui/react@1.7.0` (apps/desktop/package.json, pnpm-lock.yaml).
- Removed all radix packages after the last wrapper was finalized:
  `@radix-ui/react-dialog` (installed but never imported — removed),
  `@radix-ui/react-label`, `@radix-ui/react-select`, `@radix-ui/react-slider`.
- `grep -rn "@radix-ui\|radix-ui" apps/desktop` → zero matches (verified
  after removal).
- Final verification: `pnpm run typecheck` (tsconfig.node + tsconfig.web)
  green; `pnpm run build` (electron-vite production) green — same shape as
  the pre-migration baseline (baseline typecheck was green before any
  dependency touched).

## App-code consumer sweep

Per-component reports: `.migration/label.md`, `.migration/slider.md`,
`.migration/select.md`. Call-site changes beyond import lines:

- `viewport/LayerScrubber.tsx:26` — slider `onValueChange` array guard
  (wrapper concretizes Base UI's generic `Value` at its default
  `number | readonly number[]`).
- `settings/OptionField.tsx:31` — select `onValueChange` null guard
  (Base UI widens value to `Value | null`).
- `settings/SettingsPanel.tsx:97` — same null guard; `value || undefined`
  still valid (Base UI accepts `| null | undefined`).

No `asChild` usage existed anywhere in app code; no `position` prop was
passed by any call site (the popper→item-aligned default change is flagged
in `.migration/select.md`).

## FLAGGED (not fixed)

- `components.json` style remains `"default"` — a legacy shadcn style with
  **no `base-<style>` registry counterpart**, so the CLI would still deliver
  radix variants on a future `shadcn add`. There is nothing to flip to; the
  project's wrappers are now Base UI by hand. If the project later moves to a
  current shadcn style (e.g. `radix-lyra` → `base-lyra`), this migration's
  reports are the diff to replay.
- Pre-existing dirty git state, untouched: `packages/slicer-wasm/cpp`
  submodule has 6 modified libslic3r files (EdgeGrid.cpp,
  ExPolygonCollection.cpp, LocalesUtils.cpp, Model.hpp, Platform.cpp,
  utils.cpp) — in-progress C++ work, unrelated to this migration. All
  migration commits touch only `apps/desktop` + `.migration/`.
- `e2e/slice-error.e2e.ts` skipped in mock mode — pre-existing
  `test.skip(!REAL, ...)` condition, unrelated.

## Never touched (per skill hard rules)

No other third-party wrappers exist in this project (no cmdk/vaul/sonner/
input-otp/day-picker/recharts). `button.tsx`, `checkbox.tsx`, `input.tsx`,
`progress.tsx` are hand-rolled plain-Tailwind components with no radix
imports — not part of this migration.

## Runtime verification

- `pnpm run test:e2e` (Playwright Electron, mock module): full v1 flow
  **passed** — open model → preset selects → slice → preview → export gcode.
  Exercises both migrated interactive components (`preset-select`,
  `layer-scrubber`). Slice-error test skipped by its pre-existing mock-mode
  condition.

## Remaining radix surface

0 wrappers remain on Radix (project fully migrated).
