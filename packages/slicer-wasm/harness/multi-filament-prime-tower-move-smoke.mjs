// Native Prime Tower timestamped-history smoke.
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { callAsyncTask, getSliceResult } from './async-task-mailbox.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let i = 2; i < argv.length; i += 2) opts[argv[i]?.replace(/^--/, '')] = argv[i + 1];
if (!opts.module) throw new Error('usage: node multi-filament-prime-tower-move-smoke.mjs --module out/threaded/orca_slice.js');
const root = resolve(import.meta.dirname, '../../..');
const trace = (phase) => {
  if (process.env.ORCA_HARNESS_TRACE === '1') console.error(`[prime-tower-move] ${phase}`);
};
const Module = await (await loadModuleFactory(resolve(opts.module)))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(opts['profile-root'] ?? `${root}/packages/profile-resources/dist`)));

function callJson(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const value = JSON.parse(Module.UTF8ToString(ptr)); Module._free(ptr); return value;
}
function request(name, body) { return callJson(name, ['string'], [JSON.stringify(body)]); }
function setProject(key, value) {
  const result = callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'], ['project', '', key, value]);
  assert.equal(result.ok, true, JSON.stringify(result)); return result;
}
function session() { return callJson('orc_get_plate_session_snapshot'); }
function projectArray(key) {
  const result = callJson('orc_get_project_config_overlay');
  assert.equal(result.ok, true, JSON.stringify(result));
  const encoded = result.overlay.project[key];
  assert.equal(typeof encoded, 'string', `${key} must be a serialized project array`);
  const values = encoded.split(',').map(Number);
  assert.ok(values.length > 0 && values.every(Number.isFinite), `${key}: ${encoded}`);
  return values;
}
function assertNoPlateCoordinates(snapshot) {
  for (const plate of snapshot.plates)
    assert.equal(Object.hasOwn(plate.settings ?? {}, 'wipe_tower_x') || Object.hasOwn(plate.settings ?? {}, 'wipe_tower_y'), false);
}
function historyEntryId(label) {
  const status = callJson('orc_history_status');
  const entry = [...(status.undoEntries ?? []), ...(status.redoEntries ?? [])].find((candidate) => candidate.label === label);
  assert.equal(typeof entry?.id, 'string', `missing history entry ${label}: ${JSON.stringify(status)}`);
  return entry.id;
}
function modelShape() {
  const model = callJson('orc_get_model_structure');
  assert.equal(model.ok, true, JSON.stringify(model));
  return model.objects.map((object) => ({
    index: object.index, name: object.name, printable: object.printable, instanceCount: object.instanceCount,
    instances: object.instances.map((instance) => ({ index: instance.index, printable: instance.printable })),
    volumes: object.volumes.map((volume) => ({ index: volume.index, name: volume.name, type: volume.type })),
  }));
}

assert.equal(callJson('orc_init', ['string'], ['']).ok, true);
trace('initialized');
for (let index = 0; index < 12; index++)
  assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', `prime tower object ${index}`]).ok, true);
setProject('enable_prime_tower', '1'); setProject('timelapse_type', '1');
setProject('prime_tower_width', '25'); setProject('prime_tower_brim_width', '7');
setProject('wipe_tower_rotation_angle', '90'); setProject('wipe_tower_wall_type', 'rectangle');

const firstPlate = session().current_plate_id;
assert.equal(callJson('orc_add_plate').ok, true);
for (let index = 0; index < 8; index++)
  assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', `second plate object ${index}`]).ok, true);
const secondPlate = session().current_plate_id;
assert.equal(callJson('orc_add_plate').ok, true);
for (let index = 0; index < 8; index++)
  assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', `third plate object ${index}`]).ok, true);
const thirdPlate = session().current_plate_id;

assert.equal(projectArray('wipe_tower_x').length, 3);
assert.equal(projectArray('wipe_tower_y').length, 3); assertNoPlateCoordinates(session());

