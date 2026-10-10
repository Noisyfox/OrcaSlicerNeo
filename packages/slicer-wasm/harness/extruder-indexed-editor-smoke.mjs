import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages, fixtureProfileOptions } from './profile-installer.mjs';

const root = resolve(import.meta.dirname, '../../..');
const factory = await loadModuleFactory(resolve(process.argv[2] ?? `${root}/packages/slicer-wasm/out/serial/orca_slice.js`));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(`${root}/packages/profile-resources/dist`));
function call(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  const result = JSON.parse(Module.UTF8ToString(pointer)); Module._free(pointer); return result;
}
const must = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
must(call('orc_init', ['string'], [fixtureProfileOptions(Module)]));
let printer = 'Snapmaker U1 (0.4+0.6 nozzle)';
must(call('orc_select_printer_with_remembered_rack', ['string'], [JSON.stringify({ printer, remembered_rack: null, remembered_bed_type: null })]));
const read = () => must(call('orc_get_preset_draft', ['string', 'string'], ['printer', printer]));
function mutate(body, accept = true) {
  const result = call('orc_mutate_preset_draft', ['string'], [JSON.stringify({ kind: 'printer', canonical_name: printer,
    expected_revision: read().revision, ...body })]);
  if (accept) {
    must(result); assert.equal(result.history_entry_delta, 1); assert.equal(result.all_plate_results_invalidated, true);
    assert.equal(result.native_scoped_config.revision, result.history_status.revision);
    assert.equal(result.filament_session.revisions.session, result.history_status.revision);
    assert.equal(result.filament_session.revisions.project, result.history_status.revision);
    printer = result.canonical_name;
  }
  return result;
}
const set = (key, scalar_type, index, value) => mutate({ action: 'set-element', key, scalar_type, index, value });
const values = key => read().editor_vectors[key].effective_values;
assert.deepEqual(values('nozzle_diameter'), [0.4, 0.4, 0.6, 0.6]);
assert.deepEqual(values('min_layer_height'), [0.08, 0.08, 0.12, 0.12]);
assert.deepEqual(values('max_layer_height'), [0.32, 0.32, 0.48, 0.48]);

// Read every native vector type, and isolate edits at the third Extruder.
const initial = read();
for (const key of ['retraction_length', 'wipe', 'retract_before_wipe', 'z_hop_types', 'extruder_offset', 'extruder_printable_area'])
  assert.ok(Array.isArray(initial.editor_vectors[key].source_values), key);
mutate({ action: 'set', key: 'retraction_length', value: '0.8' });
set('retraction_length', 'float', 2, 1.7);
assert.deepEqual(values('retraction_length'), [0.8, 0.8, 1.7, 0.8]);
set('retraction_length', 'float', 0, 1.1);
mutate({ action: 'reset-field', key: 'retraction_length', index: 2 });
assert.deepEqual(values('retraction_length'), [1.1, 0.8, 0.8, 0.8]);
const originalWipe = values('wipe');
set('wipe', 'bool', 2, !originalWipe[2]);
assert.deepEqual(values('wipe').slice(0, 2), originalWipe.slice(0, 2));
set('retract_before_wipe', 'percent', 2, 35);
const originalEnum = values('z_hop_types');
const choice = initial.editor_vectors.z_hop_types.enum_options.find(option => option.value !== originalEnum[2]);
set('z_hop_types', 'enum', 2, choice.value);
set('extruder_offset', 'point', 2, { x: 3, y: 4 });
assert.deepEqual(values('extruder_offset')[2], { x: 3, y: 4 });
const polygon = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 0, y: 200 }];
set('extruder_printable_area', 'points', 2, polygon);
assert.deepEqual(values('extruder_printable_area'), [[], [], polygon, []]);
const revision = read().revision;
for (const request of [
  { action: 'set-element', key: 'retraction_length', scalar_type: 'float', index: 4, value: 1 },
  { action: 'set-element', key: 'z_hop', scalar_type: 'float', index: 2, value: 6 },
  { action: 'set-element', key: 'extruder_printable_area', scalar_type: 'points', index: 2, value: [{ x: 0, y: 0 }] },
  { action: 'reset-field', key: 'wipe', index: 4 },
]) assert.equal(mutate(request, false).ok, false, JSON.stringify(request));
assert.equal(read().revision, revision, 'rejections add no history');

const resetKeys = ['nozzle_diameter', 'nozzle_volume', 'extruder_printable_height', 'extruder_printable_area',
  'min_layer_height', 'max_layer_height', 'extruder_offset', 'retraction_length', 'retract_restart_extra',
  'retraction_speed', 'deretraction_speed', 'retraction_minimum_travel', 'retract_when_changing_layer',
  'wipe', 'wipe_distance', 'retract_before_wipe', 'retract_after_wipe', 'retract_lift_enforce', 'z_hop_types',
  'z_hop', 'travel_slope', 'retract_lift_above', 'retract_lift_below', 'retract_length_toolchange',
  'retract_restart_extra_toolchange', 'long_retractions_when_cut', 'retraction_distances_when_cut']
  .filter(key => Object.hasOwn(initial.source_values, key));
for (const key of resetKeys) assert.ok(initial.editor_vectors[key], `native typed vector for ${key}`);
mutate({ action: 'reset-category', keys: resetKeys, index: 2 });
assert.equal(values('retraction_length')[0], 1.1, 'category reset preserves the other Extruder');
assert.equal(values('retraction_length')[2], 0.8);
assert.deepEqual(values('extruder_offset')[2], initial.editor_vectors.extruder_offset.source_values[2]);
assert.deepEqual(values('extruder_printable_area'), [], 'reset removes a semantically empty overlay');
must(call('orc_history_undo')); // Native default context restores indexed drafts.
assert.deepEqual(values('extruder_printable_area')[2], polygon);
must(call('orc_history_redo'));
assert.deepEqual(values('extruder_printable_area'), []);

// A diameter combination matching another canonical profile must publish that
// source and its vectors in the same single-history mutation receipt.
set('nozzle_diameter', 'float', 2, 0.4);
set('nozzle_diameter', 'float', 3, 0.4);
assert.equal(printer, 'Snapmaker U1 (0.4 nozzle)');
assert.deepEqual(values('nozzle_diameter'), [0.4, 0.4, 0.4, 0.4]);
console.log('PASS indexed Extruder vectors, typed edits, short-vector expansion, reset isolation, history and diameter transition');
process.exit(0);
