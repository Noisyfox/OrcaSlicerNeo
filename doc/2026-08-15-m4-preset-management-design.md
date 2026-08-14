# M4 — Preset Management with AppConfig Fidelity (design)

Date: 2026-08-15. Status: **approved (this note is the design)**. Milestone
reference: `spec/Grand Plan.md` → "Full settings surface + search (from
metadata); preset management"; carry-forward from the M3 notes
(`doc/2026-08-14-m3-implementation-notes.md`, sixth round).

## Problem

M3's headless baseline runs on an **empty AppConfig**. Two consequences:

1. `Preset::set_visible_from_appconfig` marks every system printer **invisible**
   (`app_config.get_variant(vendor->id, printer_model, printer_variant)` is
   false with an empty vendor map — source-confirmed, Preset.cpp:855-880). The
   round-5 `orc_init` scan (first non-default preset) is a hack that papers
   over this: selection is a hard-coded fallback, not a real choice.
2. The app's Preset dropdowns (SettingsPanel) are **cosmetic**: changing the
   value only writes a local store key; the bridge selection — and therefore
   the slice — never changes. The picker must drive the real mechanism.

## The mechanism (source-confirmed, this session)

AppConfig is the single source of truth in this fork, serialized as JSON
(`USE_JSON_CONFIG` is hard-defined at AppConfig.cpp:37):

- `models: [{vendor, model, nozzle_diameter: [escaped variants]}]` → the
  vendor/model/variant installed map (`AppConfig::m_vendors`; `set_variant`
  / `vendors()` accessors are public).
- `presets: {printer, print, filament}` → current selections
  (`AppConfig::m_storage["presets"]`).
- `filaments: [...]` → installed filaments (visibility for TYPE_FILAMENT).

`PresetBundle::load_presets(app_config)` ends in `load_selections`
(PresetBundle.cpp:2775): `load_installed_printers` →
`set_visible_from_appconfig` (visibility), then
`printers.select_preset_by_name(presets.printer, true)` (selection), then
`update_compatible(Always)` + `update_multi_material_filament_presets()`
(print/filament follow the printer).

So the correct M4 shape: **the renderer owns an app-config JSON; the bridge
applies it; visibility and selection both derive from it.** `instantiation:
"false"` presets stay in the collection but are a "not installable" concern
for the future install/uninstall UI (they carry the same vendor/model/variant
triple, so they become visible when their variant is installed — the picker
may group them separately later).

## Bridge API (packages/slicer-wasm/src/bridge.cpp)

All JSON-in/JSON-out, synchronous, same error contract. Backward compatible:
no-arg `orc_init()` behaves exactly like today (fresh config ⇒ all installed
⇒ round-5 scan picks the first non-default).

### `orc_init(app_config_json)` — app-config-aware init

1. Parse the JSON into `state().app_config` via the public setters:
   - `models` entries → `set_variant(vendor, model, variant, true)`
   - `presets` section → `set("presets", key, value)`
   - `filaments` section → `set_section("filaments", {name:"true"})`
   - everything else ignored (v1: no app settings cross the bridge)
2. `load_presets(app_config, Enable)` (as today; `load_selections` runs inside
   and applies visibility + `presets.printer` selection).
3. **Fresh-config default:** if the incoming JSON has no `models` section,
   install every printer the bundle ships — iterate the printers collection
   (public `begin()/end()`, skips generated "- default -"), for each preset
   with a non-empty `vendor->id` / `printer_model` / `printer_variant` triple
   call `app_config.set_variant(...)`, then re-run `load_installed_printers`
   + the selection step. When `presets.printer` was also empty, keep the
   round-5 first-non-default scan as the fallback pick (now over an
   all-visible collection — same result as today, but via the real
   visibility mechanism).

### `orc_set_app_config(app_config_json)` — re-init with a new config

Same body as orc_init's steps 1-3. This is the future install/uninstall
path: the renderer edits the `models` section and re-inits. No dedicated
per-vendor API in v1.

### `orc_get_presets(kind)` — enriched

Each entry gains: `name` (as today), `is_visible` (the real
`set_visible_from_appconfig` result), `is_default`, `vendor_id`, `model`,
`variant` (null when absent). Guards for null `vendor`. The picker groups
installed (visible) vs available (hidden) from this — never from `is_visible`
logic of its own.

