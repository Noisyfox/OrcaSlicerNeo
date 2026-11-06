import assert from 'node:assert/strict';
import { createNozzleMappingFixture } from './nozzle-mapping-fixtures.mjs';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';
import { readZipEntries } from './native-3mf-parser.mjs';

const { Module, call, command, ok, context, projection } = await createNozzleMappingFixture(process.argv[2]);
ok(call('orc_clear_model'));
ok(command('orc_select_printer_with_remembered_rack', { printer: 'Snapmaker U1 (0.4 nozzle)',
  remembered_rack: null, remembered_bed_type: null, history_context: context }));
let rack = ok(call('orc_get_filament_session_snapshot'));
assert.equal(rack.capabilities.flexible, true);
assert.equal(rack.capabilities.min_slots, 1);
assert.equal(rack.capabilities.nozzle_count, 4);
const mutate = (name, fields = {}) => {
  const result = ok(command(name, { version: 1, revision: rack.revisions.session, ...fields }));
  rack = result.result.snapshot;
  return result;
};
console.log('U1 rack boundaries');
while (rack.slots.length > 1) mutate('orc_delete_filament_slot', { slot: rack.slots.length });
assert.equal(rack.capabilities.can_delete, false);
mutate('orc_select_filament_slot_preset', { slot: 1, preset: 'Generic PLA @U1 0.4 nozzle' });
while (rack.slots.length < 64) mutate('orc_add_filament_slot');
assert.equal(rack.capabilities.can_add, false);
assert.equal(command('orc_add_filament_slot', { version: 1, revision: rack.revisions.session }).ok, false);
while (rack.slots.length > 6) mutate('orc_delete_filament_slot', { slot: rack.slots.length });
for (let slot = 1; slot <= 6; slot++) mutate('orc_select_filament_slot_preset', { slot, preset: 'Generic PLA @U1 0.4 nozzle' });
const plateId = ok(call('orc_get_plate_session_snapshot')).current_plate_id;
let mapping = ok(projection(plateId));
assert.equal(mapping.eligible, true);
assert.equal(mapping.effective.mode, 2);
assert.equal(mapping.modes[0].available, false);
assert.equal(mapping.modes[1].available, false);
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'logical filament six']));
rack = ok(call('orc_get_filament_session_snapshot'));
const object = ok(call('orc_get_model_structure')).objects[0];
mutate('orc_assign_filament', { slot: 6, targets: [{ kind: 'object', id: object.id }] });
function map(head) {
  return ok(command('orc_mutate_nozzle_mapping', { plateId,
    revision: call('orc_history_status').revision, plateRevision: ok(projection(plateId)).revision,
    history_context: context, change: { kind: 'mapping', mode: 2, filamentMap: [1, 1, 1, 1, 1, head] } }));
}
console.log('U1 slicing');
map(3);
const settings = { enable_prime_tower: false, layer_height: 0.3, initial_layer_print_height: 0.3, sparse_infill_density: '5%' };
async function slice(head) {
  const sliced = ok(await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'],
    [JSON.stringify(settings), plateId, ok(projection(plateId)).revision]));
  const output = ok(exportGcode(call, { receipt: sliced.receipt, filenameBase: '' }));
  const gcode = Module.FS.readFile(output.path, { encoding: 'utf8' });
  assert.match(gcode, /^T5\s*$/m, 'U1 emits logical filament ID, not mapped physical head');
  const native = ok(call('orc_test_nozzle_mapping_slice', ['string'], [plateId]));
  assert.equal(native.filamentMap[5], head);
  const manifest = ok(command('orc_describe_print_plate', { receipt: { ...sliced.receipt, result_generation: Number(sliced.receipt.result_generation) }, filename_base: '' })).manifest;
  assert.equal(manifest.materials[0].index, 5);
  assert.equal(manifest.materials[0].toolIndex, head - 1);
  assert.equal(manifest.materials.length, 1);
  return sliced.receipt;
}
const previousReceipt = await slice(3);
map(1);
assert.equal(command('orc_describe_print_plate', { receipt: { ...previousReceipt, result_generation: Number(previousReceipt.result_generation) }, filename_base: '' }).ok, false, 'mapping edits invalidate retained slice');
ok(call('orc_history_undo'));
assert.equal(ok(projection(plateId)).effective.filamentMap[5], 3);
ok(call('orc_history_redo'));
assert.equal(ok(projection(plateId)).effective.filamentMap[5], 1);
await slice(1);
const exported = ok(command('orc_export_project', {}));
const bytes = Module.HEAPU8.slice(exported.bytes_ptr, exported.bytes_ptr + exported.bytes_length);
Module._free(exported.bytes_ptr);
const entries = readZipEntries(bytes);
const config = JSON.parse(new TextDecoder().decode(entries.find(e => e.name === 'Metadata/project_settings.config').content));
assert.equal(Number(config.single_extruder_multi_material), 0, 'independent materials never enable SEMM');
assert.equal(config.filament_colour.length, 6);
const ptr = Number(Module._malloc(bytes.length));
Module.HEAPU8.set(bytes, ptr);
try { ok(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, bytes.length, 0, 'u1.3mf'])); }
finally { Module._free(ptr); }
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots.length, 6);
assert.deepEqual(ok(projection(ok(call('orc_get_plate_session_snapshot')).current_plate_id)).effective.filamentMap, [1, 1, 1, 1, 1, 1]);
console.log('PASS U1 independent 1-64 materials, manual mapping, logical T5 slicing and project roundtrip');
process.exit(0);