// Regression: two independent cubes assigned to different filament slots must
// publish the same per-plate revision that a subsequent Prime Tower drag uses.
// This deliberately exercises the native assignment -> tower-move boundary,
// rather than relying on a forced single-material tower fixture.
let filament = callJson('orc_get_filament_session_snapshot');
while (filament.slots.length < 2) {
  const added = request('orc_add_filament_slot', { version: 1, revision: filament.revisions.session });
  assert.equal(added.ok, true, JSON.stringify(added));
  filament = added.result.snapshot;
}
const firstPlateObjects = callJson('orc_get_model_structure').objects.slice(0, 2);
assert.equal(firstPlateObjects.length, 2, 'two Cube objects are required for the multi-filament drag regression');
for (const [index, object] of firstPlateObjects.entries()) {
  const assigned = request('orc_assign_filament', {
    version: 1, revision: filament.revisions.session, slot: index + 1,
    targets: [{ kind: 'object', id: object.id }],
  });
  assert.equal(assigned.ok, true, JSON.stringify(assigned));
  filament = assigned.result.snapshot;
}
const multifilamentRevision = filament.revisions.plates[firstPlate];
assert.equal(session().input_revisions[firstPlate], multifilamentRevision,
  'the plate session must expose the filament receipt revision to a tower move');
