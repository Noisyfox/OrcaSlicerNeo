import assert from 'node:assert/strict';
import { createNozzleMappingFixture } from './nozzle-mapping-fixtures.mjs';
const { call, command, ok, context, plateId, projection, configure, observe } = await createNozzleMappingFixture(process.argv[2]);
const other = ok(call('orc_add_plate')).current_plate_id;
assert.equal(ok(projection(other)).saved.mode, 0);
configure({ plate_settings: { [plateId]: { filament_map_mode: 'Nozzle Manual', filament_map: '1,2', filament_volume_map: '0,0', filament_nozzle_map: '0,0' },
  [other]: { filament_map_mode: 'Manual', filament_map: '2,1' } } });
command('orc_history_reset', context);
const inputs = () => {
  const s = observe();
  return { mappingInputs: s.mappingInputs, config: s.config.native_scoped_config.snapshot, model: s.model,
    maps: [ok(projection(plateId)).saved, ok(projection(other)).saved] };
};
const mutate = (change, extra = {}, id = plateId) => command('orc_mutate_nozzle_mapping', {
  plateId: id, revision: call('orc_history_status').revision, plateRevision: ok(projection(id)).revision,
  change, history_context: context, ...extra,
});
const unchanged = inputs();
const initial = call('orc_history_status');
assert.equal(ok(mutate({ kind: 'mapping', filamentMap: [1, 2] })).changed, false);
assert.equal(ok(projection(plateId)).saved.mode, 3);
assert.equal(call('orc_history_status').revision, initial.revision);
for (const change of [
  { kind: 'mapping', filamentMap: [1] }, { kind: 'mapping', filamentMap: [1, 3] },
  { kind: 'mapping', filamentMap: [0, 1] }, { kind: 'mode', mode: 1 },
  ...[0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER + 1].map(capacity => ({ kind: 'capacity', nozzle: 1, capacity })),
  { kind: 'capacity', nozzle: 3, capacity: 2 },
]) {
  assert.equal(mutate(change).ok, false);
  assert.deepEqual(inputs(), unchanged);
}
assert.equal(mutate({ kind: 'mode', mode: 2 }, { revision: initial.revision + 1 }).errorCode, 'stale_revision');
assert.equal(mutate({ kind: 'mode', mode: 2 }, { plateRevision: 9999 }).errorCode, 'stale_revision');
assert.equal(mutate({ kind: 'mode', mode: 2 }, { plateId: 'deleted-plate' }).errorCode, 'plate_not_found');
const otherRevision = ok(projection(other)).revision;
const edit = ok(mutate({ kind: 'mapping', filamentMap: [2, 2] }));
assert.equal(edit.changed, true);
assert.equal(edit.snapshot.saved.mode, 2);
assert.equal(edit.history_status.undoEntries.length, initial.undoEntries.length + 1);
assert.equal(edit.history_status.dirty, true);
assert.deepEqual(edit.plate_session.affected_plate_ids, [plateId]);
assert.equal(ok(projection(other)).revision, otherRevision);
assert.ok(edit.snapshot.diagnostics.some(d => d.code === 'capacity_exceeded'));
const changed = inputs();
ok(call('orc_history_undo'));
assert.deepEqual(inputs(), unchanged, 'Undo restores all editable inputs including Nozzle Manual');
ok(call('orc_history_redo'));
assert.deepEqual(inputs(), changed);
// Inject a fault after native publication but before the history commit.
const beforeFailure = observe();
assert.equal(mutate({ kind: 'capacity', nozzle: 1, capacity: 8 }, { inject_failure_stage: 'before-publication' }).ok, false);
assert.deepEqual(observe(), beforeFailure, 'late failure restores input, lifecycle and history snapshots');
const capacityBefore = inputs();
const capacities = ok(mutate({ kind: 'capacity', nozzle: 1, capacity: 8 }));
assert.deepEqual(capacities.plate_session.affected_plate_ids.sort(), [plateId, other].sort());
assert.deepEqual(capacities.snapshot.nozzles.map(n => n.capacity), [8, 1]);
const capacityAfter = inputs();
ok(call('orc_history_undo')); assert.deepEqual(inputs(), capacityBefore);
ok(call('orc_history_redo')); assert.deepEqual(inputs(), capacityAfter);
const saved = ok(projection(plateId)).saved;
ok(mutate({ kind: 'mode', mode: 0 }));
assert.deepEqual(ok(projection(plateId)).saved.filamentMap, saved.filamentMap);
assert.equal(mutate({ kind: 'mapping', filamentMap: [1, 1] }).ok, false);
ok(mutate({ kind: 'mode', mode: 2 }));
assert.deepEqual(ok(projection(plateId)).saved.filamentMap, saved.filamentMap);
// Existing material commands must maintain both independent Plate maps.
let rack = ok(call('orc_get_filament_session_snapshot'));
ok(command('orc_add_filament_slot', { version: 1, revision: rack.revisions.session }));
assert.deepEqual(ok(projection(plateId)).saved.filamentMap, [2, 2, 1]);
assert.deepEqual(ok(projection(other)).saved.filamentMap, [2, 1, 1]);
rack = ok(call('orc_get_filament_session_snapshot'));
ok(command('orc_merge_filament_slots', { version: 1, revision: rack.revisions.session, source: 3, destination: 2 }));
assert.deepEqual(ok(projection(plateId)).saved.filamentMap, [2, 2]);
assert.deepEqual(ok(projection(other)).saved.filamentMap, [2, 1]);
console.log('PASS native nozzle mapping mutations: guards, atomic history, Nozzle Manual, mode retention, capacity scope and material transitions');
const setCount = count => ok(command('orc_mutate_preset_draft', { kind: 'printer', canonical_name: 'Bambu Lab H2D 0.4 nozzle',
  expected_revision: call('orc_history_status').revision, history_context: context, action: 'set', key: 'extruders_count', value: String(count) }));
setCount(3);
assert.equal(ok(projection(plateId)).modes[0].available, false);
const added = ok(call('orc_add_plate')).current_plate_id;
assert.equal(ok(projection(added)).saved.mode, 2, 'unsupported automatic topology starts new Plates in Manual');
ok(mutate({ kind: 'mapping', filamentMap: [3, 2] }));
const beforeRemoval = inputs();
setCount(2);
assert.deepEqual(ok(projection(plateId)).effective.filamentMap, [1, 2]);
assert.deepEqual(ok(projection(other)).effective.filamentMap, [2, 1]);
ok(call('orc_history_undo')); assert.deepEqual(inputs(), beforeRemoval);
ok(call('orc_history_redo'));
assert.deepEqual(ok(projection(plateId)).effective.filamentMap, [1, 2]);
console.log('PASS native topology repair preserves valid targets and repairs removed heads in one Undo operation');
const beforeSwitch = inputs();
ok(command('orc_select_printer_with_remembered_rack', { printer: 'MyKlipper 0.4 nozzle',
  remembered_rack: null, remembered_bed_type: null, history_context: context }));
assert.deepEqual(ok(projection(plateId)).effective.filamentMap, [1, 1], 'explicit preset switch repairs removed targets too');
ok(call('orc_history_undo')); assert.deepEqual(inputs(), beforeSwitch);
ok(call('orc_history_redo'));
assert.deepEqual(ok(projection(plateId)).effective.filamentMap, [1, 1]);
console.log('PASS direct printer preset switch repairs and restores per-Plate mappings atomically');
