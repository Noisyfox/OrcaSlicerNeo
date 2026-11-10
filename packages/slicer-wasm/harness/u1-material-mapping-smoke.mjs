import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages, fixtureProfileOptions } from './profile-installer.mjs';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';

const Module = await (await loadModuleFactory(process.argv[2]))({ noInitialRun: true, print: () => {}, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
const call = (name, types = [], args = []) => {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
};
const command = (name, value) => call(name, ['string'], [JSON.stringify(value)]);
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const projection = id => call('orc_get_nozzle_mapping', ['string'], [id]);
const currentPlate = () => ok(call('orc_get_plate_session_snapshot')).current_plate_id;
const select = printer => ok(call('orc_select_preset', ['string', 'string'], ['printer', printer]));
const u1 = 'Snapmaker U1 (0.4 nozzle)';
const h2d = 'Bambu Lab H2D 0.4 nozzle';
ok(call('orc_init', ['string'], [fixtureProfileOptions(Module)]));
assert.notEqual(ok(call('orc_get_preset_snapshot')).printer.name, u1,
  'startup must create the first Plate before restoring the remembered U1');
select(u1);
assert.equal(ok(projection(currentPlate())).effective.mode, 2, 'bootstrap restoration initializes Manual');
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'startup mapping']));
const sliceSettings = { enable_prime_tower: false, layer_height: 0.3, initial_layer_print_height: 0.3, sparse_infill_density: '5%' };
async function sliceCurrent() {
  const id = currentPlate();
  return ok(await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number', 'string'],
    [JSON.stringify(sliceSettings), id, ok(projection(id)).revision, 'null']));
}
await sliceCurrent();

// New Project closes the old project before restoring the system Printer.
// Cover both a U1 project and an H2D project returning to the remembered U1.
for (const previousPrinter of [u1, h2d]) {
  select(previousPrinter);
  ok(call('orc_close_project'));
  select(u1);
  assert.equal(ok(projection(currentPlate())).effective.mode, 2, `New Project from ${previousPrinter}`);
  ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'new project mapping']));
  await sliceCurrent();
}
ok(call('orc_close_project'));
ok(call('orc_add_plate'));
assert.equal(ok(projection(currentPlate())).effective.mode, 2, 'new U1 Plates initialize Manual');
ok(call('orc_close_project'));
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
async function slice(head) {
  const sliced = ok(await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number', 'string'],
    [JSON.stringify(sliceSettings), plateId, ok(projection(plateId)).revision, 'null']));
  const output = ok(exportGcode(call, { receipt: sliced.receipt, filenameBase: '' }));
  const gcode = Module.FS.readFile(output.path, { encoding: 'utf8' });
  assert.match(gcode, /^T5\s*$/m, 'U1 emits logical filament ID, not mapped physical head');
  const native = ok(call('orc_test_nozzle_mapping_slice', ['string'], [plateId]));
  assert.equal(native.filamentMap[5], head);
  const manifest = ok(command('orc_describe_print_plate', { receipt: { ...sliced.receipt, result_generation: Number(sliced.receipt.result_generation) }, filename_base: '' })).manifest;
  assert.equal(manifest.materials[0].index, 5);
  assert.equal(manifest.materials[0].toolIndex, head - 1);
  assert.equal(manifest.materials.length, 1);
  assert.equal(manifest.materials[0].nozzleTemperature, native.nozzle_temperature[5]);
  assert.ok(manifest.materials[0].initialLayerNozzleTemperature > 0);
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
// Imported missing/Default modes use U1 capabilities even when the project
// fallback is Auto. Explicit modes (including unavailable Auto) stay saved.
for (const mode of [null, 'Default', 'Auto For Flush', 'Auto For Match', 'Manual', 'Nozzle Manual']) {
  const replacement = entries.map(entry => {
    if (entry.name === 'Metadata/project_settings.config') {
      const project = JSON.parse(new TextDecoder().decode(entry.content));
      project.filament_map_mode = 'Auto For Flush';
      return { ...entry, content: new TextEncoder().encode(JSON.stringify(project)) };
    }
    if (entry.name !== 'Metadata/model_settings.config') return entry;
    const xml = new TextDecoder().decode(entry.content)
      .replace(/\s*<metadata key="filament_map_mode" value="[^"]*"\s*\/>/g,
        mode === null ? '' : `\n    <metadata key="filament_map_mode" value="${mode}"/>`)
      .replace(/\s*<metadata key="filament_(?:maps|volume_maps)" value="[^"]*"\s*\/>/g, '');
    return { ...entry, content: new TextEncoder().encode(xml) };
  });
  const archive = writeStoredZip(replacement);
  select(h2d); // Import must use the incoming U1, not the previous Printer.
  const pointer = Number(Module._malloc(archive.length));
  Module.HEAPU8.set(archive, pointer);
  try { ok(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [pointer, archive.length, 0, 'u1-mode.3mf'])); }
  finally { Module._free(pointer); }
  assert.equal(ok(call('orc_get_preset_snapshot')).printer.name, u1);
  const imported = ok(projection(currentPlate()));
  const expected = mode === null || mode === 'Default' ? 2
    : ['Auto For Flush', 'Auto For Match', 'Manual', 'Nozzle Manual'].indexOf(mode);
  assert.equal(imported.saved.mode, expected, `imported ${mode}`);
  assert.equal(imported.effective.mode, expected);
  assert.equal(imported.saved.filamentMap, null, 'import keeps project fallback maps sparse');
  assert.equal(imported.saved.volumeMap, null);
  if (expected >= 2) await sliceCurrent();
  else {
    assert.equal(imported.modes[expected].available, false);
    const rejected = await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number', 'string'],
      [JSON.stringify(sliceSettings), currentPlate(), imported.revision, 'null']);
    assert.match(rejected.error, /unavailable for this printer topology/);
    assert.equal(ok(projection(currentPlate())).saved.mode, expected, 'slice admission must not rewrite explicit modes');
  }
}
console.log('PASS U1 startup/New Project, independent 1-64 materials, logical T5 slicing and capability-based import modes');
Module.PThread?.terminateAllThreads?.();
process.exit(0);
