// Real native remembered-bed transition, default fallback and project priority.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
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
const exported = must(call('orc_export_project'));
const bytes = Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + Number(exported.bytes_length)); Module._free(Number(exported.bytes_ptr));
transition(A, 'High Temp Plate');
const ptr = Number(Module._malloc(bytes.length)); Module.HEAPU8.set(bytes, ptr);
try { must(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, bytes.length, 0, 'bed-memory-priority.3mf'])); }
finally { Module._free(ptr); }
assert.equal(config(), 'Engineering Plate');
pass('valid embedded project bed takes priority over previous live memory seed');
console.log('remembered bed native smoke passed');
