import assert from 'node:assert/strict';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';
import { callAsyncTask, getSliceResult } from './async-task-mailbox.mjs';

const { call } = await createMixedFilamentFixture(process.argv[2]);
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
const session = () => ok(call('orc_get_plate_session_snapshot'));
const objects = () => ok(call('orc_get_model_structure')).objects;
const first = session().current_plate_id;
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Shared ranges']));
const owner = objects()[0].id;
ok(call('orc_add_instance', ['number'], [owner]));
const second = ok(call('orc_add_plate')).current_plate_id;
const third = ok(call('orc_add_plate')).current_plate_id;
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Independent']));
const independentId = objects()[1].id;
ok(call('orc_edit_height_ranges', ['string'], [JSON.stringify({ objectId: independentId, operation: 'initialize' })]));
const placement = session();
const origin = id => placement.plates.find(p => p.plate_id === id).origin;
const bodies = ok(call('orc_get_model_mesh')).renderables.filter(row => row.object_idx === 0);
const source = bodies.find(row => row.instance_idx === 0);
assert.ok(source);
const moved = structuredClone(source.instance_transform);
delete moved.matrix;
moved.offset = moved.offset.map((value, axis) => value + origin(second)[axis] - origin(first)[axis]);
ok(call('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'],
  [0, 0, 1, JSON.stringify(moved), JSON.stringify(source.volume_transform)]));
ok(call('orc_recompute_plate_membership'));
const shared = objects()[0].instances.map(row => row.id);
const placed = session().plates;
for (const [index, id] of [first, second].entries())
  assert.ok(placed.find(p => p.plate_id === id).instance_ids.includes(shared[index]));
const before = session().input_revisions;
const independent = ok(await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number', 'string'],
  ['{}', third, before[third], 'null']));
ok(getSliceResult(call, independent.receipt));
const context = JSON.stringify({ selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: first, gizmo: null, nativeScopedConfig: {} });
const tx = ok(call('orc_history_begin', ['string', 'string', 'string', 'string'], ['Add height range', 'project', context, '']));
const result = ok(call('orc_edit_height_ranges', ['string'], [JSON.stringify({ objectId: owner, operation: 'initialize' })]));
assert.deepEqual(result.plate_session.affected_plate_ids.sort(), [first, second].sort());
const commit = call('orc_history_commit', ['string', 'string'], [tx.transactionId, context]);
assert.equal(commit.status?.canUndo, true, JSON.stringify(commit));
let previous = before;
for (const action of ['edit', 'orc_history_undo', 'orc_history_redo']) {
  if (action !== 'edit') assert.deepEqual(ok(call(action)).affected_plate_ids.sort(), [first, second].sort());
  const revisions = session().input_revisions;
  assert.equal(revisions[third], before[third], 'independent object on third plate retains its input stamp');
  ok(call('orc_select_plate', ['string'], [third]));
  ok(getSliceResult(call, independent.receipt));
  assert.equal(objects()[0].heightRanges?.length ?? 0, action === 'orc_history_undo' ? 0 : 1);
  assert.equal(objects()[1].heightRanges?.length, 1);
  for (const id of [first, second]) assert.notEqual(revisions[id], previous[id], action + ' refreshes ' + id);
  previous = revisions;
}
console.log('PASS shared object edits, undo and redo on two plates preserve an independent third plate');
process.exit(0);
