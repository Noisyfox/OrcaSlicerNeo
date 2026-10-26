import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createNozzleMappingFixture } from './nozzle-mapping-fixtures.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { callAsyncTask } from './async-task-mailbox.mjs';
const { Module, call, command, ok, context, projection, configure } = await createNozzleMappingFixture(process.argv[2]);
const printer = 'Bambu Lab H2D 0.4 nozzle';
const configureMemory = (memory, initializeNewProject = false) => command('orc_configure_nozzle_capacity_memory', { memory, initializeNewProject });
ok(configureMemory({ [printer]: [9, 7], 'MyKlipper 0.4 nozzle': [4] }));
for (const memory of [{ [printer]: [0] }, { [printer]: [1.5] }, { [printer]: [2147483648] }]) assert.equal(configureMemory(memory).ok, false);
ok(call('orc_clear_model'));
ok(configureMemory({ [printer]: [9, 7], 'MyKlipper 0.4 nozzle': [4] }, true));
const current = () => ok(call('orc_get_plate_session_snapshot')).current_plate_id;
let first = current();
assert.deepEqual(ok(projection(first)).nozzles.map(n => n.capacity), [9, 7]);
for (let slot = 1; slot <= 2; slot++) ok(command('orc_select_filament_slot_preset', {
  version: 1, revision: call('orc_history_status').revision, slot, preset: 'Generic PLA @BBL H2D',
}));
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'first']));
let second = ok(call('orc_add_plate')).current_plate_id;
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'second']));
configure({ plate_settings: {
  [first]: { filament_map_mode: 'Manual', filament_map: '1,1', filament_volume_map: '0,0' },
  [second]: { filament_map_mode: 'Nozzle Manual', filament_map: '2,1', filament_volume_map: '0,0' },
}, mapping_project_settings: { extruder_ams_count: '4#2|1#1;4#1', filament_nozzle_map: '1,0' } });
command('orc_history_reset', context);
const expected = [ok(projection(first)).saved, ok(projection(second)).saved];
function save() {
  const saved = ok(command('orc_export_project', {}));
  const bytes = Module.HEAPU8.slice(saved.bytes_ptr, saved.bytes_ptr + saved.bytes_length);
  Module._free(saved.bytes_ptr);
  return bytes;
}
function load(bytes, geometry = false) {
  const ptr = Number(Module._malloc(bytes.length)); Module.HEAPU8.set(bytes, ptr);
  try { return ok(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, bytes.length, geometry ? 1 : 0, 'mapping.3mf'])); }
  finally { Module._free(ptr); }
}
function plates() { return ok(call('orc_get_plate_session_snapshot')).plates.map(p => p.plate_id); }
const archive = save();
writeFileSync('/tmp/neo-nozzle-mapping.3mf', archive);
const entries = readZipEntries(archive);
const text = name => new TextDecoder().decode(entries.find(e => e.name === name).content);
assert.equal(entries.some(e => /orca_neo_/.test(e.name)), false);
assert.deepEqual(JSON.parse(text('Metadata/project_settings.config')).extruder_ams_count, ['4#2|1#1', '4#1']);
assert.deepEqual(JSON.parse(text('Metadata/project_settings.config')).filament_nozzle_map.map(Number), [1, 0]);
// Plate-local nozzle assignments may exist in memory, but only Orca's existing
// Plate fields are serialized. Project fallback retains Nozzle Manual semantics.
configure({ plate_settings: { [first]: { filament_nozzle_map: '0,1' } } });
const localTipsArchive = save();
const withLocalTips = readZipEntries(localTipsArchive);
assert.doesNotMatch(new TextDecoder().decode(withLocalTips.find(e => e.name === 'Metadata/model_settings.config').content), /filament_nozzle_map/);
// Optional independent desktop Orca comparison of the existing capacity field.
if (process.argv[3]) {
  execFileSync(process.argv[3], ['--datadir', '/tmp/neo-nozzle-orca-data', '--allow-newer-file',
    '--export-3mf', '/tmp/neo-nozzle-orca-roundtrip.3mf', '/tmp/neo-nozzle-mapping.3mf'], { timeout: 120000 });
  const roundtrip = readZipEntries(readFileSync('/tmp/neo-nozzle-orca-roundtrip.3mf'));
  const config = JSON.parse(new TextDecoder().decode(roundtrip.find(e => e.name === 'Metadata/project_settings.config').content));
  const totals = config.extruder_ams_count.map(head => head.split('|').reduce((sum, group) => {
    const [width, count] = group.split('#').map(Number); return sum + width * count;
  }, 0));
  assert.deepEqual(totals, [9, 4]);
  console.log('PASS independent native Orca read/save capacity comparison');
}

