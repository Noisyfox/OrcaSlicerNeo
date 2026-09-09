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
const presetSnapshot = callJson('orc_get_preset_snapshot');
const printableArea = presetSnapshot.printable_area ?? [];
const areaBounds = printableArea.reduce((bounds, point) => ({
  minX: Math.min(bounds.minX, point[0]), maxX: Math.max(bounds.maxX, point[0]),
  minY: Math.min(bounds.minY, point[1]), maxY: Math.max(bounds.maxY, point[1]),
}), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
const plateWorldCenter = (plate) => [
  plate.origin[0] + (areaBounds.minX + areaBounds.maxX) * 0.5,
  plate.origin[1] + (areaBounds.minY + areaBounds.maxY) * 0.5,
];
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
const revisionsBeforeImport = { ...(session.input_revisions ?? {}) };
const addedCube = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Step2 Cube']);
check('add cube on current plate', addedCube.ok === true && addedCube.plate_session.dirty_reasons?.includes('model-import') &&
  addedCube.plate_session.affected_plate_ids_after?.includes(session.plates[1].plate_id));
const addedCubeTransform = addedCube.plate_session.instance_transforms?.find((entry) => entry.object_index === 1);
const selectedPlateCenter = plateWorldCenter(selected.plates.find((plate) =>
  plate.plate_id === selected.current_plate_id));
check('new model uses selected non-first plate world center and rests on bed',
  addedCubeTransform?.world_transform?.offset?.length === 3 &&
  Math.abs(addedCubeTransform.world_transform.offset[0] - selectedPlateCenter[0]) < 1e-6 &&
  Math.abs(addedCubeTransform.world_transform.offset[1] - selectedPlateCenter[1]) < 1e-6 &&
  Math.abs(addedCubeTransform.world_transform.offset[2] - 10) < 1e-6,
  JSON.stringify({ transform: addedCubeTransform, expectedXY: selectedPlateCenter }));
const addedRevision = addedCube.plate_session.input_revisions?.[session.plates[1].plate_id];
check('model import advances only its current plate revision', Number.isSafeInteger(addedRevision) &&
  Object.entries(addedCube.plate_session.input_revisions ?? {}).every(([id, revision]) =>
  revision === (id === session.plates[1].plate_id ? (revisionsBeforeImport[id] ?? 0) + 1 : revisionsBeforeImport[id] ?? 0)), JSON.stringify(addedCube));
const identity = JSON.stringify({ offset: [120, 0, 10], rotation: [0, 0, 0], scale: [30, 30, 30], mirror: [1, 1, 1] });
check('set oversized instance', callJson('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'], [1, 0, 0, identity, volumeIdentity]).ok === true);
const beforeCommit = callJson('orc_get_plate_session_snapshot');
check('membership waits for transform commit', beforeCommit.instances?.find((item) => item.object_index === 1)?.plate_id === session.plates[1].plate_id);
let membership = callJson('orc_recompute_plate_membership');
const instance = membership.instances?.find((item) => item.object_index === 1 && item.instance_index === 0);
check('convex-hull tie chooses lowest index', instance?.plate_id === session.plates[0].plate_id);
check('transform reports exact before/after affected plates', membership.dirty_reasons?.includes('model-transform') &&
  membership.affected_plate_ids_before?.length === 1 && membership.affected_plate_ids_before[0] === session.plates[1].plate_id &&
  membership.affected_plate_ids_after?.length === 1 && membership.affected_plate_ids_after[0] === session.plates[0].plate_id &&
  membership.affected_plate_ids?.length === 2 && membership.input_revisions?.[session.plates[0].plate_id] === 1 &&
  membership.input_revisions?.[session.plates[1].plate_id] === 2 && membership.input_revisions?.[session.plates[2].plate_id] === 1, JSON.stringify(membership));
