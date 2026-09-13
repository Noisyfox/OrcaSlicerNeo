// Step 13 real threaded lifecycle smoke.
// node multi-filament-prime-tower-step13-smoke.mjs --module out/threaded/orca_slice.js
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let i = 2; i < argv.length; i += 2) opts[argv[i]?.replace(/^--/, '')] = argv[i + 1];
if (!opts.module) throw new Error('usage: node multi-filament-prime-tower-step13-smoke.mjs --module out/threaded/orca_slice.js');
const root = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(resolve(opts.module)))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(opts['profile-root'] ?? `${root}/packages/profile-resources/dist`)));

function callJson(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
function request(name, body) { return callJson(name, ['string'], [JSON.stringify(body)]); }
function setProject(key, value) {
  return callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'], ['project', '', key, value]);
}
function arrays() {
  const overlay = callJson('orc_get_project_config_overlay');
  assert.equal(overlay.ok, true, JSON.stringify(overlay));
  const projection = callJson('orc_get_prime_tower_projection');
  const values = Object.fromEntries([['wipe_tower_x', 'x'], ['wipe_tower_y', 'y']].map(([key, axis]) => [key,
    (overlay.overlay.project[key] ?? String(projection.plates[0].position[axis])).split(',').map(Number)]));
  assert.ok(Object.values(values).every((items) => items.length > 0 && items.every(Number.isFinite)),
    JSON.stringify({ overlay, projection, values }));
  return values;
}
function assertNoPlateCoordinates() {
  const snapshot = callJson('orc_get_plate_session_snapshot');
  assert.equal(snapshot.plates.some((plate) => Object.hasOwn(plate.settings ?? {}, 'wipe_tower_x') ||
    Object.hasOwn(plate.settings ?? {}, 'wipe_tower_y')), false, JSON.stringify(snapshot));
  return snapshot;
}
function transaction(label, edit) {
  const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
    activePlateId: null, gizmo: null, projectConfigOverlay: {} };
  const begun = callJson('orc_history_begin', ['string', 'string', 'string', 'string'], [label, 'project', JSON.stringify(context), '']);
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const result = edit();
  assert.equal(result.ok, true, JSON.stringify(result));
  context.projectConfigOverlay = callJson('orc_get_project_config_overlay').overlay;
  const committed = callJson('orc_history_commit', ['string', 'string'], [begun.transactionId, JSON.stringify(context)]);
  assert.equal(committed.canUndo, true, JSON.stringify(committed));
  return committed;
}

assert.equal(callJson('orc_init', ['string'], ['{"log_level":"error"}']).ok, true);
const first = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Step 13 primary']);
assert.equal(first.ok, true, JSON.stringify(first));
const second = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Step 13 secondary']);
assert.equal(second.ok, true, JSON.stringify(second));
let filament = callJson('orc_get_filament_session_snapshot');
const addedSlot = request('orc_add_filament_slot', { version: 1, revision: filament.revisions.session });
assert.equal(addedSlot.ok, true, JSON.stringify(addedSlot)); filament = addedSlot.result.snapshot;
const objects = callJson('orc_get_model_structure').objects;
let assigned = request('orc_assign_filament', { version: 1, revision: filament.revisions.session, slot: 2,
  targets: [{ kind: 'object', id: objects[1].id }] });
assert.equal(assigned.ok, true, JSON.stringify(assigned));
filament = assigned.result.snapshot;
assert.equal(setProject('enable_prime_tower', '1').ok, true);
assert.equal(setProject('prime_tower_width', '25').ok, true);
assert.equal(setProject('wipe_tower_wall_type', 'rectangle').ok, true);
assert.equal(assertNoPlateCoordinates().plates.length, 1);
let projection = callJson('orc_get_prime_tower_projection');
assert.equal(projection.plates[0].eligible, true, JSON.stringify(projection));

// Printer transitions recompute the native footprint without publishing a
// user history entry or dirtying the project.
const presets = callJson('orc_get_preset_snapshot');
const alternatePrinter = presets.printers.find((entry) => entry.name !== presets.printer?.name);
if (alternatePrinter) {
  const profileHistoryBefore = callJson('orc_history_status');
  const selected = callJson('orc_select_preset', ['string', 'string'], ['printer', alternatePrinter.name]);
  assert.equal(selected.ok, true, JSON.stringify(selected));
  const profileHistoryAfter = callJson('orc_history_status');
  assert.equal(profileHistoryAfter.undoEntries.length, profileHistoryBefore.undoEntries.length);
  assert.equal(profileHistoryAfter.dirty, profileHistoryBefore.dirty);
  assertNoPlateCoordinates();
}

// A footprint-changing setting is one transaction, including normalization.
const beforeCoordinates = arrays();
const beforeHistory = callJson('orc_history_status');
const beforeDiagnostics = callJson('orc_history_restore_diagnostics');
let wideSetting;
const wideCommit = transaction('Step 13 wide prime tower', () => {
  wideSetting = setProject('prime_tower_width', '250');
  return wideSetting;
});
const wideCoordinates = arrays();
assert.equal(wideCommit.undoEntries.length, beforeHistory.undoEntries.length + 1);
assert.equal(callJson('orc_history_restore_diagnostics').fullPresetBundleCopyCount,
  beforeDiagnostics.fullPresetBundleCopyCount);
