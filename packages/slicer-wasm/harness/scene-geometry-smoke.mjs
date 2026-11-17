import { fixtureProfileOptions } from './profile-installer.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
function paintResourceHashCount() {
  const result = call('orc_test_get_model_paint_decode_count');
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.paint_resource_hash_count;
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
assert.equal(call('orc_init', ['string'], [fixtureProfileOptions(module)]).ok, true);
call('orc_history_reset', ['string'], [JSON.stringify(context)]);
const added = edit('Cube', () => call('orc_add_shape', ['string', 'string'], ['Cube', 'Cube']));
assert.equal(added.scene_delta.object_ids.length, 1);
const objectId = added.scene_delta.object_ids[0];
assert.equal(call('orc_get_model_scene_patch', ['string'],
  [JSON.stringify({ object_ids: [objectId], known_volume_ids: [] })]).ok, false,
'scene patch requests must explicitly include known_paint_keys');
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

const paintedFixtureDir = resolve(import.meta.dirname, '../fixtures/painted-facet');
const paintedFixtureManifest = JSON.parse(await readFile(resolve(paintedFixtureDir, 'manifest.json'), 'utf8'));
const paintedFixture = new Uint8Array(await readFile(resolve(paintedFixtureDir, paintedFixtureManifest.path)));
const projectPtr = module._malloc(paintedFixture.length);
module.HEAPU8.set(paintedFixture, projectPtr);
let importedPaintFixture;
try {
  importedPaintFixture = call('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [projectPtr, paintedFixture.length, 0, 'painted-facet-instances.3mf']);
} finally {
  module._free(projectPtr);
}
assert.equal(importedPaintFixture.ok, true, JSON.stringify(importedPaintFixture));
assert.equal(importedPaintFixture.mode, 'project', 'the fixture must take the full project load path');
const paintedPlateSession = call('orc_get_plate_session_snapshot');
assert.equal(paintedPlateSession.ok, true, JSON.stringify(paintedPlateSession));
const paintedPlate = paintedPlateSession.plates.find((plate) => plate.plate_id === paintedPlateSession.current_plate_id);
assert.ok(paintedPlate, 'painted fixture must restore its current plate');
assert.equal(paintedPlate.instance_ids.length, 2, 'painted fixture must restore both placed instances');
assert.deepEqual(paintedPlate.out_of_bounds_instance_ids, [],
  'both painted fixture instances must start inside the positive-coordinate H2D bed');
const paintedFull = fullModel();
const paintedResource = paintedFull.paint_geometries[0];
assert.ok(paintedResource, `the imported 3MF fixture must expose native MMU paint geometry: ${JSON.stringify({
  load: { ok: importedPaintFixture.ok, object_count: importedPaintFixture.object_count },
  renderables: paintedFull.renderables.map(({ object_id, volume_id, paint_key }) => ({ object_id, volume_id, paint_key })),
  originalVolumes: paintedFull.geometries.map(({ volume_id, index_count }) => ({ volume_id, index_count })),
  paintCount: paintedFull.paint_geometries.length,
})}`);
assert.equal(paintedFull.renderables.length, 2,
  'the imported project must load both instances of its painted model');
assert.equal(paintFacetDecodeCount(), 1, 'initial paint load must build native split facets once');
const initialPaintHashCount = paintResourceHashCount();
const paintedStates = paintedResource.draw_groups.map((group) => group.state_id);
assert.deepEqual([...new Set(paintedStates)].sort((a, b) => a - b), paintedFixtureManifest.expected.paintStates,
  'native imported paint groups must match the fixture manifest');
assert.ok(paintedStates.includes(0), 'paint geometry must retain the unpainted state 0 group');
assert.ok(paintedStates.some((state) => state > 0), 'paint geometry must contain a positive filament state');
const originalResource = paintedFull.geometries.find((geometry) => geometry.volume_id === paintedResource.volume_id);
assert.ok(originalResource, 'paint geometry must identify the same volume as its original mesh');
assert.ok(paintedResource.index_count > originalResource.index_count,
  'native facet restoration must split at least one source triangle');
const paintedRenderable = paintedFull.renderables.find((entry) => entry.paint_key === paintedResource.paint_key);
assert.ok(paintedRenderable, 'renderables must reference their paint resource version');
assert.ok(paintedRenderable.paint_key.includes(':'), 'paint version key must be independent of the original volume key');
assert.equal(new Set(paintedFull.renderables.map((entry) => entry.instance_id)).size, 2,
  'two imported instances must retain distinct instance identities');

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
assert.equal(paintResourceHashCount(), initialPaintHashCount,
  'unchanged scene reads must reuse the paint key without hashing source mesh or facet bits');

const filamentBeforeRemap = call('orc_get_filament_session_snapshot');
const deletedPaintSlot = call('orc_delete_filament_slot', ['string'],
  [JSON.stringify({ version: 1, revision: filamentBeforeRemap.revisions.session, slot: 2 })]);
assert.equal(deletedPaintSlot.ok, true, JSON.stringify(deletedPaintSlot));
const deletedPaint = patch([paintedRenderable.object_id], [paintedResource.volume_id], [paintedResource.paint_key]);
const deletedPaintKey = deletedPaint.renderables.find((entry) => entry.volume_id === paintedResource.volume_id).paint_key;
assert.notEqual(deletedPaintKey, paintedResource.paint_key, 'slot deletion must publish a new paint key');
assert.equal(deletedPaint.geometries.length, 0, 'slot remap must retain the original source mesh');
const deletedUndo = call('orc_history_undo');
assert.equal(deletedUndo.ok, true, JSON.stringify(deletedUndo));
assert.ok(deletedUndo.scene_delta.object_ids.includes(paintedRenderable.object_id));
assert.equal(patch([paintedRenderable.object_id], [paintedResource.volume_id]).renderables[0].paint_key,
  paintedResource.paint_key, 'Undo must restore the original paint version');
const deletedRedo = call('orc_history_redo');
assert.equal(deletedRedo.ok, true, JSON.stringify(deletedRedo));
assert.equal(patch([paintedRenderable.object_id], [paintedResource.volume_id]).renderables[0].paint_key,
  deletedPaintKey, 'Redo must restore the deleted-slot paint version');

// auto_drop moved from instances to objects in Orca 2.5. Observe the actual
// persisted field through the production 3MF writer, without a test-only ABI.
function assertSavedAutoDrop(expectedCount, autoDrop) {
  const exported = call('orc_export_project', ['string'], ['{}']);
  assert.equal(exported.ok, true, JSON.stringify(exported));
  const bytes = module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + exported.bytes_length);
  module._free(Number(exported.bytes_ptr));
  const settings = readZipEntries(bytes).find(entry => entry.name === 'Metadata/model_settings.config');
  assert.ok(settings);
  const objects = new TextDecoder().decode(settings.content).match(/<object\b[^>]*>/g) ?? [];
  assert.equal(objects.length, expectedCount);
  for (const object of objects) assert.match(object, new RegExp(`\\bauto_drop="${autoDrop}"`));
}

for (const allEnabled of [false, true]) {
  loadAutoDropFixture(readZipEntries(buildIndependentReader3mf()));
  const source = call('orc_get_model_structure').objects[0];
  const firstClone = edit('Clone first', () => call('orc_clone_objects', ['string'], [JSON.stringify([source.id])])).result.newObjectIds[0];
  const unrelated = edit('Clone unrelated', () => call('orc_clone_objects', ['string'], [JSON.stringify([source.id])])).result.newObjectIds[0];
  if (!allEnabled) edit('Disable source Auto Drop', () => call('orc_set_objects_auto_drop', ['string', 'number'],
    [JSON.stringify([firstClone]), 0]));
  const ids = [source.id, firstClone];
  const requests = fullModel().renderables.filter((body) => ids.includes(body.object_id)).map((body, index) => {
    const transform = structuredClone(body.instance_transform);
    transform.offset[2] += 5 + index * 5;
    transform.matrix[14] += 5 + index * 5;
    return { objectIdx: body.object_idx, volumeIdx: body.volume_idx, instanceIdx: body.instance_idx,
      instanceTransform: transform, volumeTransform: body.volume_transform };
  });
  const tx = begin('Raise assembly sources');
  assert.equal(call('orc_set_model_transforms', ['string', 'string', 'string'], [tx, JSON.stringify(requests), 'direct']).ok, true);
  commit(tx);
  const before = fullModel().renderables;
  const worldHeights = (items) => items.map((body) => body.instance_transform.matrix[14] + body.volume_transform.matrix[14]).sort((a, b) => a - b);
  const oldHeights = worldHeights(before.filter((body) => ids.includes(body.object_id)));
  const otherZ = before.find((body) => body.object_id === unrelated).instance_transform.offset[2];
  const merged = edit('Assemble Auto Drop', () => call('orc_merge_objects_to_multipart', ['string', 'string'],
    [JSON.stringify(ids.map(id => ({ objectId: id, instanceIds: call('orc_get_model_structure').objects.find(object => object.id === id).instances.map(instance => instance.id) }))), 'Assembly'])).result;
  assert.equal(call('orc_get_model_structure').objects.find((object) => object.id === merged.objectId).autoDrop, allEnabled);
  const after = fullModel().renderables;
  const heights = worldHeights(after.filter((body) => body.object_id === merged.objectId));
  const shift = allEnabled ? 10 - oldHeights[0] : 0;
  assert.ok(heights.every((height, index) => Math.abs(height - oldHeights[index] - shift) < 1e-8));
  assert.equal(after.find((body) => body.object_id === unrelated).instance_transform.offset[2], otherZ);
  const exported = call('orc_export_project', ['string'], ['{}']);
  assert.equal(exported.ok, true);
  const bytes = module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + exported.bytes_length);
  module._free(Number(exported.bytes_ptr));
  const settings = readZipEntries(bytes).find((entry) => entry.name === 'Metadata/model_settings.config');
  const flags = [...new TextDecoder().decode(settings.content).matchAll(/<object\b[^>]*\bauto_drop="([01])"/g)]
    .map((match) => Number(match[1])).sort();
  assert.deepEqual(flags, [allEnabled ? 1 : 0, 1]);
  assert.equal(call('orc_history_undo').ok, true);
  assert.deepEqual(call('orc_get_model_structure').objects.filter((object) => ids.includes(object.id)).map((object) => object.autoDrop), [true, allEnabled]);
  assert.equal(call('orc_history_redo').ok, true);
  assert.equal(call('orc_get_model_structure').objects.find((object) => object.id === merged.objectId).autoDrop, allEnabled);
}
function loadAutoDropFixture(entries) {
  // The minimal reader asset omits some per-slot arrays. Like the painted
  // fixture, materialize its two-slot shape before exercising strict history
  // restore; this test varies auto_drop, not imported filament cardinality.
  const projectEntry = entries.find(entry => entry.name === 'Metadata/project_settings.config');
  const project = JSON.parse(new TextDecoder().decode(projectEntry.content));
  assert.equal(project.filament_settings_id.length, 2);
  Object.assign(project, {
    filament_multi_colour: ['', ''], filament_colour_type: ['RGB', 'RGB'],
    filament_map: ['1', '1'], filament_volume_map: ['0', '0'], filament_nozzle_map: ['0', '0'],
    filament_map_2: ['1', '1'], filament_self_index: ['0', '0'], filament_extruder_variant: ['0', '0'],
  });
  projectEntry.content = new TextEncoder().encode(JSON.stringify(project));
  const fixture = writeStoredZip(entries);
  const pointer = Number(module._malloc(fixture.length));
  module.HEAPU8.set(fixture, pointer);
  try {
    const loaded = call('orc_load_project', ['pointer', 'number', 'number', 'string'],
      [pointer, fixture.length, 0, 'split-auto-drop.3mf']);
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
  } finally { module._free(pointer); }
  call('orc_history_reset', ['string'], [JSON.stringify(context)]);
}
// Without new object metadata, the legacy rule applies across all instances:
// any explicit off wins; all on or all missing retain the default on.
for (const legacyValues of [[1, 0], [1, 1], [undefined, undefined]]) {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const entries = readZipEntries(buildIndependentReader3mf());
  const modelEntry = entries.find(entry => entry.name === '3D/3dmodel.model');
  const items = legacyValues.map((value, index) =>
    `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${100 + 30 * index} 100 20" printable="1"${value === undefined ? '' : ` auto_drop="${value}"`}/>`);
  modelEntry.content = encoder.encode(decoder.decode(modelEntry.content)
    .replace(/<build>[\s\S]*?<\/build>/, `<build>${items.join('')}</build>`));
  const settingsEntry = entries.find(entry => entry.name === 'Metadata/model_settings.config');
  settingsEntry.content = encoder.encode(decoder.decode(settingsEntry.content).replace('</model_instance>',
    '</model_instance><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="1"/><metadata key="identify_id" value="2"/></model_instance>'));
  loadAutoDropFixture(entries);
  const object = call('orc_get_model_structure').objects[0];
  assert.equal(object.instances.length, 2,
    'the legacy any-off case must load both build items');
  assert.equal(object.autoDrop, !legacyValues.includes(0));
  assertSavedAutoDrop(1, legacyValues.includes(0) ? 0 : 1);
  if (legacyValues.includes(0)) {
    const before = fullModel().renderables.map(item => item.instance_transform.offset[2]);
    const rejected = call('orc_set_objects_auto_drop', ['string', 'number'], [JSON.stringify([object.id, 99999999]), 1]);
    assert.equal(rejected.ok, false);
    assert.equal(call('orc_get_model_structure').objects[0].autoDrop, false);
    const enabled = edit('Enable Auto Drop', () => call('orc_set_objects_auto_drop', ['string', 'number'],
      [JSON.stringify([object.id]), 1]));
    assert.equal(enabled.result.plate_session.instance_transforms.length, 2);
    const dropped = fullModel().renderables.map(item => item.instance_transform.offset[2]);
    assert.notDeepEqual(dropped, before);
    assert.ok(Math.abs((before[0] - dropped[0]) - (before[1] - dropped[1])) < 1e-8);
    assertSavedAutoDrop(1, 1);
    assert.equal(call('orc_history_undo').ok, true);
    assert.equal(call('orc_get_model_structure').objects[0].autoDrop, false);
    assert.deepEqual(fullModel().renderables.map(item => item.instance_transform.offset[2]), before);
    assertSavedAutoDrop(1, 0);
    assert.equal(call('orc_history_redo').ok, true);
    assert.equal(call('orc_get_model_structure').objects[0].autoDrop, true);
    assert.deepEqual(fullModel().renderables.map(item => item.instance_transform.offset[2]), dropped);

    const copies = fullModel().renderables;
    const requests = copies.map(item => {
      const instance = structuredClone(item.instance_transform);
      instance.offset[2] += 5;
      instance.matrix[14] += 5;
      return { objectIdx: item.object_idx, volumeIdx: item.volume_idx, instanceIdx: item.instance_idx,
        instanceTransform: instance, volumeTransform: structuredClone(item.volume_transform) };
    });
    const conflict = structuredClone(requests);
    conflict[1].volumeTransform.offset[0] += 1;
    conflict[1].volumeTransform.matrix[12] += 1;
    const rejectedTx = begin('Conflicting transforms');
    const rejectedTransform = call('orc_set_model_transforms', ['string', 'string', 'string'],
      [rejectedTx, JSON.stringify(conflict), 'direct']);
    assert.equal(rejectedTransform.ok, false);
    assert.match(rejectedTransform.error, /conflicting/);
    assert.equal(call('orc_history_abort', ['string'], [rejectedTx]).ok, true);
    assert.deepEqual(fullModel().renderables.map(item => item.instance_transform.offset[2]), dropped);
    const syncTx = begin('Synchronize instances');
    assert.equal(call('orc_set_model_transforms', ['string', 'string', 'string'], [syncTx, JSON.stringify(requests), 'direct']).ok, true);
    commit(syncTx);
    const raised = fullModel().renderables.map(item => item.instance_transform.offset[2]);
    assert.deepEqual(raised, dropped.map(z => z + 5));
    assert.equal(call('orc_history_undo').ok, true);
    assert.deepEqual(fullModel().renderables.map(item => item.instance_transform.offset[2]), dropped);
    assert.equal(call('orc_history_redo').ok, true);
    assert.deepEqual(fullModel().renderables.map(item => item.instance_transform.offset[2]), raised);
  }
}
// Exercise settling against native mesh geometry and history, not a mock
// bounding box. The imported fixture is a 20 mm cube resting at Z = 0.
{
  loadAutoDropFixture(readZipEntries(buildIndependentReader3mf()));
  const baseline = fullModel().renderables[0];
  const restZ = baseline.instance_transform.offset[2];
  // A transform must carry the ID of its enclosing history transaction.
  function setZ(z, operation) {
    const body = fullModel().renderables[0];
    const transform = structuredClone(body.instance_transform);
    transform.matrix[14] += z - transform.offset[2];
    transform.offset[2] = z;
    const request = { objectIdx: body.object_idx, volumeIdx: body.volume_idx, instanceIdx: body.instance_idx,
      instanceTransform: transform, volumeTransform: body.volume_transform };
    const tx = begin(`Auto Drop ${operation}`);
    const result = call('orc_set_model_transforms', ['string', 'string', 'string'], [tx, JSON.stringify([request]), operation]);
    assert.equal(result.ok, true, JSON.stringify(result));
    const committed = commit(tx);
    return { result, committed };
  }
  const revision = call('orc_history_status').revision;
  const snapped = setZ(restZ + 5, 'move');
  assert.equal(snapped.result.instance_transforms.length, 1);
  assert.deepEqual(snapped.result.affected_plate_ids, []);
  assert.equal(snapped.committed.status.revision, revision);
  assert.ok(Math.abs(fullModel().renderables[0].instance_transform.offset[2] - restZ) < 1e-8);
  setZ(restZ - 0.0005, 'move');
  assert.ok(Math.abs(fullModel().renderables[0].instance_transform.offset[2] - restZ) < 1e-8);
  setZ(restZ - 0.002, 'move');
  assert.ok(Math.abs(fullModel().renderables[0].instance_transform.offset[2] - (restZ - 0.002)) < 1e-8);
  setZ(restZ - 3, 'rotate');
  assert.ok(Math.abs(fullModel().renderables[0].instance_transform.offset[2] - (restZ - 3)) < 1e-8);
  setZ(restZ + 3, 'scale');
  assert.ok(Math.abs(fullModel().renderables[0].instance_transform.offset[2] - restZ) < 1e-8);
  assert.equal(call('orc_history_undo').ok, true);
  assert.ok(Math.abs(fullModel().renderables[0].instance_transform.offset[2] - (restZ - 3)) < 1e-8);
  assert.equal(call('orc_history_redo').ok, true);
  const object = call('orc_get_model_structure').objects[0];
  edit('Disable Auto Drop', () => call('orc_set_objects_auto_drop', ['string', 'number'], [JSON.stringify([object.id]), 0]));
  setZ(restZ + 5, 'move');
  assert.ok(Math.abs(fullModel().renderables[0].instance_transform.offset[2] - (restZ + 5)) < 1e-8);
}