const outside = JSON.stringify({ offset: [1000, 0, 10], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] });
check('move instance', callJson('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'], [1, 0, 0, outside, volumeIdentity]).ok === true);
membership = callJson('orc_recompute_plate_membership');
check('no matching plate is unprintable', membership.instances?.find((item) => item.object_index === 1)?.unprintable === true && membership.instances?.find((item) => item.object_index === 1)?.plate_id === '');
check('moving to no plate reports exact affected union', membership.affected_plate_ids_before?.length === 1 &&
  membership.affected_plate_ids_after?.length === 0 && membership.affected_plate_ids?.length === 1 &&
  membership.affected_plate_ids[0] === session.plates[0].plate_id, JSON.stringify(membership));
const partial = JSON.stringify({ offset: [243, 0, 10], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] });
check('move partially into plate', callJson('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'], [1, 0, 0, partial, volumeIdentity]).ok === true);
membership = callJson('orc_recompute_plate_membership');
check('membership and out-of-bounds are independent', membership.instances?.find((item) => item.object_index === 1)?.plate_id === session.plates[1].plate_id && membership.instances?.find((item) => item.object_index === 1)?.out_of_bounds === true);
check('moving from unprintable increments destination revision only', membership.affected_plate_ids_before?.length === 0 &&
  membership.affected_plate_ids_after?.length === 1 && membership.affected_plate_ids_after[0] === session.plates[1].plate_id &&
  membership.input_revisions?.[session.plates[1].plate_id] === 3, JSON.stringify(membership));

// Keep a member exactly inside the original bed's Y edge. A smaller printer
// must retain its plate assignment but mark that member out of bounds after
// the shared-configuration reflow.
check('add smaller-bed validity fixture', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Smaller bed validity'])
  .ok === true);
const edgeFixtureTransform = JSON.stringify({ offset: [session.plates[1].origin[0] + 100, 235, 10], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] });
check('place smaller-bed validity fixture at old bed edge', callJson('orc_set_model_transform',
  ['number', 'number', 'number', 'string', 'string'], [2, 0, 0, edgeFixtureTransform, volumeIdentity]).ok === true);
membership = callJson('orc_recompute_plate_membership');
const edgeFixtureBefore = membership.instances?.find((item) => item.object_index === 2);
check('validity fixture is initially a valid member', edgeFixtureBefore?.plate_id === session.plates[1].plate_id &&
  edgeFixtureBefore?.out_of_bounds === false, JSON.stringify(edgeFixtureBefore));
const revisionsBeforeConfiguration = { ...(membership.input_revisions ?? {}) };
const beforeConfiguration = callJson('orc_get_plate_session_snapshot');
const beforeConfigurationMesh = callJson('orc_get_model_mesh');
const beforeConfigurationInstances = new Map((beforeConfiguration.instances ?? [])
  .map((item) => [`${item.object_index}:${item.instance_index}`, item]));
const beforeConfigurationOffsets = new Map((beforeConfigurationMesh.objects ?? [])
  .map((item) => [`${item.object_idx}:${item.instance_idx}`, item.offset]));
for (const item of beforeConfigurationMesh.objects ?? []) {
  if (item.vertex_ptr) Module._free(Number(item.vertex_ptr));
  if (item.index_ptr) Module._free(Number(item.index_ptr));
}
const beforePrinter = callJson('orc_get_preset_snapshot');
const beforeArea = beforePrinter.printable_area ?? [];
const areaWidth = (area) => {
  const xs = area.map((point) => point[0]);
  return Math.max(...xs) - Math.min(...xs);
};
const areaHeight = (area) => {
  const ys = area.map((point) => point[1]);
  return Math.max(...ys) - Math.min(...ys);
};
let changedPrinter;
for (const entry of beforePrinter.printers ?? []) {
  if (entry.name === beforePrinter.printer?.name) continue;
  const candidate = callJson('orc_select_preset', ['string', 'string'], ['printer', entry.name]);
  if (candidate.ok === true && areaHeight(candidate.printable_area ?? []) < areaHeight(beforeArea)) {
    changedPrinter = candidate;
    break;
  }
}
check('printer preset reduces selected bed height', changedPrinter?.ok === true,
  JSON.stringify({ before: beforeArea, after: changedPrinter?.printable_area }));
