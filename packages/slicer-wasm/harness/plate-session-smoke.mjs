// Direct Step 2 mutation harness.  It intentionally talks to the bridge
// exports (rather than the typed client) so both production wasm variants are
// checked for atomic plate lifecycle, native grid order, and membership.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [moduleArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node plate-session-smoke.mjs <out/orca_slice.js>');
const repoRoot = resolve(import.meta.dirname, '../../..');
const factory = await loadModuleFactory(moduleArg);
const Module = await factory({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(repoRoot, 'packages/profile-resources/dist')));

function callJson(name, argTypes = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  const result = JSON.parse(Module.UTF8ToString(ptr));
  Module._free(ptr);
  return result;
}
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}
let failures = 0;
const init = callJson('orc_init', ['string'], ['{"log_level":"error"}']);
check('init', init.ok === true);
let session = callJson('orc_get_plate_session_snapshot');
const firstId = session.current_plate_id;
check('one default plate', session.plates?.length === 1 && session.plates[0].display_index === 0);

for (let i = 0; i < 3; i++) {
  const added = callJson('orc_add_plate');
  check(`add plate ${i + 2}`, added.ok === true && added.plates.length === i + 2 &&
    added.current_plate_id === added.plates[i + 1].plate_id && Array.isArray(added.instance_transforms));
  session = added;
}
// Put an object on old plate index 2 before adding the fifth plate.  Native
// grid growth from 2 to 3 columns must reflow it by the same delta while
// preserving its plate-local coordinates.
check('add reflow fixture', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Reflow Cube']).ok === true);
const reflowTransform = JSON.stringify({ offset: [10, -296, 10], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] });
const volumeIdentity = JSON.stringify({ offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] });
check('place reflow fixture on plate 3', callJson('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'], [0, 0, 0, reflowTransform, volumeIdentity]).ok === true);
const fifth = callJson('orc_add_plate');
const reflowed = fifth.instance_transforms?.find((entry) => entry.object_index === 0);
check('add recomputes stale membership before reflow', fifth.ok === true && fifth.instances?.[0]?.plate_id === fifth.plates[2].plate_id);
check('add reflows instances atomically', fifth.ok === true && reflowed?.world_transform?.offset?.every((value, axis) => Math.abs(value - [506.8, 10, 10][axis]) < 1e-6));
check('add preserves local coordinates', fifth.ok === true && reflowed?.world_transform?.offset?.every((value, axis) => Math.abs(value - fifth.plates[2].origin[axis] - [10, 10, 10][axis]) < 1e-6));
session = fifth;
const expectedOrigins = [[0, 0, 0], [248.4, 0, 0], [496.8, 0, 0], [0, -306, 0], [248.4, -306, 0]];
check('native 3x2 grid ordering', session.plates.every((p, i) => p.origin.every((value, axis) => Math.abs(value - expectedOrigins[i][axis]) < 1e-6)), JSON.stringify(session.plates.map((p) => p.origin)));

const selected = callJson('orc_select_plate', ['string'], [session.plates[1].plate_id]);
check('select preserves identity', selected.ok === true && selected.current_plate_id === session.plates[1].plate_id, JSON.stringify(selected));
const rejectedSelect = callJson('orc_select_plate', ['string'], ['missing-plate']);
const afterRejectedSelect = callJson('orc_get_plate_session_snapshot');
check('invalid select is atomic', rejectedSelect.ok !== true && afterRejectedSelect.current_plate_id === selected.current_plate_id);

