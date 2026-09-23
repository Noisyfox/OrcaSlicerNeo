import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';

const profiles = resolve(import.meta.dirname, '../../profile-resources/dist');
const factory = await loadModuleFactory(process.argv[2]);
const module = await factory({ noInitialRun: true, print: () => {}, printErr: console.error });
await installProfilePackages(module, createNodeProfileSource(profiles));
function call(name, types = [], args = []) {
  const pointer = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(pointer)); }
  finally { module._free(pointer); }
}
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
function begin(label, parent) {
  const result = call('orc_history_begin', ['string', 'string', 'string', 'string'],
    [label, 'project', JSON.stringify(context), parent ? JSON.stringify({ coalesce: true, parentTransactionId: parent }) : '']);
  assert.ok(result.transactionId, JSON.stringify(result));
  return result.transactionId;
}
function commit(id) {
  const result = call('orc_history_commit', ['string', 'string'], [id, JSON.stringify(context)]);
  assert.ok(result.status, JSON.stringify(result));
  return result;
}
function edit(label, operation) {
  const id = begin(label);
  const result = operation();
  assert.equal(result.ok, true, JSON.stringify(result));
  return { result, ...commit(id) };
}
function patch(ids, known = []) {
  const result = call('orc_get_model_scene_patch', ['string'],
    [JSON.stringify({ object_ids: ids, known_volume_ids: known })]);
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const geometry of result.geometries) {
    module._free(Number(geometry.vertex_ptr));
    module._free(Number(geometry.index_ptr));
  }
  return result;
}
assert.equal(call('orc_init', ['string'], ['{"log_level":"error"}']).ok, true);
call('orc_history_reset', ['string'], [JSON.stringify(context)]);
const added = edit('Cube', () => call('orc_add_shape', ['string', 'string'], ['Cube', 'Cube']));
assert.equal(added.scene_delta.object_ids.length, 1);
const objectId = added.scene_delta.object_ids[0];
const first = patch([objectId]);
assert.equal(first.geometries.length, 1);
const volumeId = first.geometries[0].volume_id;
assert.equal(patch([objectId], [volumeId]).geometries.length, 0);
const second = edit('Second cube', () => call('orc_add_shape', ['string', 'string'], ['Cube', 'Second']));
assert.deepEqual(second.scene_delta.object_ids, second.scene_delta.object_order.filter((id) => id !== objectId));
assert.equal(patch(second.scene_delta.object_ids, [volumeId]).renderables.length, 1);

const many = edit('Instances', () => {
  for (let i = 0; i < 100; ++i) assert.equal(call('orc_add_instance', ['number'], [objectId]).ok, true);
  return { ok: true };
});
assert.deepEqual(many.scene_delta.object_ids, [objectId]);
const instancePatch = patch(many.scene_delta.object_ids, [volumeId]);
assert.equal(instancePatch.renderables.length, 101);
assert.equal(instancePatch.geometries.length, 0);
assert.equal(instancePatch.objects.length, 1);
const renamed = edit('Rename', () => call('orc_rename_object', ['number', 'string'], [objectId, 'Renamed']));
assert.deepEqual(renamed.scene_delta.object_ids, [objectId]);
assert.ok(renamed.scene_delta.volume_ids.includes(volumeId));
assert.equal(patch(renamed.scene_delta.object_ids, [volumeId]).geometries.length, 0);

const sourceInstance = instancePatch.renderables[1].instance_id;
const separated = edit('Separate', () => call('orc_instances_to_separate_objects', ['number', 'string'],
  [objectId, JSON.stringify([sourceInstance])]));
const separatedId = separated.result.newObjectIds[0];
const separatePatch = patch([separatedId], [volumeId]);
assert.equal(separatePatch.geometries.length, 1);
assert.notEqual(separatePatch.geometries[0].volume_id, volumeId);
assert.notEqual(separatePatch.renderables[0].instance_id, sourceInstance);
const structure = call('orc_get_model_structure').objects;
const volumeIds = structure.flatMap((object) => object.volumes.map((volume) => volume.id));
assert.equal(new Set(volumeIds).size, volumeIds.length);
assert.equal(call('orc_history_undo').ok, true);
const undone = call('orc_get_model_structure').objects;
assert.ok(undone.find((object) => object.id === objectId).instances.some((instance) => instance.id === sourceInstance));
assert.equal(call('orc_history_redo').ok, true);
assert.equal(patch([separatedId]).geometries[0].volume_id, separatePatch.geometries[0].volume_id);

assert.equal(commit(begin('No op')).scene_delta, null);
const outer = begin('Outer');
const inner = begin('Inner', outer);
call('orc_rename_object', ['number', 'string'], [objectId, 'Nested']);
assert.equal(commit(inner).scene_delta, null);
assert.deepEqual(commit(outer).scene_delta.object_ids, [objectId]);
console.log('PASS committed deltas, targeted descriptions, 101-instance zero-buffer reuse, native separation IDs, Undo/Redo, nested and no-op');
process.exit(0);
