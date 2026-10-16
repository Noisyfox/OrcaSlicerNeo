import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages, fixtureProfileOptions } from './profile-installer.mjs';
import { readZipEntries, replaceEntry } from './native-3mf-parser.mjs';

const editingContext = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };

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
must(call('orc_add_shape', ['string', 'string'], ['Cube', 'toolhead context']));
assert.equal(call('orc_history_reset', ['string'], [JSON.stringify(editingContext)]).canUndo, false);
const selectedObject = must(call('orc_get_model_structure')).objects[0];
editingContext.selection = { mode: 'instance', objectIds: [], partIds: [], instanceIds: [selectedObject.instances[0].id] };
editingContext.gizmo = { type: 'scale' };
function restoreContext(command) {
  const restored = must(call(command));
  assert.deepEqual(restored.context.selection, editingContext.selection);
  assert.deepEqual(restored.context.gizmo, editingContext.gizmo);
}
let printer = 'Snapmaker U1 (0.4+0.6 nozzle)';
must(call('orc_select_printer_with_remembered_rack', ['string'], [JSON.stringify({ history_context: editingContext, printer, remembered_rack: null, remembered_bed_type: null })]));
restoreContext('orc_history_undo');
restoreContext('orc_history_redo');
const read = () => must(call('orc_get_preset_draft', ['string', 'string'], ['printer', printer]));
function mutate(body, accept = true) {
  const result = call('orc_mutate_preset_draft', ['string'], [JSON.stringify({ history_context: editingContext, kind: 'printer', canonical_name: printer,
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

// Native mapping oracle: physical head 3 is element 2, its SF/HF variants
// are 4/5, and normal motion columns retain the native stride of two (8/10).
const choiceBinding = (snapshot, key, head, flow) => {
  const selection = snapshot.editor_selection;
  const index = selection.choices.findIndex(c => c.extruder_index === head && c.flow_type === flow);
  assert.ok(index >= 0, `choice for head ${head}, flow ${flow}`);
  const field = selection.field_bindings[key];
  assert.equal(field.kind, 'per_selection', key);
  return field.bindings[index];
};
const mapping = read();
assert.equal(mapping.editor_selection.active_source, true);
assert.deepEqual(mapping.editor_selection.choices.map(c => [c.extruder_index, c.flow_type]),
  [[0,0],[0,1],[1,0],[1,1],[2,0],[2,1],[3,0],[3,1]]);
for (const [flow, variant, motion] of [[0,4,8],[1,5,10]]) {
  assert.deepEqual(choiceBinding(mapping, 'nozzle_diameter', 2, flow), {kind: 'indexed', index: 2});
  assert.deepEqual(choiceBinding(mapping, 'retraction_length', 2, flow), {kind: 'indexed', index: variant});
  assert.deepEqual(choiceBinding(mapping, 'machine_max_speed_e', 2, flow), {kind: 'indexed', index: motion});
}
assert.deepEqual(mapping.editor_selection.field_bindings.emit_machine_limits_to_gcode, {kind: 'shared'});
assert.deepEqual(mapping.editor_selection.nozzles.map(n => [n.default_choice_id, n.initial_choice_id]),
  Array.from({length: 4}, (_, head) => [`extruder-${head}-flow-0`, `extruder-${head}-flow-0`]));
// Native default_filament_profile intentionally stays short on multi-nozzle printers.
assert.equal(mapping.editor_vectors.default_filament_profile.source_values.length, 1);
assert.equal(mapping.editor_vectors.default_filament_profile.index_count, 4);
assert.deepEqual(choiceBinding(mapping, 'default_filament_profile', 2, 1), {kind: 'indexed', index: 2});
assert.equal(read().revision, mapping.revision, 'selection navigation metadata is a pure read');

// Browsed defaults/drafts and topology must not be borrowed from the active project.
const inactiveName = 'Snapmaker U1 (0.4 nozzle)';
const inactiveRead = () => must(call('orc_get_preset_draft', ['string','string'], ['printer', inactiveName]));
const inactiveSet = (key, value) => must(call('orc_mutate_preset_draft', ['string'], [JSON.stringify({
  history_context: editingContext, kind: 'printer', canonical_name: inactiveName, action: 'set',
  key, value, expected_revision: inactiveRead().revision,
})]));
inactiveSet('default_nozzle_volume_type', 'High Flow,High Flow,Hybrid,Standard');
let inactive = inactiveRead();
assert.equal(inactive.editor_selection.active_source, false);
assert.equal(inactive.editor_selection.nozzles[1].default_choice_id, 'extruder-1-flow-1');
assert.equal(inactive.editor_selection.nozzles[1].initial_choice_id, 'extruder-1-flow-1');
assert.equal(inactive.editor_selection.nozzles[2].default_choice_id, 'extruder-2-flow-0', 'Hybrid native default normalizes to SF');
inactiveSet('extruder_variant_list', 'Direct Drive High Flow;Direct Drive Standard;Direct Drive Standard,Direct Drive High Flow;Direct Drive Standard');
inactive = inactiveRead();
assert.deepEqual(inactive.editor_selection.choices.map(c => [c.extruder_index,c.flow_type]), [[0,1],[1,0],[2,0],[2,1],[3,0]]);
assert.equal(inactive.editor_selection.nozzles[1].default_choice_id, 'extruder-1-flow-0', 'unavailable default uses first native supported editor flow');
assert.deepEqual(read().editor_selection, mapping.editor_selection, 'browsing another Printer does not change active context');
// A valid choice and its physical fields survive a missing native variant map.
inactiveSet('printer_extruder_id', '1,1,1,1,1,1,1,1');
inactive = inactiveRead();
assert.deepEqual(choiceBinding(inactive, 'retraction_length', 2, 1), {kind: 'unavailable'});
assert.deepEqual(choiceBinding(inactive, 'machine_max_speed_e', 2, 0), {kind: 'unavailable'});
assert.deepEqual(choiceBinding(inactive, 'nozzle_diameter', 2, 1), {kind: 'indexed', index: 2});
assert.equal(inactive.editor_selection.choices.length, 5, 'missing fields do not retarget the selection');
// Dispose test-only inactive drafts so the existing history probes stay independent.
must(call('orc_mutate_preset_draft', ['string'], [JSON.stringify({ history_context: editingContext,
  kind: 'printer', canonical_name: inactiveName, action: 'reset-preset', expected_revision: inactive.revision })]));
const single = must(call('orc_get_preset_draft', ['string','string'], ['printer', 'Bambu Lab X1 Carbon 0.4 nozzle']));
assert.equal(single.editor_selection.nozzles.length, 1, 'browsed single-head topology is independent of active four-head U1');
assert.ok(single.editor_selection.choices.every(c => c.extruder_index === 0));
mutate({action: 'set', key: 'default_nozzle_volume_type', value: 'High Flow,High Flow,Hybrid,Standard'});
const activeDefaults = read();
assert.equal(activeDefaults.editor_selection.nozzles[1].default_choice_id, 'extruder-1-flow-1');
assert.equal(activeDefaults.editor_selection.nozzles[1].initial_choice_id, 'extruder-1-flow-0', 'active source initializes from project actual SF, not the browsed default HF');
mutate({action: 'reset-field', key: 'default_nozzle_volume_type'});

// The sidebar Multi. command and editor must agree after restoring a diameter.
function diameter(value) {
  return must(call('orc_set_toolhead_diameter', ['string'], [JSON.stringify({ history_context: editingContext,
    index: 2, diameter: value, expected_revision: read().revision,
  })]));
}
const diameterChanged = diameter(0.4);
assert.equal(read().modified, true);
assert.ok(diameterChanged.profile_snapshot.modified_presets.printer.includes(printer));
const diameterRestored = diameter(0.6);
assert.equal(read().modified, true, 'writing the source diameter retains its explicit override');
assert.deepEqual(read().overrides.nozzle_diameter, [null, null, {value: 0.6}, null]);
assert.deepEqual(read().editor_vectors.nozzle_diameter.override_values, [null, null, {value: 0.6}, null]);
assert.ok(diameterRestored.profile_snapshot.modified_presets.printer.includes(printer));
restoreContext('orc_history_undo');
assert.equal(read().modified, true);
assert.equal(values('nozzle_diameter')[2], 0.4);
restoreContext('orc_history_redo');
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

// Reset clears only one index even while another explicit equal-value edit remains.
set('min_layer_height', 'float', 0, initialSourceMin());
set('min_layer_height', 'float', 2, 0.15);
mutate({action: 'reset-field', key: 'min_layer_height', index: 2});
assert.deepEqual(read().editor_vectors.min_layer_height.override_values, [{value: 0.08}, null, null, null]);
mutate({action: 'reset-field', key: 'min_layer_height', index: 2});
assert.deepEqual(read().editor_vectors.min_layer_height.override_values, [{value: 0.08}, null, null, null]);
mutate({action: 'reset-field', key: 'min_layer_height', index: 0});
assert.equal(Object.hasOwn(read().overrides, 'min_layer_height'), false);
function initialSourceMin() { return read().editor_vectors.min_layer_height.source_values[0]; }

// Whole vector writes own every valid index, including source-equal elements.
mutate({action: 'set', key: 'nozzle_diameter', value: '0.6'});
assert.deepEqual(values('nozzle_diameter'), [0.6,0.6,0.6,0.6]);
assert.deepEqual(read().editor_vectors.nozzle_diameter.override_values, Array(4).fill({value: 0.6}));
mutate({action: 'reset-field', key: 'nozzle_diameter'});
assert.deepEqual(values('nozzle_diameter'), [0.4,0.4,0.6,0.6]);

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
must(call('orc_history_undo')); // Native history restores indexed drafts.
assert.deepEqual(values('extruder_printable_area')[2], polygon);
must(call('orc_history_redo'));
assert.deepEqual(values('extruder_printable_area'), []);

// A diameter combination matching another canonical profile must publish that
// source and its vectors in the same single-history mutation receipt.
set('nozzle_diameter', 'float', 2, 0.4);
restoreContext('orc_history_undo');
restoreContext('orc_history_redo');
set('nozzle_diameter', 'float', 3, 0.4);
restoreContext('orc_history_undo');
restoreContext('orc_history_redo');
assert.equal(printer, 'Snapmaker U1 (0.4 nozzle)');
assert.deepEqual(values('nozzle_diameter'), [0.4, 0.4, 0.4, 0.4]);

// Variant counts are independent of physical extruder counts; U1 stores SF/HF columns.
assert.equal(initial.editor_vectors.nozzle_diameter.index_count, 4);
assert.equal(initial.editor_vectors.retraction_length.index_count, 8);
assert.equal(initial.editor_vectors.machine_max_speed_e.index_count, 16);
const filament = 'Generic PLA @System';
const readFilament = () => must(call('orc_get_preset_draft', ['string', 'string'], ['filament', filament]));
function filamentMutate(body, accept = true) {
  const result = call('orc_mutate_preset_draft', ['string'], [JSON.stringify({ history_context: editingContext, kind: 'filament', canonical_name: filament,
    expected_revision: readFilament().revision, ...body })]);
  return accept ? must(result) : result;
}
const baseFilament = readFilament();
assert.deepEqual(baseFilament.editor_selection.choices.map(c => c.variant), [
  'Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Extra High Flow',
  'Bowden Standard', 'Bowden High Flow', 'Bowden Extra High Flow',
], 'all native Filament variants remain available, including Bowden and XHF unused by U1');
assert.ok(baseFilament.editor_selection.choices.every(c => c.extruder_index === null));
assert.deepEqual(baseFilament.editor_selection.field_bindings.filament_flow_ratio.bindings,
  Array.from({length: 6}, (_, index) => ({kind: 'indexed', index})));
const fi = baseFilament.editor_vectors.filament_flow_ratio.index_count - 1;
assert.ok(fi > 0, 'native Filament has multiple variants');
filamentMutate({ action: 'set-element', key: 'filament_flow_ratio', scalar_type: 'float', index: 0, value: 1.01 });
filamentMutate({ action: 'set-element', key: 'filament_flow_ratio', scalar_type: 'float', index: fi, value: 1.02 });
filamentMutate({ action: 'set-element', key: 'filament_retraction_length', scalar_type: 'float', index: fi, value: null });
assert.deepEqual(readFilament().editor_vectors.filament_retraction_length.override_values[fi], {value: null}, 'native nil is explicit ownership, distinct from sparse inheritance');
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
assert.deepEqual(basePrint.editor_selection.choices.map(c => [c.extruder_index,c.flow_type]), [[0,0],[1,0],[2,0],[3,0]],
  'Print choices follow actual project SF flow, independent of available Printer editing HF');
assert.deepEqual(choiceBinding(basePrint, 'outer_wall_speed', 2, 0), {kind: 'indexed', index: 4});
assert.deepEqual(basePrint.editor_selection.field_bindings.layer_height, {kind: 'shared'});
const pi = basePrint.editor_vectors.outer_wall_speed.index_count - 1;
assert.ok(pi > 0, 'Print preserves all variant columns');
// Whole serialized values remain a distinct operation; element writes expand a short vector using its fallback.
printMutate({operation: 'set-element', key: 'outer_wall_speed', scalar_type: 'float', index: pi,
  value: basePrint.editor_vectors.outer_wall_speed.source_values[pi]});
assert.deepEqual(readPrint().editor_vectors.outer_wall_speed.override_values[pi], {value: basePrint.editor_vectors.outer_wall_speed.source_values[pi]}, 'equal Print writes materialize explicit ownership');
must(call('orc_history_undo'));
assert.equal(readPrint().editor_vectors.outer_wall_speed.override_values[pi], null);
must(call('orc_history_redo'));
assert.deepEqual(readPrint().editor_vectors.outer_wall_speed.override_values[pi], {value: basePrint.editor_vectors.outer_wall_speed.source_values[pi]});
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
assert.equal(readPrint().editor_vectors.outer_wall_speed.override_values[pi], null);
assert.deepEqual(readPrint().editor_vectors.outer_wall_speed.override_values[0], {value: 100});
assert.equal(readPrint().editor_vectors.outer_wall_speed.effective_values[0], 100);
assert.equal(readPrint().editor_vectors.outer_wall_speed.effective_values[pi], basePrint.editor_vectors.outer_wall_speed.source_values[pi]);
must(call('orc_history_undo'));
assert.equal(readPrint().editor_vectors.outer_wall_speed.effective_values[pi], 175);
must(call('orc_history_redo'));
assert.equal(readPrint().editor_vectors.outer_wall_speed.effective_values[pi], basePrint.editor_vectors.outer_wall_speed.source_values[pi]);
// Load actual project HF/Hybrid context through Orca's standard 3MF reader,
// rather than a production test hook or a mock of the mapping function.
const exported = must(call('orc_export_project'));
const archiveBytes = Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + Number(exported.bytes_length));
Module._free(Number(exported.bytes_ptr));
const settingsName = 'Metadata/project_settings.config';
const settingsEntry = readZipEntries(archiveBytes).find(entry => entry.name === settingsName);
assert.ok(settingsEntry);
const settings = JSON.parse(new TextDecoder().decode(settingsEntry.content));
settings.nozzle_volume_type = ['Standard', 'High Flow', 'Hybrid', 'Standard'];
settings.extruder_max_nozzle_count = ['1','1','2','1'];
const hybridArchive = replaceEntry(archiveBytes, settingsName, JSON.stringify(settings));
const archivePointer = Number(Module._malloc(hybridArchive.length));
Module.HEAPU8.set(hybridArchive, archivePointer);
try { must(call('orc_load_project', ['pointer','number','number','string'], [archivePointer, hybridArchive.length, 0, 'U1-Hybrid-mapping.3mf'])); }
finally { Module._free(archivePointer); }
const loadedProfile = must(call('orc_get_preset_snapshot'));
printer = loadedProfile.printer.name;
const hybridPrinter = read();
assert.deepEqual(hybridPrinter.editor_selection.nozzles.map(n => n.initial_choice_id),
  ['extruder-0-flow-0','extruder-1-flow-1','extruder-2-flow-0','extruder-3-flow-0'], 'actual Hybrid project flow initializes Printer as SF');
assert.equal(hybridPrinter.editor_selection.choices.length, 8, 'project Hybrid does not add an editor parameter group');
const hybridPrint = readPrint();
assert.deepEqual(hybridPrint.editor_selection.choices.map(c => [c.extruder_index,c.flow_type]),
  [[0,0],[1,1],[2,0],[2,1],[3,0]], 'Print follows actual HF/Hybrid project context');
assert.deepEqual(choiceBinding(hybridPrint, 'outer_wall_speed', 2, 0), {kind: 'indexed', index: 4});
assert.deepEqual(choiceBinding(hybridPrint, 'outer_wall_speed', 2, 1), {kind: 'indexed', index: 5});
assert.deepEqual(choiceBinding(hybridPrinter, 'machine_max_speed_e', 2, 1), {kind: 'indexed', index: 10});
assert.deepEqual(readFilament().editor_selection.choices.map(c => c.variant), baseFilament.editor_selection.choices.map(c => c.variant),
  'Filament choices do not depend on project HF/Hybrid context');
console.log('PASS native selections/defaults, physical/variant/stride-2 mappings, missing mappings, short vectors, full Filament variants, project HF/Hybrid context, typed edits/reset/history');
process.exit(0);
