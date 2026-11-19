import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';
import { buildIndependentReader3mf } from './multi-filament-fixture-builder.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';

const factory = await loadModuleFactory(process.argv[2]);
const module = await factory({ noInitialRun: true, print: () => {}, printErr: console.error });
await installProfilePackages(module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(pointer)); }
  finally { module._free(pointer); }
}
function ok(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
function begin(label) {
  return ok(call('orc_history_begin', ['string', 'string', 'string', 'string'], [label, 'project', JSON.stringify(context), ''])).transactionId;
}
function commit(id) {
  const result = call('orc_history_commit', ['string', 'string'], [id, JSON.stringify(context)]);
  assert.ok(result.status, JSON.stringify(result));
  return result;
}
function edit(label, fn) { const tx = begin(label); const result = ok(fn()); commit(tx); return result; }
function load(bytes) {
  const pointer = Number(module._malloc(bytes.length));
  module.HEAPU8.set(bytes, pointer);
  try { ok(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [pointer, bytes.length, 0, 'auto-drop-split.3mf'])); }
  finally { module._free(pointer); }
  call('orc_history_reset', ['string'], [JSON.stringify(context)]);
}
function fixture(autoDrop) {
  const entries = readZipEntries(buildIndependentReader3mf());
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const projectEntry = entries.find((entry) => entry.name === 'Metadata/project_settings.config');
  const project = JSON.parse(decoder.decode(projectEntry.content));
  Object.assign(project, { filament_multi_colour: ['', ''], filament_colour_type: ['RGB', 'RGB'],
    filament_map: ['1', '1'], filament_volume_map: ['0', '0'], filament_nozzle_map: ['0', '0'],
    filament_map_2: ['1', '1'], filament_self_index: ['0', '0'], filament_extruder_variant: ['0', '0'] });
  projectEntry.content = encoder.encode(JSON.stringify(project));
  const modelEntry = entries.find((entry) => entry.name === '3D/3dmodel.model');
  let model = decoder.decode(modelEntry.content);
  const vertices = model.match(/<vertices>([\s\S]*?)<\/vertices>/)[1];
  const triangles = model.match(/<triangles>([\s\S]*?)<\/triangles>/)[1];
  const upper = vertices.replace(/x="([^"]+)"/g, (_match, x) => `x="${Number(x) + 30}"`)
    .replace(/z="([^"]+)"/g, (_match, z) => `z="${Number(z) + 15}"`);
  model = model.replace(vertices, vertices + upper).replace(triangles, triangles + triangles.replace(/v([123])="(\d+)"/g,
    (_match, axis, index) => `v${axis}="${Number(index) + 8}"`));
  const items = [100, 150].map((x) => `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${x} 100 10" printable="1"/>`);
  modelEntry.content = encoder.encode(model.replace(/<build>[\s\S]*?<\/build>/, `<build>${items.join('')}</build>`));
  const settings = entries.find((entry) => entry.name === 'Metadata/model_settings.config');
  settings.content = encoder.encode(decoder.decode(settings.content)
    .replace('<object id="1">', `<object id="1" auto_drop="${autoDrop ? 1 : 0}">`)
    .replace('</model_instance>', '</model_instance><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="1"/><metadata key="identify_id" value="2"/></model_instance>'));
  return writeStoredZip(entries);
}

