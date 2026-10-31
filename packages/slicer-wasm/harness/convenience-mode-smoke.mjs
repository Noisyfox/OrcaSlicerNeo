import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createNozzleMappingFixture } from './nozzle-mapping-fixtures.mjs';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';
import { extrudingTools } from './nozzle-mapping-gcode.mjs';

const { Module, call, command, ok, context, projection, configure, observe } = await createNozzleMappingFixture(process.argv[2]);
ok(call('orc_clear_model'));
ok(command('orc_select_filament_slot_preset', { version: 1, revision: call('orc_history_status').revision,
  slot: 1, preset: 'Generic PLA @BBL H2D' }));
ok(command('orc_set_filament_slot_colour', { version: 1, revision: call('orc_history_status').revision,
  slot: 1, colour: { kind: 'solid', color: '#FF0000' } }));
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'match cube']));
let plate = ok(call('orc_get_plate_session_snapshot')).current_plate_id;
// Make physical-extruder placeholders directly observable. Bambu's normal T
// command selects logical filament IDs and is not a physical-tool oracle.
for (const [key, value] of Object.entries({ machine_start_gcode: 'G28\nT{current_extruder_id}\n',
  change_filament_gcode: 'T{current_extruder_id}\n' }))
  ok(command('orc_mutate_preset_draft', { kind: 'printer', canonical_name: 'Bambu Lab H2D 0.4 nozzle',
    expected_revision: call('orc_history_status').revision, history_context: context,
    action: 'set', key, value }));
configure({ plate_settings: { [plate]: { filament_map_mode: 'Auto For Match', filament_map: '1,1', filament_volume_map: '0,0' } } });
command('orc_history_reset', context);
const identity = { manufacturer: 'Bambu Lab', model: 'H2D', externalRefs: [{ namespace: 'orca-printer-model', value: 'O1D' }] };
const supply = (toolIndex, colour, external = false) => ({ toolIndex, slotId: `opaque/${external ? 'external' : 'feeder'}/${toolIndex}`,
  external, materialType: 'PLA', colour, catalogRefs: [] });
const source = materials => ({ identity, toolCount: 2, materials });
const set = value => ok(command('orc_set_device_material_context', value));
const inputs = () => ({ maps: observe().mappingInputs, history: call('orc_history_status'), saved: ok(projection(plate)).saved });
const baseline = inputs();
set({ ...source([]), toolCount: 0 });
assert.equal(ok(projection(plate)).modes[1].available, true, 'selected identity suffices before inventory acquisition');
set({ ...source([]), identity: { manufacturer: 'Bambu Lab', model: 'P1S', externalRefs: [{ namespace: 'orca-printer-model', value: 'C12' }] } });
assert.equal(ok(projection(plate)).modes[1].available, false, 'a different selected model withdraws availability');
assert.deepEqual(inputs(), baseline, 'unavailable saved Match is retained without normalization');
set(source([supply(0, '#0000FF'), supply(1, '#FF0000')]));
assert.equal(ok(projection(plate)).modes[1].available, true, 'model selection suffices without importing materials');
assert.deepEqual(inputs(), baseline, 'device list is outside project/history inputs');
assert.equal(command('orc_set_device_material_context', source([{ ...supply(0, '#FF0000'), toolIndex: 3 }])).ok, false);
assert.equal(ok(projection(plate)).modes[1].available, true, 'invalid publication leaves the previous context intact');
async function slice(expected, sequence = 'by layer') {
  const before = inputs();
  const result = ok(await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'],
    [JSON.stringify({ enable_prime_tower: false, layer_height: 0.3, initial_layer_print_height: 0.3, sparse_infill_density: '5%', print_sequence: sequence }), plate, ok(projection(plate)).revision]));
  const exported = ok(exportGcode(call, { receipt: result.receipt, filenameBase: '' }));
  const gcode = Module.FS.readFile(exported.path, { encoding: 'utf8' });
  writeFileSync('/tmp/neo-convenience.gcode', gcode);
  const native = ok(call('orc_test_nozzle_mapping_slice', ['string'], [plate]));
  if (expected !== undefined) {
    assert.equal(native.filamentMap[0], expected + 1);
    assert.deepEqual(extrudingTools(gcode), [expected]);
  }
  assert.deepEqual(inputs(), before, 'automatic slices preserve saved mode, maps, input stamps and history');
  return native;
}
await slice(1);
set(source([supply(0, '#FF0000'), supply(1, '#0000FF')]));
await slice(0); // Same model, Plate revision and Print; only the device colors changed.
set(source([supply(0, '#0000FF'), supply(1, '#FF0000')]));
await slice(1);
set(source([supply(0, '#0000FF'), supply(1, '#FF0000')].map(s => ({ ...s, materialType: 'Unreported family' }))));
await slice(1); // Native type relaxation still prefers the closest device color.
await slice(1, 'by object');
set(source([supply(0, '#FF0000'), supply(1, '#0000FF')]));
await slice(0, 'by object');
set(source([supply(0, '#0000FF'), supply(1, '#FF0000')]));
await slice(1, 'by object');
set(source([supply(0, '#FF0000', true), supply(1, '#0000FF', true)]));
await slice(0);
set(source([]));
await slice(); // Empty candidates use native Flush fallback, retaining saved Match.
assert.equal(ok(projection(plate)).saved.mode, 1);
set(null);
assert.equal(ok(projection(plate)).modes[1].available, false);
const rejected = await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'], ['{}', plate, ok(projection(plate)).revision]);
assert.match(rejected.error, /Select a device/);
assert.deepEqual(inputs(), baseline);
set(source([supply(0, '#0000FF'), supply(1, '#FF0000')]));
ok(command('orc_mutate_preset_draft', { kind: 'printer', canonical_name: 'Bambu Lab H2D 0.4 nozzle',
  expected_revision: call('orc_history_status').revision, history_context: context,
  action: 'set-element', key: 'nozzle_diameter', scalar_type: 'float', index: 1, value: 0.6 }));
ok(command('orc_set_project_flow', { index: 1, flow: 1, expected_revision: call('orc_history_status').revision, history_context: context }));
assert.equal(ok(projection(plate)).modes[1].available, true, 'mixed diameters/flows do not add a product gate');
await slice(1);
const saved = ok(command('orc_export_project', {}));
const archive = Module.HEAPU8.slice(saved.bytes_ptr, saved.bytes_ptr + saved.bytes_length);
Module._free(saved.bytes_ptr);
writeFileSync('/tmp/neo-convenience.3mf', archive);
set(null);
const ptr = Number(Module._malloc(archive.length)); Module.HEAPU8.set(archive, ptr);
try { ok(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, archive.length, 0, 'convenience.3mf'])); }
finally { Module._free(ptr); }
plate = ok(call('orc_get_plate_session_snapshot')).current_plate_id;
assert.equal(ok(projection(plate)).saved.mode, 1, 'saved Match survives reopen without a device');
assert.deepEqual(ok(projection(plate)).saved.filamentMap, [1, 1], 'archive retains manual input rather than automatic result');
assert.equal(ok(projection(plate)).modes[1].available, false);
set(source([supply(0, '#FF0000'), supply(1, '#0000FF')]));
await slice(0); // Reopened project derives a new result from the current source.
console.log('PASS Convenience native grouping, reused-Print invalidation, external supply, empty fallback and input/history isolation');
Module.PThread?.terminateAllThreads?.();