// A deliberately oversized convex-hull box intersects plate 1 and plate 2;
// lowest display index wins.  The later move intersects neither plate.
check('add cube', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Step2 Cube']).ok === true);
const identity = JSON.stringify({ offset: [120, 0, 10], rotation: [0, 0, 0], scale: [30, 30, 30], mirror: [1, 1, 1] });
check('set oversized instance', callJson('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'], [1, 0, 0, identity, volumeIdentity]).ok === true);
let membership = callJson('orc_recompute_plate_membership');
const instance = membership.instances?.find((item) => item.object_index === 1 && item.instance_index === 0);
check('convex-hull tie chooses lowest index', instance?.plate_id === session.plates[0].plate_id);
const outside = JSON.stringify({ offset: [1000, 0, 10], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] });
check('move instance', callJson('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'], [1, 0, 0, outside, volumeIdentity]).ok === true);
membership = callJson('orc_recompute_plate_membership');
check('no matching plate is unprintable', membership.instances?.find((item) => item.object_index === 1)?.unprintable === true && membership.instances?.find((item) => item.object_index === 1)?.plate_id === '');
const partial = JSON.stringify({ offset: [243, 0, 10], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] });
check('move partially into plate', callJson('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'], [1, 0, 0, partial, volumeIdentity]).ok === true);
membership = callJson('orc_recompute_plate_membership');
check('membership and out-of-bounds are independent', membership.instances?.find((item) => item.object_index === 1)?.plate_id === session.plates[1].plate_id && membership.instances?.find((item) => item.object_index === 1)?.out_of_bounds === true);

const beforeDelete = callJson('orc_get_plate_session_snapshot');
const currentId = beforeDelete.current_plate_id;
const nonCurrentId = beforeDelete.plates.find((p) => p.plate_id !== currentId).plate_id;
const reflowBeforeDelete = beforeDelete.instances.find((item) => item.object_index === 0);
const deleted = callJson('orc_delete_plate', ['string'], [nonCurrentId]);
check('delete non-current preserves current identity', deleted.ok === true && deleted.current_plate_id === currentId);
check('delete returns atomic transform list', Array.isArray(deleted.instance_transforms));
const reflowedByDelete = deleted.instance_transforms?.find((entry) => entry.object_index === 0);
check('delete reflows following instances', reflowedByDelete?.world_transform?.offset?.every((value, axis) => Math.abs(value - [258.4, 10, 10][axis]) < 1e-6));
check('delete preserves local coordinates', reflowBeforeDelete?.plate_id === beforeDelete.plates[2].plate_id && reflowedByDelete?.world_transform?.offset?.every((value, axis) => Math.abs(value - deleted.plates[1].origin[axis] - [10, 10, 10][axis]) < 1e-6));

// Current deletion chooses the plate compacting into the deleted slot, and
// deleting the last current plate falls back to the preceding plate.
const currentDeleteTarget = deleted.plates[0].plate_id;
const nextCurrent = deleted.plates[1].plate_id;
const currentDeleted = callJson('orc_delete_plate', ['string'], [currentDeleteTarget]);
check('delete current selects compacted successor', currentDeleted.ok === true && currentDeleted.current_plate_id === nextCurrent);
const lastCurrent = currentDeleted.plates[currentDeleted.plates.length - 1].plate_id;
const precedingCurrent = currentDeleted.plates[currentDeleted.plates.length - 2].plate_id;
const selectedLast = callJson('orc_select_plate', ['string'], [lastCurrent]);
check('select last plate before final deletion', selectedLast.ok === true && selectedLast.current_plate_id === lastCurrent);
const lastDeleted = callJson('orc_delete_plate', ['string'], [lastCurrent]);
check('delete last current selects predecessor', lastDeleted.ok === true && lastDeleted.current_plate_id === precedingCurrent);
// Keep the limit test independent from geometry-reflow cost; deletion and
// membership have already been exercised above.
callJson('orc_clear_model');
callJson('orc_reset_plate_session');
session = callJson('orc_get_plate_session_snapshot');
while (session.plates.length < 36) {
  session = callJson('orc_add_plate');
  if (session.plates?.length % 5 === 0) console.log(`INFO  added through ${session.plates.length}`);
}
const overLimit = callJson('orc_add_plate');
const afterLimit = callJson('orc_get_plate_session_snapshot');
check('37th add atomically rejects', overLimit.ok !== true && afterLimit.plates.length === 36);
const sole = callJson('orc_reset_plate_session');
const soleDelete = callJson('orc_delete_plate', ['string'], [sole.current_plate_id]);
const afterSoleDelete = callJson('orc_get_plate_session_snapshot');
check('sole plate delete atomically rejects', soleDelete.ok !== true && afterSoleDelete.current_plate_id === sole.current_plate_id && afterSoleDelete.plates.length === 1);
check('reset creates fresh identity', firstId !== sole.current_plate_id);

if (failures) process.exit(1);
