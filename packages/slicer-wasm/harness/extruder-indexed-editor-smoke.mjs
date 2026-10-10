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

// The sidebar Multi. command and editor must agree after restoring a diameter.
function diameter(value) {
  return must(call('orc_set_toolhead_diameter', ['string'], [JSON.stringify({
    index: 2, diameter: value, expected_revision: read().revision,
  })]));
}
const diameterChanged = diameter(0.4);
assert.equal(read().modified, true);
assert.ok(diameterChanged.profile_snapshot.modified_presets.printer.includes(printer));
const diameterRestored = diameter(0.6);
assert.equal(read().modified, true, 'writing the source diameter retains its explicit override');
assert.equal(Object.hasOwn(read().overrides, 'nozzle_diameter'), true);
assert.ok(diameterRestored.profile_snapshot.modified_presets.printer.includes(printer));
must(call('orc_history_undo'));
assert.equal(read().modified, true);
assert.equal(values('nozzle_diameter')[2], 0.4);
must(call('orc_history_redo'));
assert.equal(read().modified, true);
assert.equal(values('nozzle_diameter')[2], 0.6);
const diameterReset = mutate({ action: 'reset-field', key: 'nozzle_diameter', index: 2 });
assert.equal(read().modified, false, 'Reset removes the final source-equivalent override');
assert.equal(read().draft_exists, true, 'Reset retains the empty draft identity');
assert.equal(diameterReset.profile_snapshot.modified_presets.printer.includes(printer), false);
must(call('orc_history_undo'));
assert.equal(read().modified, true, 'Undo restores the explicit equal-value override');
must(call('orc_history_redo'));
assert.equal(read().modified, false);

// Read every native vector type, and isolate edits at the third Extruder.
const initial = read();
for (const key of ['retraction_length', 'wipe', 'retract_before_wipe', 'z_hop_types', 'extruder_offset', 'extruder_printable_area'])
  assert.ok(Array.isArray(initial.editor_vectors[key].source_values), key);
mutate({ action: 'set', key: 'retraction_length', value: '0.8' });
set('retraction_length', 'float', 2, 1.7);
assert.deepEqual(values('retraction_length'), Array.from({ length: initial.editor_vectors.retraction_length.index_count }, (_, i) => i === 2 ? 1.7 : 0.8));
set('retraction_length', 'float', 0, 1.1);
mutate({ action: 'reset-field', key: 'retraction_length', index: 2 });
assert.deepEqual(values('retraction_length'), Array.from({ length: initial.editor_vectors.retraction_length.index_count }, (_, i) => i === 0 ? 1.1 : 0.8));
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
  { action: 'set-element', key: 'retraction_length', scalar_type: 'float', index: initial.editor_vectors.retraction_length.index_count, value: 1 },
  { action: 'set-element', key: 'z_hop', scalar_type: 'float', index: 2, value: 6 },
  { action: 'set-element', key: 'extruder_printable_area', scalar_type: 'points', index: 2, value: [{ x: 0, y: 0 }] },
  { action: 'reset-field', key: 'wipe', index: initial.editor_vectors.wipe.index_count },
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

// Variant counts are independent of physical extruder counts; U1 stores SF/HF columns.
assert.equal(initial.editor_vectors.nozzle_diameter.index_count, 4);
assert.equal(initial.editor_vectors.retraction_length.index_count, 8);
assert.equal(initial.editor_vectors.machine_max_speed_e.index_count, 16);
const filament = 'Generic PLA @System';
const readFilament = () => must(call('orc_get_preset_draft', ['string', 'string'], ['filament', filament]));
function filamentMutate(body, accept = true) {
  const result = call('orc_mutate_preset_draft', ['string'], [JSON.stringify({ kind: 'filament', canonical_name: filament,
    expected_revision: readFilament().revision, ...body })]);
  return accept ? must(result) : result;
}
const baseFilament = readFilament();
const fi = baseFilament.editor_vectors.filament_flow_ratio.index_count - 1;
assert.ok(fi > 0, 'native Filament has multiple variants');
filamentMutate({ action: 'set-element', key: 'filament_flow_ratio', scalar_type: 'float', index: 0, value: 1.01 });
filamentMutate({ action: 'set-element', key: 'filament_flow_ratio', scalar_type: 'float', index: fi, value: 1.02 });
filamentMutate({ action: 'set-element', key: 'filament_retraction_length', scalar_type: 'float', index: fi, value: 1.3 });
const beforeInvalidReset = readFilament();
assert.equal(filamentMutate({ action: 'reset-category', keys: ['filament_flow_ratio', 'filament_vendor'], index: fi }, false).ok, false);
assert.deepEqual(readFilament(), beforeInvalidReset, 'invalid batch resets leave all elements and history unchanged');
filamentMutate({ action: 'reset-category', keys: ['filament_flow_ratio', 'filament_retraction_length'], index: fi });
assert.equal(readFilament().editor_vectors.filament_flow_ratio.effective_values[0], 1.01);
assert.equal(readFilament().editor_vectors.filament_flow_ratio.effective_values[fi], baseFilament.editor_vectors.filament_flow_ratio.source_values[fi]);
assert.equal(readFilament().editor_vectors.filament_retraction_length.effective_values[fi], null, 'indexed reset restores nullable native source');
must(call('orc_history_undo'));
assert.equal(readFilament().editor_vectors.filament_flow_ratio.effective_values[fi], 1.02);
must(call('orc_history_redo'));