const configuration = callJson('orc_mark_shared_configuration_mutation');
const expectedConfigurationOrigins = configuration.plates.map((plate, index) => {
  const width = areaWidth(changedPrinter?.printable_area ?? beforeArea);
  const cols = Math.round(Math.sqrt(configuration.plates.length)) +
    (Math.sqrt(configuration.plates.length) > Math.round(Math.sqrt(configuration.plates.length)) ? 1 : 0);
  const stride = width * 1.2;
  return [(index % cols) * stride, -Math.floor(index / cols) * stride, 0];
});
check('shared configuration reflows every plate origin, including empty plates',
  changedPrinter?.ok === true && configuration.plates.every((plate, index) =>
    plate.origin.every((value, axis) => Math.abs(value - expectedConfigurationOrigins[index][axis]) < 1e-6)),
  JSON.stringify(configuration.plates.map((plate) => plate.origin)));
check('shared configuration preserves current plate and membership state',
  configuration.current_plate_id === beforeConfiguration.current_plate_id &&
  configuration.instances?.every((item) => {
    const before = beforeConfigurationInstances.get(`${item.object_index}:${item.instance_index}`);
    return before && item.plate_id === before.plate_id && item.unprintable === before.unprintable;
  }), JSON.stringify(configuration.instances));
const edgeFixtureAfter = configuration.instances?.find((item) => item.object_index === 2);
const edgeFixturePlate = configuration.plates.find((plate) => plate.plate_id === edgeFixtureBefore?.plate_id);
check('shared configuration refreshes validity without reassigning the member',
  edgeFixtureAfter?.plate_id === edgeFixtureBefore?.plate_id && edgeFixtureAfter?.out_of_bounds === true &&
  edgeFixturePlate?.valid === false && edgeFixturePlate.out_of_bounds_instance_ids?.includes(edgeFixtureAfter.instance_id),
  JSON.stringify({ instance: edgeFixtureAfter, plate: edgeFixturePlate }));
const changedConfigurationMesh = configuration.instance_transforms ?? [];
check('shared configuration returns world transforms for moved members', changedConfigurationMesh.length > 0 &&
  changedConfigurationMesh.every((entry) => {
    const before = beforeConfigurationInstances.get(`${entry.object_index}:${entry.instance_index}`);
    const oldOffset = beforeConfigurationOffsets.get(`${entry.object_index}:${entry.instance_index}`);
    const plateIndex = before ? beforeConfiguration.plates.findIndex((plate) => plate.plate_id === before.plate_id) : -1;
    if (!oldOffset || plateIndex < 0) return false;
    return entry.world_transform.offset.every((value, axis) =>
      Math.abs(value - oldOffset[axis] + beforeConfiguration.plates[plateIndex].origin[axis] - configuration.plates[plateIndex].origin[axis]) < 1e-6);
  }), JSON.stringify(changedConfigurationMesh));
check('shared configuration invalidates every existing plate', configuration.dirty_reasons?.includes('shared-configuration') &&
  configuration.affected_plate_ids_before?.length === session.plates.length &&
  configuration.affected_plate_ids_after?.length === session.plates.length &&
  session.plates.every((plate) => configuration.input_revisions?.[plate.plate_id] ===
    (revisionsBeforeConfiguration[plate.plate_id] ?? 0) + 1), JSON.stringify(configuration));

const beforeDelete = callJson('orc_get_plate_session_snapshot');
const currentId = beforeDelete.current_plate_id;
const nonCurrentId = beforeDelete.plates.find((p) => p.plate_id !== currentId).plate_id;
const reflowBeforeDelete = beforeDelete.instances.find((item) => item.object_index === 0);
const deleted = callJson('orc_delete_plate', ['string'], [nonCurrentId]);
check('delete non-current preserves current identity', deleted.ok === true && deleted.current_plate_id === currentId);
check('delete returns atomic transform list', Array.isArray(deleted.instance_transforms));
const reflowedByDelete = deleted.instance_transforms?.find((entry) => entry.object_index === 0);
check('delete reflows following instances', reflowedByDelete?.object_index === 0 &&
  Array.isArray(reflowedByDelete.world_transform?.offset));
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