load(localTipsArchive);
[first, second] = plates();
assert.deepEqual([ok(projection(first)).saved, ok(projection(second)).saved], expected);
assert.equal(ok(projection(second)).saved.nozzleMap, null);
assert.deepEqual(ok(projection(second)).effective.nozzleMap, [1, 0]);
assert.deepEqual(ok(projection(first)).nozzles.map(n => n.capacity), [9, 4], 'project capacities take precedence over memory');
assert.deepEqual(ok(call('orc_test_nozzle_mapping_published')).capacity, [9, 4], 'native published policy excludes incoming capacities');
const sliceSettings = JSON.stringify({ enable_prime_tower: false, layer_height: 0.3, initial_layer_print_height: 0.3, sparse_infill_density: '5%' });
for (const [id, target] of [[first, 1], [second, 2]]) {
  ok(await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'], [sliceSettings, id, ok(projection(id)).revision]));
  assert.equal(ok(call('orc_test_nozzle_mapping_slice', ['string'], [id])).filamentMap[0], target);
}
const switchTo = name => ok(command('orc_select_printer_with_remembered_rack', {
  printer: name, remembered_rack: null, remembered_bed_type: null, history_context: context,
}));
switchTo('MyKlipper 0.4 nozzle');
assert.deepEqual(ok(projection(first)).nozzles.map(n => n.capacity), [4]);
ok(call('orc_history_undo'));
assert.deepEqual(ok(projection(first)).nozzles.map(n => n.capacity), [9, 4]);
ok(call('orc_history_redo'));
switchTo(printer);
assert.deepEqual(ok(projection(first)).nozzles.map(n => n.capacity), [9, 7]);
load(archive, true);
assert.deepEqual(ok(projection(first)).nozzles.map(n => n.capacity), [9, 7], 'geometry-only import excludes archive capacities');
// Native standard fields, including missing and Default, retain local absence of maps.
for (const mode of [null, 4, 0, 1, 2, 3]) {
  const replacement = readZipEntries(archive).map(e => {
    if (e.name !== 'Metadata/model_settings.config') return e;
    let xml = new TextDecoder().decode(e.content).replace(/\s*<metadata key="filament_map_mode" value="[^"]*"\s*\/>/g, mode === null ? '' : '\n    <metadata key="filament_map_mode" value="' + ['Auto For Flush', 'Auto For Match', 'Manual', 'Nozzle Manual', 'Default'][mode] + '"/>')
      .replace(/\s*<metadata key="filament_(?:maps|volume_maps)" value="[^"]*"\s*\/>/g, '');
    return { ...e, content: new TextEncoder().encode(xml) };
  });
  load(writeStoredZip(replacement));
  const saved = ok(projection(plates()[0])).saved;
  assert.equal(saved.mode, mode === null || mode === 4 ? 0 : mode);
  assert.equal(saved.filamentMap, null, 'import must not expand global fallback into Plate');
}
const withoutCapacity = entries.map(entry => {
  if (entry.name !== 'Metadata/project_settings.config') return entry;
  const project = JSON.parse(new TextDecoder().decode(entry.content));
  delete project.extruder_ams_count;
  return { ...entry, content: new TextEncoder().encode(JSON.stringify(project)) };
});
load(writeStoredZip(withoutCapacity));
assert.deepEqual(ok(projection(plates()[0])).nozzles.map(n => n.capacity), [1, 1],
  'missing project capacity must not inherit memory or the previous native bundle member');
load(archive);
[first, second] = plates();
configure({ plate_settings: { [second]: { filament_map_mode: 'Auto For Flush' } } });
const retained = ok(projection(second)).saved;
ok(await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'], [sliceSettings, second, ok(projection(second)).revision]));
load(save());
assert.deepEqual(ok(projection(plates()[1])).saved, retained, 'automatic result does not replace manual intent in archive');
console.log('PASS native mapping persistence: standard fields, local maps, modes, capacity precedence, preset memory, Undo, published/geometry exclusions and reslicing');
Module.PThread?.terminateAllThreads?.();
