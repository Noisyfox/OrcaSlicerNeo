import assert from 'node:assert/strict';
import { awaitAsyncTask, getSliceResult } from './async-task-mailbox.mjs';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';

const { module, call, rack, edit } = await createMixedFilamentFixture(process.argv[2]);
function checked(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

const selector = 'outer-wall';
checked(call('orc_add_shape', ['string', 'string'], ['Cube', 'Feature routing']));
const [object] = checked(call('orc_get_model_structure')).objects;
const objectTarget = { kind: 'object', id: object.id };
const partTarget = { kind: 'model-part', id: object.volumes[0].id };
edit('orc_assign_filament', { slot: 1, targets: [partTarget] });

function route(target, slot) {
  edit('orc_set_filament_routing', { selector, slot, targets: [target] });
}

function assertPartRoute(inherited, defaulted, effectiveSlot) {
  const row = rack().routing.find(item => item.target === 'model-part' && item.selector === selector);
  assert.deepEqual([row.inherited, row.defaulted, row.effective_slot], [inherited, defaulted, effectiveSlot]);
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

route(objectTarget, 2);
assertPartRoute(true, false, 2);
await assertOuterWallTool(1);

route(partTarget, 0);
assertPartRoute(false, true, 1);
await assertOuterWallTool(0);

route(partTarget, null);
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
console.log('Feature routing passed: native Default, inheritance, history and the 3MF outer-wall tool round trip.');