for (const autoDrop of [0, 1]) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const entries = readZipEntries(buildIndependentReader3mf());
  const modelEntry = entries.find(entry => entry.name === '3D/3dmodel.model');
  let modelXml = decoder.decode(modelEntry.content);
  const vertices = modelXml.match(/<vertices>([\s\S]*?)<\/vertices>/)[1];
  const triangles = modelXml.match(/<triangles>([\s\S]*?)<\/triangles>/)[1];
  assert.equal((vertices.match(/<vertex\b/g) ?? []).length, 8);
  // Two disconnected closed cubes in one volume exercise the native split.
  modelXml = modelXml.replace(vertices, vertices + vertices.replace(/x="([^"]+)"/g,
    (_match, x) => `x="${Number(x) + 30}"`));
  modelXml = modelXml.replace(triangles, triangles + triangles.replace(/v([123])="(\d+)"/g,
    (_match, axis, index) => `v${axis}="${Number(index) + 8}"`));
  // In the on case the new object attribute must override this legacy off.
  modelEntry.content = encoder.encode(modelXml.replace('auto_drop="1"', 'auto_drop="0"'));
  const settingsEntry = entries.find(entry => entry.name === 'Metadata/model_settings.config');
  settingsEntry.content = encoder.encode(decoder.decode(settingsEntry.content)
    .replace('<object id="1">', `<object id="1" auto_drop="${autoDrop}">`));
  loadAutoDropFixture(entries);
  assertSavedAutoDrop(1, autoDrop);
  const source = call('orc_get_model_structure').objects[0];
  assert.equal(source.autoDrop, Boolean(autoDrop));
  assert.equal(source.volumes[0].isSplittable, true);
  const parts = edit('Split parts', () => call('orc_split_volume_to_parts', ['number', 'number', 'number'],
    [source.volumes[0].id, 2, 0]));
  assert.equal(parts.result.parts, 2);
  assertSavedAutoDrop(1, autoDrop);
  const undoParts = call('orc_history_undo');
  assert.equal(undoParts.ok, true, JSON.stringify({ autoDrop, undoParts }));
  const preview = call('orc_preview_split_object', ['number'], [source.id]);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const split = edit('Split objects', () => call('orc_split_object_to_objects', ['number', 'number', 'number'], [source.id, 0, preview.revision]));
  assert.equal(split.result.newObjectIds.length, 2);
  assertSavedAutoDrop(2, autoDrop);
  const undoSplit = call('orc_history_undo');
  assert.equal(undoSplit.ok, true, JSON.stringify({ autoDrop, undoSplit }));
  assertSavedAutoDrop(1, autoDrop);
  const redoSplit = call('orc_history_redo');
  assert.equal(redoSplit.ok, true, JSON.stringify({ autoDrop, redoSplit }));
  assertSavedAutoDrop(2, autoDrop);
}

console.log('PASS no-paint/cached-key decode fast paths, split MMU paint groups, imported multi-instance dedup, independent resource reuse, slot deletion, split auto-drop inheritance, Undo/Redo');
process.exit(0);
