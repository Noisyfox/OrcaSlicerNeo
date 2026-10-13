import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { fixtureProfileOptions, createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { readZipEntries } from './native-3mf-parser.mjs';

if (!process.argv[2]) throw new Error('usage: node user-preset-project-warnings-smoke.mjs <orca_slice.js>');
const profileRoot = resolve(import.meta.dirname, '../../profile-resources/dist');
const Module = await (await loadModuleFactory(resolve(process.argv[2])))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));
function call(name, args = [], types = args.map(() => 'string')) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
}
const request = (name, body) => call(name, [JSON.stringify(body)]);
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const status = () => call('orc_history_status');
const rack = () => ok(call('orc_get_filament_session_snapshot'));
function save(kind, source, name) {
  const receipt = ok(request('orc_prepare_user_preset', { history_context: context, action: 'save-as', kind,
    canonical_name: source, name, expected_revision: status().revision }));
  ok(request('orc_finish_user_preset', { token: receipt.token, commit: true }));
}
function exportProject() {
  const result = ok(call('orc_export_project'));
  const bytes = Module.HEAPU8.slice(Number(result.bytes_ptr), Number(result.bytes_ptr) + result.bytes_length);
  Module._free(Number(result.bytes_ptr));
  const entry = readZipEntries(bytes).find(value => value.name === 'Metadata/project_settings.config');
  return { bytes, config: JSON.parse(new TextDecoder().decode(entry.content)) };
}
function load(bytes) {
  const pointer = Number(Module._malloc(bytes.length));
  Module.HEAPU8.set(bytes, pointer);
  try { return ok(call('orc_load_project', [pointer, bytes.length, 0, 'user-preset-warning.3mf'], ['pointer', 'number', 'number', 'string'])); }
  finally { Module._free(pointer); }
}
ok(call('orc_init', [fixtureProfileOptions(Module)]));
ok(request('orc_select_printer_with_remembered_rack', { history_context: context,
  printer: 'Bambu Lab H2D 0.2 nozzle', remembered_bed_type: null, remembered_rack: null }));
const profiles = ok(call('orc_get_preset_snapshot'));
save('printer', profiles.printer.name, 'Warning User Printer');
save('print', profiles.print.name, 'Warning User Process');
ok(request('orc_select_filament_slot_preset', { version: 1, revision: rack().revisions.session,
  slot: 1, preset: 'Bambu PLA Basic @BBL H2D 0.2 nozzle' }));
save('filament', rack().slots[0].preset.name, 'Warning User PLA');
ok(request('orc_add_filament_slot', { version: 1, revision: rack().revisions.session }));
ok(request('orc_select_filament_slot_preset', { version: 1, revision: rack().revisions.session, slot: 2, preset: 'Warning User PLA' }));
ok(call('orc_add_shape', ['Cube', 'user-preset warning regression']));
const clean = exportProject();
assert.equal(clean.config.filament_settings_id.length, 2);
for (const keys of clean.config.different_settings_to_system)
  assert.equal(keys.split(';').some(key => /^(?:filament_(?:start|end)|machine_(?:start|end))_gcode$/.test(key)), false,
    'unchanged G-code must not appear in actual-difference metadata');
const reopened = load(clean.bytes);
assert.equal(reopened.embedded_preset_warnings.present, true);
assert.equal(reopened.embedded_preset_warnings.requires_confirmation, false);
assert.equal(reopened.preset_snapshot.printer.name, 'Warning User Printer');
assert.ok(rack().slots.every(slot => slot.preset.name === 'Warning User PLA'));

// Retaining effective values still requires every real parameter difference,
// and a real G-code edit must continue to trigger Orca's warning on reopen.
ok(request('orc_mutate_preset_draft', { history_context: context, action: 'set', kind: 'filament',
  canonical_name: 'Warning User PLA', key: 'nozzle_temperature', value: '231', expected_revision: status().revision }));
ok(request('orc_mutate_preset_draft', { history_context: context, action: 'set', kind: 'filament',
  canonical_name: 'Warning User PLA', key: 'filament_start_gcode', value: '; actual edited G-code\n', expected_revision: status().revision }));
const modified = exportProject();
for (const keys of modified.config.different_settings_to_system.slice(1, 3)) {
  assert.ok(keys.split(';').includes('nozzle_temperature'));
  assert.ok(keys.split(';').includes('filament_start_gcode'));
}
const warned = load(modified.bytes);
assert.equal(warned.embedded_preset_warnings.requires_confirmation, true);
assert.ok(warned.embedded_preset_warnings.modified_gcode_keys.includes('filament_start_gcode'));
const draft = ok(call('orc_get_preset_draft', ['filament', rack().slots[0].preset.name]));
assert.ok(draft.effective_values.nozzle_temperature.split(',').every(value => value === '231'));
console.log('user-preset-project-warnings PASS: H2D two-slot user presets, accurate diff metadata, silent clean reopen and preserved genuine edits/warnings');
process.exit(0);
