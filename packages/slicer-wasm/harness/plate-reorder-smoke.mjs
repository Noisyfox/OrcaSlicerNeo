// Real-WASM plate reorder acceptance: stable identities retain their runtime
// entry, while only plates whose physical grid origin changes lose result
// publication. Reorder itself never slices or applies a Print.
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { callAsyncTask, getSliceResult } from './async-task-mailbox.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [moduleArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node plate-reorder-smoke.mjs <out/orca_slice.js>');
const root = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(moduleArg))({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(root, 'packages/profile-resources/dist')));

function callJson(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
function requireOk(label, value) {
  assert.equal(value?.ok, true, `${label}: ${JSON.stringify(value)}`);
  return value;
}

requireOk('init', callJson('orc_init', ['string'], ['{"log_level":"error"}']));
requireOk('plate A model', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Reorder A']));
requireOk('add plate B', callJson('orc_add_plate'));
requireOk('plate B model', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Reorder B']));
requireOk('add plate C', callJson('orc_add_plate'));
requireOk('plate C model', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Reorder C']));
const before = requireOk('before session', callJson('orc_get_plate_session_snapshot'));
const [plateA, plateB, plateC] = before.plates.map((plate) => plate.plate_id);
const beforeOrigins = Object.fromEntries(before.plates.map((plate) => [plate.plate_id, plate.origin]));
const receipts = new Map();
for (const plateId of [plateA, plateB, plateC]) {
  requireOk(`select ${plateId}`, callJson('orc_select_plate', ['string'], [plateId]));
  const session = callJson('orc_get_plate_session_snapshot');
  const sliced = requireOk(`slice ${plateId}`, await callAsyncTask(callJson, 'orc_slice_plate',
    ['string', 'string', 'number'], ['{}', plateId, session.input_revisions[plateId]]));
  receipts.set(plateId, sliced.receipt);
}

const reordered = requireOk('reverse plate order', callJson('orc_reorder_plates', ['string'],
  [JSON.stringify([plateC, plateB, plateA])]));
assert.deepEqual(reordered.plates.map((plate) => plate.plate_id), [plateC, plateB, plateA]);
assert.deepEqual(reordered.plates.find((plate) => plate.plate_id === plateB)?.origin, beforeOrigins[plateB]);
assert.ok(reordered.input_revisions[plateA] > before.input_revisions[plateA]);
assert.ok(reordered.input_revisions[plateC] > before.input_revisions[plateC]);
assert.equal(reordered.input_revisions[plateB], before.input_revisions[plateB]);

for (const plateId of [plateA, plateB, plateC]) {
  requireOk(`select reordered ${plateId}`, callJson('orc_select_plate', ['string'], [plateId]));
  const result = getSliceResult(callJson, receipts.get(plateId));
  if (plateId === plateB) requireOk('origin-stable B result retained', result);
  else assert.equal(result.status, 'stale', `${plateId} should be stale: ${JSON.stringify(result)}`);
}

const rejected = callJson('orc_reorder_plates', ['string'], [JSON.stringify([plateA, plateA, plateC])]);
assert.equal(Boolean(rejected.ok), false, JSON.stringify(rejected));
const afterReject = callJson('orc_get_plate_session_snapshot');
assert.deepEqual(afterReject.plates.map((plate) => plate.plate_id), [plateC, plateB, plateA]);

console.log('plate reorder PASS');
