import { extrudingTools } from './nozzle-mapping-gcode.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createNozzleMappingFixture } from './nozzle-mapping-fixtures.mjs';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';
const { Module, call, command, ok, context, projection, configure, observe } = await createNozzleMappingFixture(process.argv[2]);
ok(call('orc_clear_model'));
for (let slot = 1; slot <= 2; slot++) ok(command('orc_select_filament_slot_preset', {
  version: 1, revision: call('orc_history_status').revision, slot, preset: 'Generic PLA @BBL H2D',
}));
const plate = () => ok(call('orc_get_plate_session_snapshot')).current_plate_id;
const first = plate();
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'first plate cube']));
const second = ok(call('orc_add_plate')).current_plate_id;
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'second plate cube']));
configure({ plate_settings: {
  [first]: { filament_map_mode: 'Manual', filament_map: '1,1', filament_volume_map: '0,0' },
  [second]: { filament_map_mode: 'Manual', filament_map: '2,1', filament_volume_map: '0,0' },
}, mapping_project_settings: { extruder_ams_count: '1#3;1#2' } });
command('orc_history_reset', context);
const inputs = () => ({ inputs: observe().mappingInputs, plates: [ok(projection(first)).saved, ok(projection(second)).saved] });
const settings = { enable_prime_tower: false, layer_height: 0.3, initial_layer_print_height: 0.3, sparse_infill_density: '5%' };
async function slice(id, label) {
  const before = inputs();
  const result = await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'],
    [JSON.stringify(settings), id, ok(projection(id)).revision]);
  ok(result);
  const exported = ok(exportGcode(call, { receipt: result.receipt, filenameBase: '' }));
  const gcode = Module.FS.readFile(exported.path, { encoding: 'utf8' });
  writeFileSync(`/tmp/neo-nozzle-${label}.gcode`, gcode);
  const native = ok(call('orc_test_nozzle_mapping_slice', ['string'], [id]));
  assert.deepEqual(inputs(), before, 'slicing leaves editable mapping/capacity inputs unchanged');
  console.log(label, JSON.stringify(native));
  return { native, gcode };
}
const one = await slice(first, 'first');
const two = await slice(second, 'second');
assert.equal(one.native.filamentMap[0], 1);
assert.equal(two.native.filamentMap[0], 2);
assert.deepEqual(two.native.capacity, ['1#3', '1#2']);
console.log('PASS Plate-local manual mapping reaches native Print and exported G-code');
assert.deepEqual(extrudingTools(one.gcode), [0], 'first Plate deposits with nozzle 1');
assert.deepEqual(extrudingTools(two.gcode), [1], 'second Plate deposits with nozzle 2');
configure({ plate_settings: { [second]: { filament_map_mode: 'Nozzle Manual', filament_nozzle_map: '1,0' } } });
const nozzleManual = await slice(second, 'nozzle-manual');
assert.equal(ok(projection(second)).saved.mode, 3);
assert.deepEqual(extrudingTools(nozzleManual.gcode), [1]);
configure({ plate_settings: { [second]: { filament_map_mode: 'Manual' } } });
const mutate = (id, change) => ok(command('orc_mutate_nozzle_mapping', { plateId: id,
  revision: call('orc_history_status').revision, plateRevision: ok(projection(id)).revision, history_context: context, change }));
ok(command('orc_mutate_preset_draft', { kind: 'filament', canonical_name: 'Generic PLA @BBL H2D',
  expected_revision: call('orc_history_status').revision, history_context: context,
  action: 'set-element', key: 'nozzle_temperature', scalar_type: 'int', index: 1, value: 235 }));
ok(command('orc_set_project_flow', { index: 1, flow: 1, expected_revision: call('orc_history_status').revision, history_context: context }));
const firstVariant = await slice(first, 'first-variant');
const secondVariant = await slice(second, 'second-variant');
assert.equal(firstVariant.native.nozzle_temperature[0], 220);
assert.equal(secondVariant.native.nozzle_temperature[0], 235, 'Plate mapping chooses the matching native flow variant');
mutate(second, { kind: 'mode', mode: 0 });
await slice(second, 'automatic');
mutate(second, { kind: 'mode', mode: 2 });
assert.deepEqual(ok(projection(second)).effective.filamentMap, [2, 1], 'automatic result never overwrites manual intent');
configure({ plate_settings: { [second]: { filament_map_mode: 'Auto For Match' } } });
const rejected = await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'],
  [JSON.stringify(settings), second, ok(projection(second)).revision]);
assert.match(rejected.error, /synchronization is unavailable/);
assert.equal(ok(projection(second)).saved.mode, 1);
mutate(second, { kind: 'mode', mode: 2 });
// Leave preset UI restrictions unchanged; this is deliberately a synthetic native topology.
ok(command('orc_select_printer_with_remembered_rack', { printer: 'MyKlipper 0.4 nozzle',
  remembered_rack: null, remembered_bed_type: null, history_context: context }));
await slice(first, 'single');
ok(command('orc_mutate_preset_draft', { kind: 'printer', canonical_name: 'MyKlipper 0.4 nozzle',
  expected_revision: call('orc_history_status').revision, history_context: context, action: 'set', key: 'single_extruder_multi_material', value: '0' }));
ok(command('orc_mutate_preset_draft', { kind: 'printer', canonical_name: 'MyKlipper 0.4 nozzle',
  expected_revision: call('orc_history_status').revision, history_context: context, action: 'set', key: 'extruders_count', value: '3' }));
await slice(first, 'fixed-three');
configure({ printer_settings: { nozzle_count: 3, semm: true } });
const unsupported = await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'],
  [JSON.stringify(settings), first, ok(projection(first)).revision]);
assert.match(unsupported.error, /Automatic filament saving is unavailable/);
mutate(first, { kind: 'mode', mode: 2 });
// A generic machine must define its firmware's physical-tool convention.
// This synthetic Klipper preset uses manual material loading and native
// physical-extruder placeholders; no Bambu command or provider is involved.
for (const [key, value] of Object.entries({
  manual_filament_change: '1',
  machine_start_gcode: 'G28\nACTIVATE_EXTRUDER EXTRUDER=extruder{current_extruder_id}\n',
  change_filament_gcode: 'ACTIVATE_EXTRUDER EXTRUDER=extruder{next_extruder_id}\n',
})) ok(command('orc_mutate_preset_draft', { kind: 'printer', canonical_name: 'MyKlipper 0.4 nozzle',
  expected_revision: call('orc_history_status').revision, history_context: context, action: 'set', key, value }));
mutate(first, { kind: 'mapping', filamentMap: [3, 1, 1] });
const generic = await slice(first, 'generic-three');
assert.equal(generic.native.filamentMap[0], 3);
assert.deepEqual(extrudingTools(generic.gcode), [2], 'generic manual mapping deposits with nozzle 3');
console.log('PASS native actual extrusion tools, automatic input isolation, unavailable modes and generic three-head manual mapping');
