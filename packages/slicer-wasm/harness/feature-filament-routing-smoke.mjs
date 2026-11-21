import assert from 'node:assert/strict';
import { awaitAsyncTask, getSliceResult } from './async-task-mailbox.mjs';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';

const { module, call, rack, run, edit } = await createMixedFilamentFixture(process.argv[2]);
function checked(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

const selector = 'outer-wall';
checked(call('orc_add_shape', ['string', 'string'], ['Cube', 'Feature routing']));
const [object] = checked(call('orc_get_model_structure')).objects;
const secondPart = checked(call('orc_add_volume', ['string', 'pointer', 'number'], [JSON.stringify({
  objectId: object.id, instanceId: object.instances[0].id, volumeType: 'model_part', shape: 'Cube',
}), 0, 0]));
const objectTarget = { kind: 'object', id: object.id };
const partTargets = [object.volumes[0].id, secondPart.volumeId].map(id => ({ kind: 'model-part', id }));
const projectTarget = { kind: 'project', id: 0 };
edit('orc_assign_filament', { slot: 1, targets: partTargets });

function route(targets, slot) {
  edit('orc_set_filament_routing', { selector, slot, targets });
}

function assertPartRoute(inherited, defaulted, effectiveSlot) {
  const rows = rack().routing.filter(item => item.target === 'model-part' && item.selector === selector);
  assert.equal(rows.length, partTargets.length);
  for (const row of rows)
    assert.deepEqual([row.inherited, row.defaulted, row.effective_slot], [inherited, defaulted, effectiveSlot]);
}

function projectSlot(snapshot = rack()) {
  return snapshot.routing.find(row => row.target === 'project' && row.selector === selector).explicit_slot;
}

async function assertOuterWallTool(expectedTool) {
  const sliced = checked(await awaitAsyncTask(call, call('orc_slice', ['string'], ['{}'])));
  const { toolpath } = checked(getSliceResult(call, sliced.receipt));
  const { segment_count: count, extrusion_role_ptr: rolePointer, extruder_id_ptr: toolPointer } = toolpath;
  const roles = new Uint16Array(module.HEAPU8.buffer, Number(rolePointer), count);
  const tools = new Uint8Array(module.HEAPU8.buffer, Number(toolPointer), count);
  const outerWallTools = new Set();
  for (let i = 0; i < count; i++)
    if (roles[i] === 2) outerWallTools.add(tools[i]); // libvgcode ExternalPerimeter
  assert.deepEqual([...outerWallTools], [expectedTool], 'physical tool used by outer wall');
}

const modelPlateId = checked(call('orc_get_plate_session_snapshot')).current_plate_id;
checked(call('orc_add_plate'));
checked(call('orc_select_plate', ['string'], [modelPlateId]));
const beforeGlobal = rack().revisions.plates;
const global = checked(run('orc_set_filament_routing', { selector, slot: 2, targets: [projectTarget] })).result;
assert.equal(global.mutation.all_plate_results_invalidated, true);
assert.deepEqual(global.mutation.affected_plate_ids.sort(), Object.keys(beforeGlobal).sort());
for (const [id, revision] of Object.entries(beforeGlobal))
  assert.ok(global.snapshot.revisions.plates[id] > revision, `stale project route on ${id}`);
assert.equal(projectSlot(global.snapshot), 2);
assertPartRoute(true, false, 2);
await assertOuterWallTool(1);
checked(call('orc_history_undo'));
assertPartRoute(true, false, 1);
checked(call('orc_history_redo'));
assertPartRoute(true, false, 2);

route([objectTarget], 2);
assertPartRoute(true, false, 2);
await assertOuterWallTool(1);

route(partTargets, 0);
assertPartRoute(false, true, 1);
await assertOuterWallTool(0);

route(partTargets, null);
assertPartRoute(true, false, 2);
await assertOuterWallTool(1);
checked(call('orc_history_undo'));
assertPartRoute(false, true, 1);
checked(call('orc_history_redo'));
assertPartRoute(true, false, 2);
checked(call('orc_history_undo'));

const archive = checked(call('orc_export_project', ['string'], ['{}']));
const archivePointer = Number(archive.bytes_ptr);
const bytes = module.HEAPU8.slice(archivePointer, archivePointer + archive.bytes_length);
module._free(archivePointer);
const inputPointer = Number(module._malloc(bytes.length));
try {
  module.HEAPU8.set(bytes, inputPointer);
  checked(call('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [inputPointer, bytes.length, 0, 'feature-routing.3mf']));
} finally {
  module._free(inputPointer);
}
assertPartRoute(false, true, 1);
await assertOuterWallTool(0);
assert.equal(projectSlot(), 2);
assert.equal(projectSlot(edit('orc_delete_filament_slot', { slot: 2 })), 0);
checked(call('orc_history_undo'));
assert.equal(projectSlot(edit('orc_merge_filament_slots', { source: 2, destination: 1 })), 1);
console.log('Feature routing passed: Project routes, plate invalidation, Default, inheritance, history, 3MF and slot remapping.');
