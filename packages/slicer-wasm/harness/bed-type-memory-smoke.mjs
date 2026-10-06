// Real native remembered-bed transition, default fallback and project priority.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { callAsyncTask, getSliceResult, exportGcode } from './async-task-mailbox.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { loadModuleFactory } from './run-slice.mjs';
const moduleArg = process.argv[2];
if (!moduleArg) throw new Error('usage: bed-type-memory-smoke.mjs <module.js>');
const Module = await (await loadModuleFactory(resolve(moduleArg)))({ noInitialRun: true, print: () => {}, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
function request(name, body) { return call(name, ['string'], [JSON.stringify(body)]); }
function must(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function config() { return must(call('orc_get_native_scoped_config')).native_scoped_config.snapshot.project.curr_bed_type; }
function transition(printer, bed) { return must(request('orc_select_printer_with_remembered_rack', { printer, remembered_rack: null, remembered_bed_type: bed })); }
function reset() { return call('orc_history_reset', ['string'], [JSON.stringify({ selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} })]); }
function pass(label) { console.log(`bed-memory PASS ${label}`); }
must(call('orc_init', ['string'], ['{"log_level":"error"}']));
must(call('orc_clear_model'));
const A = 'Bambu Lab X1 Carbon 0.4 nozzle';
// Use canonical names from the real bundled catalog (U1 naming can change).
const u1 = must(call('orc_get_preset_snapshot')).printers.find(p => p.name.includes('Snapmaker U1') && p.name.includes('0.4'))?.name;
assert.ok(u1, 'bundled U1 printer available');
for (const omitted of ['remembered_rack', 'remembered_bed_type']) {
  const beforeProfile = call('orc_get_preset_snapshot');
  const beforeHistory = call('orc_history_status');
  const requestBody = { printer: A, remembered_rack: null, remembered_bed_type: null };
  delete requestBody[omitted];
  assert.equal(request('orc_select_printer_with_remembered_rack', requestBody).error_code, 'invalid_request');
  assert.deepEqual(call('orc_get_preset_snapshot'), beforeProfile);
  assert.deepEqual(call('orc_history_status'), beforeHistory);
}
pass('required nullable transition fields reject legacy omission atomically');

transition(A, 'High Temp Plate'); reset();
const before = call('orc_history_status');
const second = transition(u1, 'Engineering Plate');
assert.equal(second.mutation.history_entry_delta, 1);
assert.equal(second.history_status.revision, before.revision + 1);
assert.equal(config(), 'Engineering Plate');
assert.equal(second.native_scoped_config.snapshot.project.curr_bed_type, 'Engineering Plate');
pass('remembered bed is native receipt state in the one printer history transaction');
must(call('orc_history_undo')); assert.equal(config(), 'High Temp Plate');
must(call('orc_history_redo')); assert.equal(config(), 'Engineering Plate');
pass('Undo/Redo restore transaction bed roots without replaying memory');
transition(A, 'High Temp Plate'); assert.equal(config(), 'High Temp Plate');
transition(u1, 'Engineering Plate'); assert.equal(config(), 'Engineering Plate');
pass('independent A/B seeds retain each printer choice');
transition(u1, 'retired-invalid-bed'); assert.equal(config(), 'Textured PEI Plate');
transition(u1, null); assert.equal(config(), 'Textured PEI Plate');
transition('Bambu Lab A1 mini 0.4 nozzle', 'Engineering Plate');
assert.notEqual(config(), 'Engineering Plate');
pass('missing, stale and model-excluded memory use native supported default');
transition(u1, 'Engineering Plate');
let source = must(call('orc_get_preset_draft', ['string', 'string'], ['printer', u1]));
must(request('orc_mutate_preset_draft', { action: 'set', kind: 'printer', canonical_name: u1, expected_revision: source.revision, key: 'support_multi_bed_types', value: '0' }));
const single = transition(u1, 'Engineering Plate');
assert.equal(single.profile_snapshot.bed_type.supports_selection, false);
assert.equal(config(), 'Textured PEI Plate');
pass('single-bed effective printer draft ignores incompatible memory');
source = must(call('orc_get_preset_draft', ['string', 'string'], ['printer', u1]));
must(request('orc_mutate_preset_draft', { action: 'set', kind: 'printer', canonical_name: u1, expected_revision: source.revision, key: 'support_multi_bed_types', value: '1' }));
transition(u1, 'Engineering Plate');
must(call('orc_add_shape', ['string', 'string'], ['Cube', 'Remembered bed project priority']));
const plate = must(call('orc_get_plate_session_snapshot')).current_plate_id;
const filament = must(call('orc_get_filament_session_snapshot')).slots[0].preset.name;
for (const [key, value] of Object.entries({ hot_plate_temp_initial_layer: '58', hot_plate_temp: '51', textured_plate_temp_initial_layer: '67', textured_plate_temp: '62' })) {
  const draft = must(call('orc_get_preset_draft', ['string', 'string'], ['filament', filament]));
  must(request('orc_mutate_preset_draft', { action: 'set', kind: 'filament', canonical_name: filament, expected_revision: draft.revision, key, value }));
}
async function sliceBed(bed) {
  must(setNativeScopedConfig(call, 'project', undefined, 'curr_bed_type', bed));
  const stamp = must(call('orc_get_plate_session_snapshot')).input_revisions[plate];
  const result = must(await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'], ['{}', plate, stamp]));
  must(getSliceResult(call, result.receipt));
  const path = must(exportGcode(call, { receipt: result.receipt, filenameBase: '' })).path;
  return Module.FS.readFile(path, { encoding: 'utf8' });
}
const hot = await sliceBed('High Temp Plate');
const textured = await sliceBed('Textured PEI Plate');
for (const [gcode, first, other] of [[hot, 58, 51], [textured, 67, 62]]) {
  assert.match(gcode, new RegExp(`^M140 S${first}\\b`, 'm'));
  assert.match(gcode, new RegExp(`^M190 S${first}\\b`, 'm'));
  assert.match(gcode, new RegExp(`^M140 S${other}\\b`, 'm'));
  assert.ok((gcode.match(/^G1\b[^\r\n]*\b[XY][-\d.]+[^\r\n]*\bE[\d.]+/gm) ?? []).length > 10, 'real extrusion G-code');
}
assert.match(hot, /^G28 Z Z_OFFSET -0\.07\s*$/m);
assert.doesNotMatch(textured, /^G28 Z Z_OFFSET -0\.07\s*$/m);
pass('real U1 High Temp/Textured first+other bed temperatures and High Temp Z_OFFSET branch');
must(setNativeScopedConfig(call, 'project', undefined, 'curr_bed_type', 'Engineering Plate'));
must(setNativeScopedConfig(call, 'plate', plate, 'curr_bed_type', 'High Temp Plate'));
const exported = must(call('orc_export_project'));
const bytes = Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + Number(exported.bytes_length)); Module._free(Number(exported.bytes_ptr));
transition(A, 'High Temp Plate');
const ptr = Number(Module._malloc(bytes.length)); Module.HEAPU8.set(bytes, ptr);
try {
  const loaded = must(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, bytes.length, 0, 'bed-memory-priority.3mf']));
  assert.equal(loaded.bed_type_normalization, null);
}
finally { Module._free(ptr); }
assert.equal(config(), 'Engineering Plate');
const loadedConfig = must(call('orc_get_native_scoped_config')).native_scoped_config.snapshot;
assert.equal(Object.values(loadedConfig.plates)[0].curr_bed_type, 'High Temp Plate');
assert.equal(call('orc_history_status').dirty, false);
pass('valid 3MF global/local bed roots take priority and establish clean history');
const entries = readZipEntries(bytes);
const settings = entries.find(entry => entry.name === 'Metadata/project_settings.config');
assert.ok(settings, 'native project settings archive entry');
const invalid = JSON.parse(new TextDecoder().decode(settings.content));
invalid.support_multi_bed_types = '0';
settings.content = new TextEncoder().encode(JSON.stringify(invalid));
const invalidBytes = writeStoredZip(entries);
const invalidPtr = Number(Module._malloc(invalidBytes.length)); Module.HEAPU8.set(invalidBytes, invalidPtr);
let normalized;
try { normalized = must(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [invalidPtr, invalidBytes.length, 0, 'unsupported-imported-bed.3mf'])); }
finally { Module._free(invalidPtr); }
assert.equal(normalized.preset_snapshot.bed_type.supports_selection, false);
assert.equal(normalized.bed_type_normalization.global_changed, true);
assert.equal(normalized.bed_type_normalization.removed_plate_override_ids.length, 1);
assert.equal(config(), 'Textured PEI Plate');
const normalizedConfig = must(call('orc_get_native_scoped_config')).native_scoped_config.snapshot;
assert.equal(Object.values(normalizedConfig.plates)[0]?.curr_bed_type, undefined);
assert.equal(call('orc_history_status').dirty, false);
assert.equal(call('orc_history_status').canUndo, false);
pass('unsupported imported global/local beds normalize before clean history baseline');
console.log('remembered bed native smoke passed');