assertNoPlateCoordinates();
assert.equal(callJson('orc_history_undo').ok, true);
assert.deepEqual(arrays(), beforeCoordinates);
assert.equal(callJson('orc_history_redo').ok, true);
assert.deepEqual(arrays(), wideCoordinates);

// Assignment and filament changes execute the same normalization hook while
// remaining a single semantic history operation.
filament = callJson('orc_get_filament_session_snapshot');
const assignmentHistoryBefore = callJson('orc_history_status');
const assignment = request('orc_assign_filament', {
  version: 1, revision: filament.revisions.session, slot: 1, targets: [{ kind: 'object', id: objects[1].id }],
});
assert.equal(assignment.ok, true, JSON.stringify(assignment));
const assignmentCommit = callJson('orc_history_status');
assert.equal(assignmentCommit.undoEntries.length, assignmentHistoryBefore.undoEntries.length + 1);
filament = callJson('orc_get_filament_session_snapshot');
const colourHistoryBefore = callJson('orc_history_status');
const colour = request('orc_set_filament_slot_colour', {
  version: 1, revision: filament.revisions.session, slot: 2, colour: '#121212',
});
assert.equal(colour.ok, true, JSON.stringify(colour));
const colourCommit = callJson('orc_history_status');
assert.equal(colourCommit.undoEntries.length, colourHistoryBefore.undoEntries.length + 1);
assertNoPlateCoordinates();

filament = callJson('orc_get_filament_session_snapshot');
const restoredAssignment = request('orc_assign_filament', { version: 1, revision: filament.revisions.session,
  slot: 2, targets: [{ kind: 'object', id: objects[1].id }] });
assert.equal(restoredAssignment.ok, true, JSON.stringify(restoredAssignment));

// Enable/disable is immediately reflected in the native projection and does
// not require a renderer-side validation or repair pass.
assert.equal(setProject('enable_prime_tower', '0').ok, true);
projection = callJson('orc_get_prime_tower_projection');
assert.equal(projection.plates[0].eligible, false, JSON.stringify(projection));
assert.equal(setProject('enable_prime_tower', '1').ok, true);
projection = callJson('orc_get_prime_tower_projection');
assert.equal(projection.plates[0].eligible, true, JSON.stringify(projection));

// Slice-time advisory warnings are returned with successful slice results;
// deliberately exercise each accepted tower collision class independently.
function sliceCurrentPlate() {
  const current = assertNoPlateCoordinates();
  const result = callJson('orc_slice_plate', ['string', 'string', 'number'], ['{}', current.current_plate_id,
    current.input_revisions[current.current_plate_id]]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.warnings), JSON.stringify(result));
  return result;
}
const collisionArea = '120x120,140x120,140x150,120x150';
assert.equal(setProject('prime_tower_width', '25').ok, true);
let current = assertNoPlateCoordinates();
const moved = request('orc_move_prime_tower', { version: 1, plate_id: current.current_plate_id,
  revision: current.input_revisions[current.current_plate_id], x: 105, y: 128 });
assert.equal(moved.ok, true, JSON.stringify(moved));
const modelSlice = sliceCurrentPlate();
assert.ok(modelSlice.warnings.includes('Prime Tower intersects a model.'), JSON.stringify(modelSlice));

assert.equal(setProject('bed_exclude_area', collisionArea).ok, true);
const exclusionSlice = sliceCurrentPlate();
assert.ok(exclusionSlice.warnings.includes('Prime Tower intersects an exclusion area.'), JSON.stringify(exclusionSlice));
const combinedPlate = assertNoPlateCoordinates();
const combinedCollisionAndInvalidConfig = callJson('orc_slice_plate', ['string', 'string', 'number'],
  [JSON.stringify({ nozzle_temperature: [1, 2] }), combinedPlate.current_plate_id,
    combinedPlate.input_revisions[combinedPlate.current_plate_id]]);
assert.notEqual(combinedCollisionAndInvalidConfig.ok, true, JSON.stringify(combinedCollisionAndInvalidConfig));

assert.equal(setProject('wrapping_exclude_area', collisionArea).ok, true);
const wrappingSlice = sliceCurrentPlate();
assert.ok(wrappingSlice.warnings.includes('Prime Tower intersects a wrapping-detection area.'), JSON.stringify(wrappingSlice));

// Unrelated native validation remains a hard error.
const hardError = callJson('orc_slice', ['string'], [JSON.stringify({ nozzle_temperature: [1, 2] })]);
assert.notEqual(hardError.ok, true, JSON.stringify(hardError));

console.log(JSON.stringify({ ok: true, historyEntries: colourCommit.undoEntries.length,
  fullPresetBundleCopyCount: callJson('orc_history_restore_diagnostics').fullPresetBundleCopyCount,
  normalizedCoordinates: arrays(), effectiveWidth: wideSetting.configuration_status?.corrections,
  warnings: { model: modelSlice.warnings.length, exclusion: exclusionSlice.warnings.length, wrapping: wrappingSlice.warnings.length },
  hardError: true }));