const multifilamentBefore = { x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') };
const multifilamentHistory = callJson('orc_history_status');
const multifilamentMove = request('orc_move_prime_tower', {
  version: 1, plate_id: firstPlate, revision: multifilamentRevision, x: 30, y: 30,
});
assert.equal(multifilamentMove.ok, true, JSON.stringify(multifilamentMove));
assert.equal(multifilamentMove.result.mutation.history_entry_delta, 1);
assert.equal(callJson('orc_history_status').undoEntries.length, multifilamentHistory.undoEntries.length + 1);
const multifilamentAfter = { x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') };
assert.notDeepEqual(multifilamentAfter, multifilamentBefore, 'released tower coordinates must persist');
trace('initial prime tower move committed');
// Populate the moved target projection so Undo must prove that its own cache
// entry is invalidated rather than returning the moved JSON unchanged.
callJson('orc_take_performance_profile');
callJson('orc_get_prime_tower_projection');
const multifilamentUndo = callJson('orc_history_undo');
assert.equal(multifilamentUndo.ok, true);
assert.deepEqual({ x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') }, multifilamentBefore);
assert.equal(multifilamentUndo.impact?.model, 'delta', JSON.stringify(multifilamentUndo));
assert.equal(multifilamentUndo.impact?.preview, 'all', JSON.stringify(multifilamentUndo));
assert.equal(Object.hasOwn(multifilamentUndo, 'prime_tower_receipt'), false, JSON.stringify(multifilamentUndo));
callJson('orc_take_performance_profile');
callJson('orc_get_prime_tower_projection');
const undoProjectionProfile = callJson('orc_take_performance_profile');
const undoProjectionSample = undoProjectionProfile.samples.find((sample) => sample.operation === 'prime_tower_projection');
assert.ok(undoProjectionSample, JSON.stringify(undoProjectionProfile));
assert.ok(undoProjectionSample.per_plate_stages_ms[0].total > 0, JSON.stringify(undoProjectionSample));
assert.equal(undoProjectionSample.stages_ms.used_slot_full_scan_fallback, 0, JSON.stringify(undoProjectionSample));
const multifilamentRedo = callJson('orc_history_redo');
assert.equal(multifilamentRedo.ok, true);
assert.deepEqual({ x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') }, multifilamentAfter);
assert.equal(multifilamentRedo.impact?.model, 'delta', JSON.stringify(multifilamentRedo));
assert.equal(multifilamentRedo.impact?.preview, 'all', JSON.stringify(multifilamentRedo));
assert.equal(Object.hasOwn(multifilamentRedo, 'prime_tower_receipt'), false, JSON.stringify(multifilamentRedo));
callJson('orc_take_performance_profile');
callJson('orc_get_prime_tower_projection');
const redoProjectionProfile = callJson('orc_take_performance_profile');
const redoProjectionSample = redoProjectionProfile.samples.find((sample) => sample.operation === 'prime_tower_projection');
assert.ok(redoProjectionSample, JSON.stringify(redoProjectionProfile));
assert.ok(redoProjectionSample.per_plate_stages_ms[0].total > 0, JSON.stringify(redoProjectionSample));
assert.equal(redoProjectionSample.stages_ms.used_slot_full_scan_fallback, 0, JSON.stringify(redoProjectionSample));
trace('initial prime tower undo/redo projections complete');

const thirdRevision = session().input_revisions[thirdPlate];
// This plate deliberately uses one tool from a multi-slot project. Smooth
// timelapse still requires its tower, exercising WipeTower2's one-tool prime.
const thirdTower = callJson('orc_get_prime_tower_projection').plates.find((plate) => plate.plate_id === thirdPlate);
assert.equal(thirdTower.used_slots.length, 1, JSON.stringify(thirdTower));
trace('third plate slice starting');
const thirdSlice = await callAsyncTask(callJson, 'orc_slice_plate',
  ['string', 'string', 'number'], ['{}', thirdPlate, thirdRevision]);
assert.equal(thirdSlice.ok, true, JSON.stringify(thirdSlice));
trace('third plate slice complete');
assert.equal(getSliceResult(callJson, thirdSlice.receipt).ok, true);
assert.equal(callJson('orc_select_plate', ['string'], [secondPlate]).ok, true);
const before = projectArray('wipe_tower_x'); const beforeY = projectArray('wipe_tower_y');
const beforeRevision = session().input_revisions[secondPlate];
const beforeHistory = callJson('orc_history_status'); const beforeDiagnostics = callJson('orc_history_restore_diagnostics');

for (const [label, body, code] of [
  ['stale', { version: 1, plate_id: secondPlate, revision: beforeRevision - 1, x: 20, y: 20 }, 'stale_revision'],
  ['missing', { version: 1, plate_id: 'missing', revision: 0, x: 20, y: 20 }, 'unsupported_reference'],
  ['nonfinite', { version: 1, plate_id: secondPlate, revision: beforeRevision, x: 'nan', y: 20 }, 'invalid_command'],
  ['injected', { version: 1, plate_id: secondPlate, revision: beforeRevision, x: 20, y: 20, inject_failure: true }, 'native_validation_failure'],
]) {
  const snapshot = JSON.stringify({ session: session(), x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y'), history: callJson('orc_history_status') });
  const failed = request('orc_move_prime_tower', body);
  assert.equal(failed.ok, false, `${label}: ${JSON.stringify(failed)}`); assert.equal(failed.error_code, code);
  assert.equal(JSON.stringify({ session: session(), x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y'), history: callJson('orc_history_status') }), snapshot);
}

const started = performance.now();
const move = request('orc_move_prime_tower', { version: 1, plate_id: secondPlate, revision: beforeRevision, x: 999, y: 999 });
const moveDurationMs = performance.now() - started;
assert.equal(move.ok, true, JSON.stringify(move)); assert.ok(moveDurationMs < 1000, `move took ${moveDurationMs.toFixed(1)}ms`);
assert.deepEqual(move.result.history_status, callJson('orc_history_status'), JSON.stringify(move));
assert.equal(move.result.history_status.dirty, move.result.mutation.dirty, JSON.stringify(move));
// The movement response is intentionally scalar-only. Returning a full
// all-plate projection or session here made every release rebuild and copy a
// large opened project despite an X/Y-only mutation.
assert.equal(Object.hasOwn(move.result, 'projection'), false);
assert.equal(Object.hasOwn(move.result, 'plate_session'), false);
assert.ok(Number.isFinite(move.result.mutation.position.x));
assert.ok(Number.isFinite(move.result.mutation.position.y));
const after = projectArray('wipe_tower_x'); const afterY = projectArray('wipe_tower_y');
assert.equal(after.length, 3); assert.equal(afterY.length, 3);
assert.equal(after[0], before[0]); assert.equal(after[2], before[2]);
assert.equal(afterY[0], beforeY[0]); assert.equal(afterY[2], beforeY[2]);
assert.notEqual(after[1], before[1]); assert.notEqual(afterY[1], beforeY[1]); assertNoPlateCoordinates(session());
const afterDiagnostics = callJson('orc_history_restore_diagnostics');
assert.equal(afterDiagnostics.fullPresetBundleCopyCount, beforeDiagnostics.fullPresetBundleCopyCount);
assert.ok(afterDiagnostics.currentContextBytes > 0);
assert.equal(Object.hasOwn(afterDiagnostics, 'currentDirectFrameKind'), false);
assert.equal(Object.hasOwn(afterDiagnostics, 'currentDirectFrameBytes'), false);
assert.equal(getSliceResult(callJson, thirdSlice.receipt).ok, true);
assert.equal(callJson('orc_history_status').undoEntries.length, beforeHistory.undoEntries.length + 1);

assert.equal(callJson('orc_history_undo').ok, true); assert.deepEqual(projectArray('wipe_tower_x'), before); assert.deepEqual(projectArray('wipe_tower_y'), beforeY);
let restoredThird = getSliceResult(callJson, thirdSlice.receipt); assert.equal(restoredThird.ok, false); assert.equal(restoredThird.status, 'stale');
trace('selected plate move undo/redo complete');
assert.equal(callJson('orc_history_redo').ok, true); assert.deepEqual(projectArray('wipe_tower_x'), after); assert.deepEqual(projectArray('wipe_tower_y'), afterY);
restoredThird = getSliceResult(callJson, thirdSlice.receipt); assert.equal(restoredThird.ok, false); assert.equal(restoredThird.status, 'stale');

// A Prime Tower timestamp followed by an ordinary model mutation restores the
// same three roots. Exercise one-step navigation in both directions plus
// directional jumps across the mixed sequence.
const mixedModelBefore = modelShape();
const mixedCoordinatesBefore = { x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') };
const mixedRevisionBefore = session().input_revisions[secondPlate];
assert.equal(request('orc_move_prime_tower', {
  version: 1, plate_id: secondPlate, revision: mixedRevisionBefore, x: 20, y: 20,
}).ok, true);
const mixedTowerCoordinates = { x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') };
const mixedTowerEntryId = historyEntryId('Move Prime Tower');
const mixedHistoryContext = {
  selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, projectConfigOverlay: {},
};
const mixedTransaction = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Prime Tower mixed structural model', 'project', JSON.stringify(mixedHistoryContext), '']);
assert.equal(typeof mixedTransaction.transactionId, 'string', JSON.stringify(mixedTransaction));
assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Prime Tower mixed restore object']).ok, true);
const mixedCommit = callJson('orc_history_commit', ['string', 'string'], [mixedTransaction.transactionId, JSON.stringify(mixedHistoryContext)]);
assert.equal(mixedCommit.canUndo, true, JSON.stringify(mixedCommit));
const mixedStructuralEntryId = historyEntryId('Prime Tower mixed structural model');
const mixedModelAfter = modelShape();
assert.equal(mixedModelAfter.length, mixedModelBefore.length + 1);

const mixedUndo = callJson('orc_history_undo');
assert.equal(mixedUndo.ok, true, JSON.stringify(mixedUndo));
assert.notEqual(mixedUndo.direct, true, JSON.stringify(mixedUndo));
assert.equal(mixedUndo.impact?.model, 'delta', JSON.stringify(mixedUndo));
assert.deepEqual(modelShape(), mixedModelBefore);
assert.deepEqual({ x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') }, mixedTowerCoordinates);
const mixedRedo = callJson('orc_history_redo');
assert.equal(mixedRedo.ok, true, JSON.stringify(mixedRedo));
assert.notEqual(mixedRedo.direct, true, JSON.stringify(mixedRedo));
assert.equal(mixedRedo.impact?.model, 'delta', JSON.stringify(mixedRedo));
assert.deepEqual(modelShape(), mixedModelAfter);
assert.deepEqual({ x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') }, mixedTowerCoordinates);

assert.equal(callJson('orc_history_undo').ok, true);
const towerUndo = callJson('orc_history_undo');
assert.equal(towerUndo.ok, true, JSON.stringify(towerUndo));
assert.deepEqual(towerUndo.impact, {
  version: 1, model: 'delta', plateSession: true, filamentRack: true,
  projectOverlay: true, selectionContext: true, primeTower: true, preview: 'all',
}, JSON.stringify(towerUndo));
assert.deepEqual(modelShape(), mixedModelBefore);
assert.deepEqual({ x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') }, mixedCoordinatesBefore);
const towerRedo = callJson('orc_history_redo');
assert.equal(towerRedo.ok, true, JSON.stringify(towerRedo));
assert.equal(towerRedo.impact?.model, 'delta', JSON.stringify(towerRedo));
assert.deepEqual({ x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') }, mixedTowerCoordinates);
assert.equal(callJson('orc_history_redo').ok, true);

const jumpBeforeTower = callJson('orc_history_jump', ['string', 'string'], [mixedTowerEntryId, 'undo']);
assert.equal(jumpBeforeTower.ok, true, JSON.stringify(jumpBeforeTower));
assert.equal(jumpBeforeTower.impact?.model, 'delta', JSON.stringify(jumpBeforeTower));
assert.deepEqual(modelShape(), mixedModelBefore);
assert.deepEqual({ x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') }, mixedCoordinatesBefore);
const jumpToTower = callJson('orc_history_jump', ['string', 'string'], [mixedTowerEntryId, 'redo']);
assert.equal(jumpToTower.ok, true, JSON.stringify(jumpToTower));
assert.equal(jumpToTower.impact?.model, 'delta', JSON.stringify(jumpToTower));
assert.deepEqual(modelShape(), mixedModelBefore);
assert.deepEqual({ x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') }, mixedTowerCoordinates);
const jumpToStructural = callJson('orc_history_jump', ['string', 'string'], [mixedStructuralEntryId, 'redo']);
assert.equal(jumpToStructural.ok, true, JSON.stringify(jumpToStructural));
assert.equal(jumpToStructural.impact?.model, 'delta', JSON.stringify(jumpToStructural));
assert.deepEqual(modelShape(), mixedModelAfter);
assert.deepEqual({ x: projectArray('wipe_tower_x'), y: projectArray('wipe_tower_y') }, mixedTowerCoordinates);
trace('mixed history navigation complete');

const targetRevision = session().input_revisions[secondPlate];
trace('second plate slice starting');
const secondSlice = await callAsyncTask(callJson, 'orc_slice_plate', ['string', 'string', 'number'],
  ['{}', secondPlate, targetRevision]);
assert.equal(secondSlice.ok, true);
trace('second plate slice complete');
assert.equal(getSliceResult(callJson, secondSlice.receipt).ok, true);
assert.equal(request('orc_move_prime_tower', { version: 1, plate_id: secondPlate, revision: targetRevision, x: 30, y: 30 }).ok, true);
let invalid = getSliceResult(callJson, secondSlice.receipt); assert.equal(invalid.ok, false); assert.equal(invalid.status, 'stale');
assert.equal(callJson('orc_history_undo').ok, true); invalid = getSliceResult(callJson, secondSlice.receipt); assert.equal(invalid.ok, false); assert.equal(invalid.status, 'stale');
assert.equal(callJson('orc_history_redo').ok, true); invalid = getSliceResult(callJson, secondSlice.receipt); assert.equal(invalid.ok, false); assert.equal(invalid.status, 'stale');

assert.equal(callJson('orc_delete_plate', ['string'], [firstPlate]).ok, true);
assert.equal(projectArray('wipe_tower_x').length, 2); assert.equal(projectArray('wipe_tower_y').length, 2);
assert.equal(session().plates.find((plate) => plate.plate_id === secondPlate).display_index, 0);
assert.equal(session().plates.find((plate) => plate.plate_id === thirdPlate).display_index, 1); assertNoPlateCoordinates(session());
trace('complete');

console.log(JSON.stringify({ ok: true, plateId: secondPlate, moveDurationMs: Number(moveDurationMs.toFixed(2)),
  historyContextBytes: afterDiagnostics.currentContextBytes,
  allPreviewResultsInvalidAfterUndoRedo: true, fullTimestampRestores: true }));
