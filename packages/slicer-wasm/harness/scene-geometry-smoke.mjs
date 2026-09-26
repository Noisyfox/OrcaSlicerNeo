import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { buildIndependentReader3mf } from './multi-filament-fixture-builder.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';

const profiles = resolve(import.meta.dirname, '../../profile-resources/dist');
const factory = await loadModuleFactory(process.argv[2]);
const module = await factory({ noInitialRun: true, print: () => {}, printErr: console.error });
await installProfilePackages(module, createNodeProfileSource(profiles));
function call(name, types = [], args = []) {
  const pointer = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(pointer)); }
  finally { module._free(pointer); }
}
function paintFacetDecodeCount() {
  const result = call('orc_test_get_model_paint_decode_count');
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.paint_facet_decode_count;
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
function freeGeometryBuffers(result) {
  const pointers = new Set();
  for (const list of [result.geometries, result.paint_geometries]) {
    if (!Array.isArray(list)) continue;
    for (const geometry of list) {
      if (!geometry || typeof geometry !== 'object') continue;
      for (const pointer of [geometry.vertex_ptr, geometry.index_ptr])
        if (Number.isSafeInteger(Number(pointer)) && Number(pointer) > 0) pointers.add(Number(pointer));
    }
  }
  for (const pointer of pointers) module._free(pointer);
}
function patch(ids, known = [], knownPaint = []) {
  const result = call('orc_get_model_scene_patch', ['string'],
    [JSON.stringify({ object_ids: ids, known_volume_ids: known, known_paint_keys: knownPaint })]);
  try { assert.equal(result.ok, true, JSON.stringify(result)); }
  finally { freeGeometryBuffers(result); }
  return result;
}
function fullModel() {
  const result = call('orc_get_model_mesh');
  try { assert.equal(result.ok, true, JSON.stringify(result)); }
  finally { freeGeometryBuffers(result); }
  return result;
}
function paintedSplitFixture() {
  const entries = readZipEntries(buildIndependentReader3mf());
  const modelEntry = entries.find((entry) => entry.name === '3D/3dmodel.model');
  assert.ok(modelEntry, 'paint fixture must contain its 3MF model');
  const source = new TextDecoder().decode(modelEntry.content);
  // 401 encodes a split root (side nibble 1) followed by state 0 and state 1 children.
  const states = ['401', '', '4', '8', '0C', '1C', '4', '8', '0C', '1C', '4', '8'];
  let triangle = 0;
  const model = source.replace(/<triangle\b[^>]*\/>/g, (original) => {
    const state = states[triangle++];
    return state ? original.replace('/>', ` paint_color="${state}"/>`) : original;
  });
  assert.equal(triangle, states.length, 'paint fixture must annotate each cube facet deterministically');
  return writeStoredZip(entries.map((entry) => entry.name === modelEntry.name
    ? { ...entry, content: new TextEncoder().encode(model) }
    : entry));
}
assert.equal(call('orc_init', ['string'], ['{"log_level":"error"}']).ok, true);
call('orc_history_reset', ['string'], [JSON.stringify(context)]);
const added = edit('Cube', () => call('orc_add_shape', ['string', 'string'], ['Cube', 'Cube']));
assert.equal(added.scene_delta.object_ids.length, 1);
const objectId = added.scene_delta.object_ids[0];
const first = patch([objectId]);
assert.equal(first.geometries.length, 1);
assert.equal(first.renderables[0].paint_key, null);
assert.equal(first.paint_geometries.length, 0);
assert.equal(paintFacetDecodeCount(), 0, 'an unpainted volume must skip native facet reconstruction');
const unpaintedFull = fullModel();
assert.equal(unpaintedFull.renderables[0].paint_key, null);
assert.equal(unpaintedFull.paint_geometries.length, 0);
assert.equal(paintFacetDecodeCount(), 0, 'full model loading must also skip native facet reconstruction');
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

const paintedFixture = paintedSplitFixture();
const projectPtr = module._malloc(paintedFixture.length);
module.HEAPU8.set(paintedFixture, projectPtr);
let importedPaintFixture;
try {
  importedPaintFixture = call('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [projectPtr, paintedFixture.length, 0, 'painted-facet-fixture.3mf']);
} finally {
  module._free(projectPtr);
}
assert.equal(importedPaintFixture.ok, true, JSON.stringify(importedPaintFixture));
const paintedFull = fullModel();
const paintedResource = paintedFull.paint_geometries[0];
assert.ok(paintedResource, `the imported 3MF fixture must expose native MMU paint geometry: ${JSON.stringify({
  load: { ok: importedPaintFixture.ok, object_count: importedPaintFixture.object_count },
  renderables: paintedFull.renderables.map(({ object_id, volume_id, paint_key }) => ({ object_id, volume_id, paint_key })),
  originalVolumes: paintedFull.geometries.map(({ volume_id, index_count }) => ({ volume_id, index_count })),
  paintCount: paintedFull.paint_geometries.length,
})}`);
assert.equal(paintFacetDecodeCount(), 1, 'initial paint load must build native split facets once');
const paintedStates = paintedResource.draw_groups.map((group) => group.state_id);
assert.ok(paintedStates.includes(0), 'paint geometry must retain the unpainted state 0 group');
assert.ok(paintedStates.some((state) => state > 0), 'paint geometry must contain a positive filament state');
const originalResource = paintedFull.geometries.find((geometry) => geometry.volume_id === paintedResource.volume_id);
assert.ok(originalResource, 'paint geometry must identify the same volume as its original mesh');
assert.ok(paintedResource.index_count > originalResource.index_count,
  'native facet restoration must split at least one source triangle');
const paintedRenderable = paintedFull.renderables.find((entry) => entry.paint_key === paintedResource.paint_key);
assert.ok(paintedRenderable, 'renderables must reference their paint resource version');
assert.ok(paintedRenderable.paint_key.includes(':'), 'paint version key must be independent of the original volume key');

assert.equal(call('orc_add_instance', ['number'], [paintedRenderable.object_id]).ok, true);
const paintedInstances = patch([paintedRenderable.object_id]);
const samePaintInstances = paintedInstances.renderables.filter((entry) =>
  entry.volume_id === paintedResource.volume_id && entry.paint_key === paintedResource.paint_key);
assert.ok(samePaintInstances.length >= 2, 'multiple instances of one painted volume must share its paint key');
assert.equal(paintedInstances.paint_geometries.filter((entry) => entry.volume_id === paintedResource.volume_id).length, 1,
  'one painted model volume must produce one paint geometry allocation');

const originalKnown = patch([paintedRenderable.object_id], [paintedResource.volume_id]);
assert.equal(originalKnown.geometries.some((geometry) => geometry.volume_id === paintedResource.volume_id), false);
assert.equal(originalKnown.paint_geometries.filter((geometry) => geometry.volume_id === paintedResource.volume_id).length, 1,
  'a retained original mesh must not suppress a missing paint resource');
const paintKnown = patch([paintedRenderable.object_id], [], [paintedResource.paint_key]);
assert.equal(paintKnown.geometries.filter((geometry) => geometry.volume_id === paintedResource.volume_id).length, 1,
  'a retained paint resource must not suppress a missing original mesh');
assert.equal(paintKnown.paint_geometries.some((geometry) => geometry.volume_id === paintedResource.volume_id), false);
assert.equal(paintFacetDecodeCount(), 3,
  'a retained paint key must skip native facet reconstruction while the original mesh is requested');

console.log('PASS no-paint/cached-key decode fast paths, split MMU paint groups, multi-instance dedup, independent resource reuse, Undo/Redo');
process.exit(0);
