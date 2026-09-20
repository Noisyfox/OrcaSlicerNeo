// Regression: slicing each plate must select the native Print plate index so
// libslic3r reads the matching element of wipe_tower_x/y.
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { callAsyncTask, exportGcode as exportScopedGcode } from './async-task-mailbox.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [moduleArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node multi-filament-slice-plate-index-smoke.mjs <out/orca_slice.js>');
const root = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(moduleArg))({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(root, 'packages/profile-resources/dist')));

function callJson(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const value = JSON.parse(Module.UTF8ToString(ptr));
  Module._free(ptr);
  return value;
}
function request(name, body) {
  return callJson(name, ['string'], [JSON.stringify(body)]);
}
function setProject(key, value) {
  const result = callJson('orc_set_native_scoped_config',
    ['string', 'string', 'string', 'string'], ['project', '', key, value]);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
function session() { return callJson('orc_get_plate_session_snapshot'); }
function revisions() {
  const current = session();
  return Object.fromEntries(current.plates.map((plate) => [plate.plate_id, current.input_revisions[plate.plate_id]]));
}
function exportGcode(receipt) {
  const result = exportScopedGcode(callJson, receipt);
  assert.equal(result.ok, true, JSON.stringify(result));
  return Buffer.from(Module.FS.readFile(result.path)).toString('utf8');
}

assert.equal(callJson('orc_init', ['string'], ['{"log_level":"error"}']).ok, true);
setProject('enable_prime_tower', '1');
setProject('prime_tower_width', '25');
setProject('wipe_tower_wall_type', 'rectangle');
setProject('timelapse_type', '1');

assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Plate 1 object 1']).ok, true);
assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Plate 1 object 2']).ok, true);
let model = callJson('orc_get_model_structure');
let filament = callJson('orc_get_filament_session_snapshot');
while (filament.slots.length < 2) {
  const added = request('orc_add_filament_slot', { version: 1, revision: filament.revisions.session });
  assert.equal(added.ok, true, JSON.stringify(added));
  filament = added.result.snapshot;
}
const firstObjects = model.objects;
const firstAssignment = request('orc_assign_filament', {
  version: 1, revision: filament.revisions.session, slot: 2,
  targets: [{ kind: 'object', id: firstObjects[1].id }],
});
assert.equal(firstAssignment.ok, true, JSON.stringify(firstAssignment));
filament = firstAssignment.result.snapshot;

const firstPlate = session().current_plate_id;
const addedPlate = callJson('orc_add_plate');
assert.equal(addedPlate.ok, true, JSON.stringify(addedPlate));
const secondPlate = session().current_plate_id;
assert.notEqual(secondPlate, firstPlate);
assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Plate 2 object 1']).ok, true);
assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Plate 2 object 2']).ok, true);
model = callJson('orc_get_model_structure');
filament = callJson('orc_get_filament_session_snapshot');
const secondObjects = model.objects.slice(2);
const secondAssignment = request('orc_assign_filament', {
  version: 1, revision: filament.revisions.session, slot: 2,
  targets: [{ kind: 'object', id: secondObjects[1].id }],
});
assert.equal(secondAssignment.ok, true, JSON.stringify(secondAssignment));

// Deliberately different coordinates make an index regression observable in
// the emitted Prime Tower moves. Coordinates are changed only through the
// native narrow movement command; the resulting project configuration remains
// one complete native array.
assert.equal(callJson('orc_select_plate', ['string'], [firstPlate]).ok, true);
let plateRevision = revisions();
let moved = request('orc_move_prime_tower', {
  version: 1, plate_id: firstPlate, revision: plateRevision[firstPlate], x: 30, y: 40,
});
assert.equal(moved.ok, true, JSON.stringify(moved));
assert.equal(callJson('orc_select_plate', ['string'], [secondPlate]).ok, true);
plateRevision = revisions();
moved = request('orc_move_prime_tower', {
  version: 1, plate_id: secondPlate, revision: plateRevision[secondPlate], x: 130, y: 140,
});
assert.equal(moved.ok, true, JSON.stringify(moved));
plateRevision = revisions();

assert.equal(callJson('orc_select_plate', ['string'], [firstPlate]).ok, true);
const firstSlice = await callAsyncTask(callJson, 'orc_slice_plate', ['string', 'string', 'number'],
  ['{}', firstPlate, plateRevision[firstPlate]]);
assert.equal(firstSlice.ok, true);
const firstGcode = exportGcode(firstSlice.receipt);
assert.match(firstGcode, /X30\.500\s+Y40\.500/, 'plate 1 tower position missing from G-code');
assert.doesNotMatch(firstGcode, /X130\.500\s+Y140\.500/, 'plate 1 used plate 2 tower position');

assert.equal(callJson('orc_select_plate', ['string'], [secondPlate]).ok, true);
const secondSlice = await callAsyncTask(callJson, 'orc_slice_plate', ['string', 'string', 'number'],
  ['{}', secondPlate, plateRevision[secondPlate]]);
assert.equal(secondSlice.ok, true);
const secondGcode = exportGcode(secondSlice.receipt);
assert.match(secondGcode, /X130\.500\s+Y140\.500/, 'plate 2 tower position missing from G-code');
assert.doesNotMatch(secondGcode, /X30\.500\s+Y40\.500/, 'plate 2 used plate 1 tower position');

assert.equal(callJson('orc_select_plate', ['string'], [firstPlate]).ok, true);
const finalRevision = revisions()[firstPlate];
const finalSlice = await callAsyncTask(callJson, 'orc_slice_plate', ['string', 'string', 'number'],
  ['{}', firstPlate, finalRevision]);
assert.equal(finalSlice.ok, true);
const firstAgain = exportGcode(finalSlice.receipt);
assert.match(firstAgain, /X30\.500\s+Y40\.500/, '切回 plate 1 后 tower position leaked');

console.log(JSON.stringify({ ok: true, firstPlate, secondPlate,
  positions: { first: [30, 40], second: [130, 140], firstAgain: [30, 40] } }));