### `orc_select_preset(kind, name)` — the real selection path

Replaces the diagnostic-only `orc_select_printer(idx)` for app use (the
diagnostic stays for probes):

1. `kind` ∈ `printer | print | filament`; look up via
   `coll.find_preset(name)` (Preset.hpp:696).
2. `coll.select_preset_by_name(name, true)` (Preset.hpp:806).
3. `kind == printer` ⇒ `presets.update_compatible(PresetSelectCompatibleType::
   Always)` + `update_multi_material_filament_presets()` — the exact tail of
   `load_selections`, so filament/print follow the new printer without a
   full bundle reload.
4. Write the selection back to `state().app_config` (`presets.<type>` =
   selected names of all three collections — keeps the config
   authoritative) and return `{ok, printer:{name,idx}, print:{...},
   filament:{...}}` so the renderer can sync without guessing.

### `orc_get_app_config()`

Serializes the live `state().app_config` back to the fork's JSON schema
(`models` from the public `vendors()` map, `presets` + `filaments` from
`m_storage`) — the persistence contract for the renderer, generated from
the same code paths the desktop's `AppConfig::save()` uses.

### `orc_dump_state()`

Extends the existing scan block: `num_visible` after a real load (now
meaningful — with the fresh-config default it reads the all-installed
count), plus the selected printer's vendor/model/variant.

## Electron app (apps/desktop)

- **IPC** (shared/ipc.ts + main + preload): `appConfig:load` /
  `appConfig:save` — main reads/writes `join(app.getPath('userData'),
  'appconfig.json')` (create on first save; `ORCA_E2E=1` keeps the current
  behavior, e2e supplies a path via env if needed). Preload exposes
  `window.orca.appConfig`.
- **Boot** (App.tsx): load app config → `client.init(json)` →
  `getPresets` ×3 (enriched) + metadata → store. No config file ⇒
  `init()` with no payload (fresh default).
- **Store** (useSettingsStore): preset lists become `PresetInfo[]`
  (`{name, isVisible, vendorId, model, variant}`); selections
  (`printer/print/filament` values) sync from `selectPreset` responses.
- **Picker** (SettingsPanel): Printer/Process/Filament selects list the
  **visible** presets first, hidden ones in a dimmed "not installed" group
  (disabled in v1 — install/uninstall is a later slice). Changing a value
  calls `slicerClient.selectPreset(kind, name)`, updates the store, and
  persists the config (`appConfig.save`). The slice then runs on the picked
  machine — the UI choice finally reaches the C++.

## Verification

1. Rebuild the WASM module locally (emsdk active, `build.sh` — ~30 min on
   this machine; CI will confirm on push).
2. Probes (node, temp dir):
   - `orc_init()` no-arg ⇒ all-installed, selection = first non-default,
     `num_visible` = collection size − leading defaults.
   - `orc_init('{"presets":{"printer":"Afinia H+1(HS)"}}')` ⇒ Afinia
     selected; slice exports its PRINT_START gcode.
   - `orc_select_preset("printer", "TerabotX")` ⇒ selection + compatible
     filament/print follow; slice exports TerabotX's start block; app
     config round-trips through `orc_get_app_config`.
   - `orc_init('{"models":[...one variant...]}')` ⇒ only that variant
     visible (the mechanism works for partial installs).
3. Harness `bridge-smoke.mjs` + `run-slice.mjs` stay green (no-arg path
   unchanged); mock module (unit tests + e2e stub) extended with the new
   ops; vitest for client; e2e asserts the picker drives the slice.
4. Packaged-app probe re-run.

## M3 carry-forward items folded in

- `get_hrc_by_nozzle_type` nozzle_info.json parse error: ship the file in
  the preload bundle if present in the submodule, else suppress.
- Bad config enum values (`gcode_flavor: "bogus"`): probe the module stays
  alive (catch-all at orc_slice); harden per-key `set_deserialize` if it
  escapes.
- Renderer CSP warning: document or fix, whichever the evidence supports.

## Sequencing (rest of M4, queued after this slice)

Project save/load (.3mf/bbs_3mf) → full settings surface + search →
gizmos → threading (wasmtbb + pthreads) → STEP decision → CGAL → device
panel → calibration → i18n → auto-update/signing → in-app webviews.
This slice is the preset-management entry point of "Full settings surface
+ search (from metadata); preset management".
