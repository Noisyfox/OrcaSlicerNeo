// Real-WASM projection validity, including warm-cache and unrelated-plate work.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { awaitAsyncTask } from './async-task-mailbox.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: node prime-tower-cache-validity-smoke.mjs <module>');
const root = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(resolve(modulePath)))({
  noInitialRun: true, print: () => {}, printErr: () => {},
});
await installProfilePackages(Module, createNodeProfileSource(resolve(root, 'packages/profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try {
    const result = JSON.parse(Module.UTF8ToString(pointer));
    if (name === 'orc_history_commit') assert.equal(result.status.canUndo, true, JSON.stringify(result));
    else if (name === 'orc_slice_plate') assert.equal(result.accepted, true, JSON.stringify(result));
    else if (name !== 'orc_take_performance_profile')
      assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
    return result;
  } finally { Module._free(pointer); }
}
function snapshot() { return call('orc_get_plate_session_snapshot'); }
function project(key, value) {
  setNativeScopedConfig(call, 'project', undefined, key, value);
}
function projection() {
  call('orc_take_performance_profile');
  const result = call('orc_get_prime_tower_projection');
  const sample = call('orc_take_performance_profile').samples.find((item) => item.operation === 'prime_tower_projection');
  assert.ok(sample, 'native projection profile is required');
  return { result, sample, tower: (id) => result.plates.find((plate) => plate.plate_id === id) };
}
function assertCached(read, ids) {
  for (const id of ids) {
    const index = read.result.plates.findIndex((plate) => plate.plate_id === id);
    assert.equal(read.sample.per_plate_stages_ms[index].total, 0, `unexpected recomputation of ${id}`);
  }
}
function move(entry, offset) {
  const context = JSON.stringify({ selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
    activePlateId: snapshot().current_plate_id, gizmo: null, nativeScopedConfig: {} });
  const transaction = call('orc_history_begin', ['string', 'string', 'string', 'string'],
    ['Move', 'project', context, '']);
  const transform = { ...entry.instance_transform, offset };
  delete transform.matrix;
  const mutation = call('orc_set_model_transforms', ['string', 'string'], [transaction.transactionId,
    JSON.stringify([{ objectIdx: entry.object_idx, volumeIdx: entry.volume_idx, instanceIdx: entry.instance_idx,
      instanceTransform: transform, volumeTransform: entry.volume_transform }])]);
  call('orc_history_commit', ['string', 'string'], [transaction.transactionId, context]);
  return mutation;
}
function history(label, operation) {
  const context = JSON.stringify({ selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
    activePlateId: snapshot().current_plate_id, gizmo: null, nativeScopedConfig: {} });
  const transaction = call('orc_history_begin', ['string', 'string', 'string', 'string'],
    [label, 'project', context, '']);
  const result = operation();
  call('orc_history_commit', ['string', 'string'], [transaction.transactionId, context]);
  return result;
}

call('orc_init', ['string'], ['']);
call('orc_add_shape', ['string', 'string'], ['Cube', 'first plate']);
const first = snapshot().current_plate_id;
call('orc_add_plate');
call('orc_add_shape', ['string', 'string'], ['Cube', 'unaffected plate']);
const second = snapshot().current_plate_id;
project('enable_prime_tower', '1');
project('timelapse_type', '1');
let read = projection();
assert.equal(read.tower(first).eligible, true);
assert.equal(read.tower(second).eligible, true);
assertCached(projection(), [first, second]);

// Structural model transactions invalidate only their member plate.  The
// retained used-slot summary must take the add/delete delta path, and the
// unrelated plate remains a projection cache hit through Undo and Redo.
const added = history('Add Cube', () => call('orc_add_shape', ['string', 'string'], ['Cube', 'history add']));
const addedObjectId = call('orc_get_model_structure').objects.find((object) => object.name === 'history add').id;
read = projection();
assert.equal(read.sample.stages_ms.used_slot_full_scan_fallback, 0, 'add retains usage summaries');
assertCached(read, [first]);
for (const direction of ['undo', 'redo']) {
  call(`orc_history_${direction}`);
  read = projection();
  assert.equal(read.sample.stages_ms.used_slot_full_scan_fallback, 0, `${direction} add retains usage summaries`);
  assertCached(read, [first]);
}
history('Delete Cube', () => call('orc_delete_objects', ['string'], [JSON.stringify([addedObjectId])]));
read = projection();
assert.equal(read.sample.stages_ms.used_slot_full_scan_fallback, 0, 'delete retains usage summaries');
assertCached(read, [first]);
for (const direction of ['undo', 'redo']) {
  call(`orc_history_${direction}`);
  read = projection();
  assert.equal(read.sample.stages_ms.used_slot_full_scan_fallback, 0, `${direction} delete retains usage summaries`);
  assertCached(read, [first]);
}

// Plate selection must not invalidate derived geometry or advance input stamps.
const beforeSelection = snapshot().input_revisions;
call('orc_select_plate', ['string'], [first]);
assert.deepEqual(snapshot().input_revisions, beforeSelection);
assertCached(projection(), [first, second]);
const entry = call('orc_get_model_mesh').renderables.find((item) => item.object_idx === 0);
const home = [...entry.instance_transform.offset];

// A committed ordinary in-plate translation advances the authoritative stamp.
// This is deliberately the path that has no bespoke geometry/cache eviction.
move(entry, [home[0] + 1, home[1], home[2]]);
read = projection();
assert.equal(read.tower(first).eligible, true);
assert.ok(read.sample.per_plate_stages_ms[0].total > 0, 'new input stamp must be evaluated');
assert.equal(read.sample.stages_ms.used_slot_full_scan_fallback, 0, 'translation retains usage summaries');
assertCached(read, [second]);
assertCached(projection(), [first, second]);

// Cancelling a detached job, including its eventual terminal cleanup, must
// retain input-derived caches. A following move still reuses usage summaries.
if (call('orc_get_threading_info').threaded) {
  const current = snapshot();
  const accepted = call('orc_slice_plate', ['string', 'string', 'number'],
    ['{}', first, current.input_revisions[first]]);
  call('orc_cancel');
  assertCached(projection(), [first, second]);
  const terminal = await awaitAsyncTask((name, types, args) => call(name, types, args), accepted);
  assert.equal(terminal.error, 'slice cancelled');
  assertCached(projection(), [first, second]);
  move(entry, [home[0] + 2, home[1], home[2]]);
  read = projection();
  assert.equal(read.sample.stages_ms.used_slot_full_scan_fallback, 0, 'cancelled slice retains usage summaries');
  assertCached(read, [second]);
  move(entry, home);
  projection();
}

move(entry, [10000, 10000, home[2]]);
read = projection();
assert.equal(read.tower(first).eligible, false, 'last object outside bed hides tower');
assert.equal(read.tower(first).empty, true);
assert.equal(read.tower(first).height, 0);
assertCached(read, [second]);
move(entry, home);
read = projection();
assert.equal(read.tower(first).eligible, true, 'returning object restores tower');
assert.deepEqual(read.tower(first).used_slots, [1]);
assertCached(read, [second]);

// Configuration and structural changes use the same projection read contract.
project('enable_prime_tower', '0');
assert.ok(projection().result.plates.every((plate) => !plate.eligible));
project('enable_prime_tower', '1');
assert.ok(projection().result.plates.every((plate) => plate.eligible));
call('orc_reorder_plates', ['string'], [JSON.stringify([second, first])]);
read = projection();
assert.deepEqual(read.result.plates.map((plate) => [plate.plate_id, plate.display_index]), [[second, 0], [first, 1]]);
assert.ok(read.result.plates.every((plate) => plate.eligible));
assertCached(projection(), [first, second]);

const object = call('orc_get_model_structure').objects.find((item) => item.index === 0);
call('orc_delete_objects', ['string'], [JSON.stringify([object.id])]);
read = projection();
assert.equal(read.tower(first).eligible, false, 'deleting final object hides tower');
assert.equal(read.tower(first).empty, true);
assert.equal(read.tower(second).eligible, true);
assertCached(projection(), [first, second]);
console.log(JSON.stringify({ ok: true, cases: ['selection', 'structural-history', 'stamp-change', 'outside', 'return', 'configuration', 'reorder', 'delete'],
  unrelatedPlateRecomputedDuringMoves: false, fullUsedSlotScansDuringTranslation: 0 }));
