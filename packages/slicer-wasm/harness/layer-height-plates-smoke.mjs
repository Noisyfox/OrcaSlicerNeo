import assert from 'node:assert/strict';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';
import { callAsyncTask, getSliceResult } from './async-task-mailbox.mjs';

const { module, call } = await createMixedFilamentFixture(process.argv[2]);
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
const session = () => ok(call('orc_get_plate_session_snapshot'));
const objects = () => ok(call('orc_get_model_structure')).objects;
const first = session().current_plate_id;
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Shared layer heights']));
const owner = objects()[0].id;
ok(call('orc_add_instance', ['number'], [owner]));
const second = ok(call('orc_add_plate')).current_plate_id;
const third = ok(call('orc_add_plate')).current_plate_id;
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Independent']));
const independentId = objects()[1].id;

const placement = session();
const origin = id => placement.plates.find(p => p.plate_id === id).origin;
const bodies = ok(call('orc_get_model_mesh')).renderables.filter(row => row.object_idx === 0);
const source = bodies.find(row => row.instance_idx === 0);
assert.ok(source);
const moved = structuredClone(source.instance_transform);
delete moved.matrix;
moved.rotation[2] += Math.PI / 3;
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
const context = JSON.stringify({ selection: { mode: 'instance', objectIds: [owner], partIds: [], instanceIds: [shared[1]] },
  activePlateId: second, gizmo: { type: 'layer-height' }, nativeScopedConfig: {} });
const command = (plateId, operation, rest = {}, objectId = owner) => ok(call('orc_layer_height', ['string'],
  [JSON.stringify({ plateId, objectId, operation, ...rest })]));
const read = (plateId, objectId = owner) => command(plateId, 'read', {}, objectId).profile;
const baseline = read(second);
ok(call('orc_select_plate', ['string'], [second]));
const strokeId = command(second, 'begin', { stamp: baseline.stamp }).strokeId;
const draft = command(second, 'samples', { strokeId, samples: [{ action: 1, z: 10, width: 2 }] });
module._free(draft.pointer);
const tx = ok(call('orc_history_begin', ['string', 'string', 'string', 'string'], ['Brush layer height', 'project', context, '']));
const result = command(second, 'finish', { strokeId });
assert.deepEqual(result.plate_session.affected_plate_ids.sort(), [first, second].sort());
const saved = call('orc_history_commit', ['string', 'string'], [tx.transactionId, context]);
assert.equal(saved.status?.canUndo, true, JSON.stringify(saved));
let previous = before;
for (const action of ['edit', 'orc_history_undo', 'orc_history_redo']) {
  if (action !== 'edit') {
    const restore = ok(call(action));
    assert.deepEqual(restore.affected_plate_ids.sort(), [first, second].sort());
    assert.equal(restore.context.gizmo.type, 'layer-height');
  }
  const revisions = session().input_revisions;
  assert.equal(revisions[third], before[third]);
  ok(call('orc_select_plate', ['string'], [third]));
  ok(getSliceResult(call, independent.receipt));
  assert.equal(read(third, independentId).hasSavedCurve, false);
  const expected = action === 'orc_history_undo' ? baseline.curve : draft.profile.curve;
  for (const id of [first, second]) {
    assert.deepEqual(read(id).curve, expected);
    assert.notEqual(revisions[id], previous[id]);
  }
  previous = revisions;
}
console.log('PASS shared curve, rotated second instance, undo/redo and unaffected third plate G-code');
process.exit(0);
