import assert from 'node:assert/strict';
import { createNozzleMappingFixture } from './nozzle-mapping-fixtures.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: nozzle-mapping-projection-smoke.mjs <orca_slice.js>');
const { call, command, ok, context, reset, plateId, projection, configure, observe } = await createNozzleMappingFixture(modulePath);
const original = ok(projection(plateId));
assert.equal(original.eligible, true);
assert.equal(original.nozzles.length, 2);
assert.equal(original.modes[0].available, true, 'H2D supports native saving');
assert.equal(original.modes[1].available, false, 'live material matching is not supported');
assert.deepEqual(original.usedFilaments, [1, 2], 'painted fixture discovers both materials');

let rack = ok(call('orc_get_filament_session_snapshot'));
while (rack.slots.length < 6) {
  rack = ok(command('orc_add_filament_slot', { version: 1, revision: rack.revisions.session })).result.snapshot;
}
configure({ mapping_project_settings: { extruder_ams_count: '4#2|1#1;1#0' },
  plate_settings: { [plateId]: { filament_map_mode: 'Manual', filament_map: '2,1,2,1,2,1',
    enable_support: '1', support_filament: '5' } } });
const local = ok(projection(plateId));
assert.deepEqual(local.nozzles.map(n => n.capacity), [9, 1]);
assert.deepEqual(local.usedFilaments, [1, 2, 3, 4, 5], 'native support contributes a used material');
assert.deepEqual(local.effective.filamentMap, [2, 1, 2, 1, 2, 1], 'unused material mapping remains intact');
assert.equal(local.saved.mode, 2);
assert.ok(local.diagnostics.some(d => d.code === 'capacity_exceeded' && d.nozzle === 2));
configure({ plate_settings: { [plateId]: { filament_map_mode: 'Auto For Flush', filament_map: '99,1,2,1,2,1' } } });
assert.equal(ok(projection(plateId)).diagnostics.some(d => d.code === 'invalid_target'), false, 'automatic mode ignores retained manual targets');
configure({ plate_settings: { [plateId]: { filament_map_mode: 'Manual', filament_map: '2,1,2,1,2,1' } } });

ok(call('orc_add_plate'));
const second = ok(call('orc_get_plate_session_snapshot')).current_plate_id;
configure({ plate_settings: { [second]: { filament_map_mode: 'Nozzle Manual', filament_map: '1,2,1,2,1,2' } } });
const before = observe();
assert.equal(ok(projection(second)).saved.mode, 3);
assert.deepEqual(ok(projection(second)).usedFilaments, []);
assert.deepEqual(ok(projection(plateId)), local, 'explicit target is independent of selected Plate');
assert.deepEqual(observe(), before, 'queries preserve inputs, history and result validity');
assert.equal(projection('removed-plate').errorCode, 'plate_not_found');

for (const [nozzle_count, semm, eligible] of [[1, true, false], [2, false, false], [4, true, true]]) {
  configure({ printer_settings: { nozzle_count, semm } });
  const p = ok(projection(second));
  assert.equal(p.eligible, eligible);
  assert.equal(p.nozzles.length, nozzle_count);
  assert.equal(p.modes[2].available, eligible);
  assert.equal(p.modes[0].available, false);
  assert.ok(p.modes[0].reason);
}

// A real non-Bambu preset, then a synthetic SEMM topology constructed below
// the intentionally unchanged preset-editor restriction.
await reset();
const presets = ok(call('orc_get_preset_snapshot'));
const nonBambu = presets.printers.find(p => p.name === 'MyKlipper 0.4 nozzle');
assert.ok(nonBambu, 'fixture catalogue includes a non-Bambu printer');
ok(command('orc_select_printer_with_remembered_rack', { printer: nonBambu.name,
  remembered_bed_type: null, remembered_rack: null, history_context: context }));
ok(call('orc_add_plate'));
const genericPlate = ok(call('orc_get_plate_session_snapshot')).current_plate_id;
configure({ printer_settings: { nozzle_count: 3, semm: true } });
const generic = ok(projection(genericPlate));
assert.equal(generic.eligible, true);
assert.equal(generic.modes[2].available, true);
assert.equal(generic.modes[0].available, false);

for (const encoded of ['1#2147483648', '2147483647#2', '1#-1', '1#2|', '1#2|1#3', 'junk']) {
  configure({ mapping_project_settings: { extruder_ams_count: encoded } });
  assert.equal(projection(genericPlate).errorCode, 'invalid_mapping_state', encoded);
}
configure({ mapping_project_settings: { extruder_ams_count: '1#2147483647' } });
assert.equal(ok(projection(genericPlate)).nozzles[0].capacity, 2147483647);
configure({ mapping_project_settings: { extruder_ams_count: null } });
assert.deepEqual(ok(projection(genericPlate)).nozzles.map(n => n.capacity), [1, 1, 1]);
console.log('PASS native nozzle mapping projection: topology, capacity, painting/support, Plate isolation and read-only state');
process.exit(0);