// Compute minimum Z from the actual exported native mesh and both transforms.
function modelMinima() {
  const result = ok(call('orc_get_model_mesh'));
  try {
    const geometries = new Map(result.geometries.map((geometry) => [geometry.volume_id, geometry]));
    return result.renderables.map((body) => {
      const geometry = geometries.get(body.volume_id);
      const vertices = new Float32Array(module.HEAPU8.buffer, geometry.vertex_ptr, geometry.vertex_count * 3);
      const volume = body.volume_transform.matrix, instance = body.instance_transform.matrix;
      let min = Infinity;
      for (let i = 0; i < vertices.length; i += 3) {
        const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
        const vx = volume[0] * x + volume[4] * y + volume[8] * z + volume[12];
        const vy = volume[1] * x + volume[5] * y + volume[9] * z + volume[13];
        const vz = volume[2] * x + volume[6] * y + volume[10] * z + volume[14];
        min = Math.min(min, instance[2] * vx + instance[6] * vy + instance[10] * vz + instance[14]);
      }
      return { objectId: body.object_id, instanceId: body.instance_id, min };
    });
  } finally {
    for (const geometry of [...result.geometries, ...result.paint_geometries]) {
      if (geometry.vertex_ptr) module._free(geometry.vertex_ptr);
      if (geometry.index_ptr) module._free(geometry.index_ptr);
    }
  }
}
function objectState() {
  const minima = modelMinima();
  return ok(call('orc_get_model_structure')).objects.map((object) => ({ autoDrop: object.autoDrop,
    minima: object.instances.map((instance) => Math.min(...minima.filter((item) => item.instanceId === instance.id).map((item) => item.min)))
      .sort((a, b) => a - b) })).sort((a, b) => a.minima[0] - b.minima[0]);
}
function approx(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`); }

ok(call('orc_init', ['string'], [fixtureProfileOptions(module)]));
for (const [sourceEnabled, disableAutoDrop] of [[true, true], [true, false], [false, false]]) {
  load(fixture(sourceEnabled));
  const source = ok(call('orc_get_model_structure')).objects[0];
  assert.equal(source.instances.length, 2);
  const other = edit('Add unrelated', () => call('orc_add_shape', ['string', 'string'], ['Cube', 'Unrelated']));
  const unrelated = ok(call('orc_get_model_structure')).objects.find((object) => object.id !== source.id);
  assert.ok(other.ok && unrelated);
  const mesh = ok(call('orc_get_model_mesh'));
  const otherBody = mesh.renderables.find((body) => body.object_id === unrelated.id);
  const moved = structuredClone(otherBody.instance_transform);
  moved.offset[2] -= 30; moved.matrix[14] -= 30;
  const request = { objectIdx: otherBody.object_idx, volumeIdx: otherBody.volume_idx, instanceIdx: otherBody.instance_idx,
    instanceTransform: moved, volumeTransform: otherBody.volume_transform };
  for (const geometry of [...mesh.geometries, ...mesh.paint_geometries]) {
    if (geometry.vertex_ptr) module._free(geometry.vertex_ptr);
    if (geometry.index_ptr) module._free(geometry.index_ptr);
  }
  const moveTx = begin('Sink unrelated');
  ok(call('orc_set_model_transforms', ['string', 'string', 'string'], [moveTx, JSON.stringify([request]), 'direct']));
  commit(moveTx);
  const before = objectState();
  const open = begin('Uncommitted edit');
  const blocked = call('orc_preview_split_object', ['number'], [source.id]);
  assert.equal(blocked.ok, false); assert.match(blocked.error, /active history/);
  ok(call('orc_history_abort', ['string'], [open]));
  const preview = ok(call('orc_preview_split_object', ['number'], [source.id]));
  assert.equal(preview.autoDrop, sourceEnabled);
  assert.equal(preview.floating, true);
  assert.deepEqual(objectState(), before);
  assert.equal(call('orc_history_status').revision, preview.revision);
  edit('Rename unrelated', () => call('orc_rename_object', ['number', 'string'], [unrelated.id, 'Still unrelated']));
  const staleTx = begin('Reject stale split');
  const stale = call('orc_split_object_to_objects', ['number', 'number', 'number'], [source.id, Number(disableAutoDrop), preview.revision]);
  assert.equal(stale.ok, false); assert.match(stale.error, /stale/);
  ok(call('orc_history_abort', ['string'], [staleTx]));
  assert.deepEqual(objectState(), before);
  const fresh = ok(call('orc_preview_split_object', ['number'], [source.id]));
  const split = edit('Split to objects', () => call('orc_split_object_to_objects', ['number', 'number', 'number'],
    [source.id, Number(disableAutoDrop), fresh.revision]));
  assert.equal(split.newObjectIds.length, 2);
  const splitObjects = ok(call('orc_get_model_structure')).objects.filter((object) => split.newObjectIds.includes(object.id));
  assert.deepEqual(splitObjects.map((object) => object.autoDrop), [sourceEnabled && !disableAutoDrop, sourceEnabled && !disableAutoDrop]);
  assert.deepEqual(splitObjects.map((object) => object.instances.length), [2, 2]);
  const after = objectState();
  approx(after[0].minima[0], before[0].minima[0]); // unrelated sunk object
  const expected = sourceEnabled && !disableAutoDrop ? [0, 0] : [0, 15];
  for (let i = 0; i < 2; ++i) for (const value of after[i + 1].minima) approx(value, expected[i]);
  ok(call('orc_history_undo'));
  assert.equal(ok(call('orc_get_model_structure')).objects.find((object) => object.id === source.id).autoDrop, sourceEnabled);
  ok(call('orc_history_redo'));
  assert.deepEqual(objectState(), after);
  const exported = ok(call('orc_export_project', ['string'], ['{}']));
  const bytes = module.HEAPU8.slice(exported.bytes_ptr, exported.bytes_ptr + exported.bytes_length);
  module._free(exported.bytes_ptr);
  load(bytes);
  const reloaded = objectState();
  assert.equal(reloaded.length, after.length);
  for (let i = 0; i < after.length; ++i) {
    assert.equal(reloaded[i].autoDrop, after[i].autoDrop);
    assert.equal(reloaded[i].minima.length, after[i].minima.length);
    for (let j = 0; j < after[i].minima.length; ++j) approx(reloaded[i].minima[j], after[i].minima[j]);
  }
}
console.log('auto-drop split, multi-instance, stale preview, history and 3MF PASS');
process.exit(0);