const readPrint = () => must(call('orc_get_print_config_editor'));
const printHistoryContext = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
function printMutate(body, accept = true) {
  const tx = accept ? must(call('orc_history_begin', ['string', 'string', 'string', 'string'],
    ['Print element operation', 'project', JSON.stringify(printHistoryContext), ''])) : null;
  const result = call('orc_mutate_native_scoped_config', ['string'], [JSON.stringify({ version: 1,
    targets: [{ scope: 'project' }], expected_revision: readPrint().revision, ...body })]);
  if (accept) {
    must(result);
    const commit = call('orc_history_commit', ['string', 'string'], [tx.transactionId, JSON.stringify(printHistoryContext)]);
    assert.ok(commit.status?.canUndo, JSON.stringify(commit));
  }
  return result;
}
const basePrint = readPrint();
const pi = basePrint.editor_vectors.outer_wall_speed.index_count - 1;
assert.ok(pi > 0, 'Print preserves all variant columns');
// Whole serialized values remain a distinct operation; element writes expand a short vector using its fallback.
printMutate({ operation: 'set', key: 'outer_wall_speed', value: '100' });
assert.deepEqual(readPrint().source_values, basePrint.source_values, 'materialization keeps the selected Print source as the reset baseline');
printMutate({ operation: 'set-element', key: 'outer_wall_speed', scalar_type: 'float', index: pi, value: 175 });
assert.deepEqual(readPrint().editor_vectors.outer_wall_speed.effective_values,
  Array.from({ length: pi + 1 }, (_, i) => i === pi ? 175 : 100));
printMutate({ operation: 'set-element', key: 'enable_overhang_speed', scalar_type: 'bool', index: pi, value: false });
printMutate({ operation: 'set-element', key: 'small_perimeter_speed', scalar_type: 'float_or_percent', index: pi, value: { value: 45, percent: true } });
const printBeforeRejections = readPrint();
for (const body of [
  { operation: 'set-element', key: 'outer_wall_speed', scalar_type: 'float', index: pi + 1, value: 1 },
  { operation: 'set-element', key: 'outer_wall_speed', scalar_type: 'bool', index: pi, value: false },
  { operation: 'set-element', key: 'small_perimeter_speed', scalar_type: 'float_or_percent', index: pi, value: { value: -1, percent: true } },
  { operation: 'reset-elements', keys: ['outer_wall_speed', 'layer_height'], index: pi },
  { operation: 'reset-elements', keys: ['outer_wall_speed'], index: pi, expected_revision: 0 },
]) assert.equal(printMutate(body, false).ok, false, JSON.stringify(body));
assert.deepEqual(readPrint(), printBeforeRejections, 'Print rejections do not change owner, vectors or history');
printMutate({ operation: 'reset-elements', keys: ['outer_wall_speed', 'enable_overhang_speed', 'small_perimeter_speed'], index: pi });
assert.equal(readPrint().editor_vectors.outer_wall_speed.effective_values[0], 100);
assert.equal(readPrint().editor_vectors.outer_wall_speed.effective_values[pi], basePrint.editor_vectors.outer_wall_speed.source_values[pi]);
must(call('orc_history_undo'));
assert.equal(readPrint().editor_vectors.outer_wall_speed.effective_values[pi], 175);
must(call('orc_history_redo'));
assert.equal(readPrint().editor_vectors.outer_wall_speed.effective_values[pi], basePrint.editor_vectors.outer_wall_speed.source_values[pi]);
console.log('PASS generic Printer/Filament/Print vectors, valid ranges, typed edits, atomic indexed reset and history');
process.exit(0);
