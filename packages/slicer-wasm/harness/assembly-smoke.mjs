// Real-WASM Assemble: native split/merge semantics, attributes and history.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';
import { buildPaintingChannelProject } from './painted-facet-fixture-builder.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: assembly-smoke.mjs <orca_slice.js>');
const module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(pointer)); } finally { module._free(pointer); }
}
const command = (name, request) => call(name, ['string'], [JSON.stringify(request)]);
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const structure = () => ok(call('orc_get_model_structure')).objects;
const config = () => ok(call('orc_get_native_scoped_config')).native_scoped_config.snapshot;
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const decoder = new TextDecoder(), encoder = new TextEncoder();
ok(command('orc_init', JSON.parse(fixtureProfileOptions(module))));
function archive() {
  const result = ok(command('orc_export_project', {}));
  try { return module.HEAPU8.slice(result.bytes_ptr, result.bytes_ptr + result.bytes_length); }
  finally { module._free(result.bytes_ptr); }
}
const entries = bytes => new Map(readZipEntries(bytes).map(entry => [entry.name, decoder.decode(entry.content)]));
function load(bytes) {
  const pointer = Number(module._malloc(bytes.length));
  module.HEAPU8.set(bytes, pointer);
  try { ok(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [pointer, bytes.length, 0, 'assembly.3mf'])); }
  finally { module._free(pointer); }
}
function fixture(bytes, autoDrop) {
  const extras = [
    ['Metadata/layer_config_ranges.xml', '<objects><object id="1"><range min_z="0" max_z="5"><option opt_key="layer_height">0.16</option></range></object></objects>'],
    ['Metadata/layer_heights_profile.txt', 'object_id=1|0;0.12;5;0.16;20;0.2\n'],
    ['Metadata/brim_ear_points.txt', 'brim_points_format_version=0\nobject_id=1|0 0 -10 3\n'],
  ];
  return writeStoredZip([...readZipEntries(bytes).map(entry => entry.name !== '3D/3dmodel.model' ? entry : {
    ...entry, content: encoder.encode(decoder.decode(entry.content).replaceAll('auto_drop="1"', `auto_drop="${autoDrop ? 1 : 0}"`)),
  }), ...extras.map(([name, content]) => ({ name, content: encoder.encode(content) }))]);
}
function paintCounts(object) {
  const historySessionId = ok(command('orc_history_session_open', {})).sessionId;
  const result = {};
  try {
    for (const channel of ['mmu', 'support', 'seam', 'fuzzy']) {
      const session = ok(command('orc_painting_session_open', {
        version: 1, channel, historySessionId, objectId: object.id, instanceId: object.instances[0].id,
      })).session;
      result[channel] = session.parts.map(part => part.facetCounts);
      ok(command('orc_painting_session_close', { version: 1, channel, sessionId: session.id, revision: session.revision }));
    }
  } finally { ok(command('orc_history_session_close', { sessionId: historySessionId })); }
  return result;
}
function worldVertices() {
  const mesh = ok(call('orc_get_model_mesh'));
  const transform = (m, p) => [0, 1, 2].map(axis => m[axis] * p[0] + m[4 + axis] * p[1] + m[8 + axis] * p[2] + m[12 + axis]);
  try {
    return mesh.renderables.flatMap(renderable => {
      const geometry = mesh.geometries.find(item => item.volume_id === renderable.volume_id);
      const vertices = new Float32Array(module.HEAPU8.slice(geometry.vertex_ptr, geometry.vertex_ptr + geometry.vertex_count * 12).buffer);
      return Array.from({ length: geometry.vertex_count }, (_, i) => transform(renderable.instance_transform.matrix,
        transform(renderable.volume_transform.matrix, [...vertices.slice(i * 3, i * 3 + 3)])));
    }).map(point => point.map(v => Math.round(v * 1e5) / 1e5).join(',')).sort();
  } finally {
    for (const geometry of [...mesh.geometries, ...mesh.paint_geometries]) {
      module._free(geometry.vertex_ptr); module._free(geometry.index_ptr);
    }
  }
}
function liftInstances(z) {
  const mesh = ok(call('orc_get_model_mesh'));
  try {
    const seen = new Set();
    for (const renderable of mesh.renderables) {
      if (seen.has(renderable.instance_id)) continue;
      seen.add(renderable.instance_id);
      const [x, y, oldZ] = renderable.instance_transform.offset;
      ok(call('orc_set_instance_offset', ['number', 'number', 'number', 'number', 'number'],
        [renderable.object_idx, renderable.instance_idx, x, y, oldZ + z]));
    }
  } finally {
    for (const geometry of [...mesh.geometries, ...mesh.paint_geometries]) {
      module._free(geometry.vertex_ptr); module._free(geometry.index_ptr);
    }
  }
}
function assign(kind, id, slot) {
  const snapshot = call('orc_get_filament_session_snapshot');
  ok(command('orc_assign_filament', { version: 1, revision: snapshot.revisions.session, targets: [{ kind, id }], slot }));
}
const set = (object, key, value) => ok(setNativeScopedConfig(call, 'object', String(object.id), key, value));
const merge = ids => ok(call('orc_merge_objects_to_multipart', ['string', 'string'], [JSON.stringify(ids), 'Assembly']));
const painted = await buildPaintingChannelProject();
for (const autoDrop of [false, true]) {
  load(fixture(painted, autoDrop));
  const a = structure()[0];
  assign('object', a.id, 2);
  assign('model-part', a.volumes[0].id, 1); // Native single-Part object wins.
  set(a, 'layer_height', '0.12');
  ok(call('orc_set_instance_printable', ['number', 'number'], [a.instances[1].id, 0]));
  // Include rotation, non-uniform scale, mirror and distinct Z positions.
  const transform = { offset: [130, 100, 35], rotation: [0, 0, 0.3], scale: [1.2, 0.8, 1], mirror: [-1, 1, 1] };
  const identity = { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] };
  ok(call('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'], [a.index, 0, 1, JSON.stringify(transform), JSON.stringify(identity)]));
  ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'B']));
  const b = structure()[1]; set(b, 'layer_height', '0.2'); set(b, 'wall_loops', '5');
  liftInstances(40);
  const before = structure(), beforeWorld = worldVertices(), beforePaint = paintCounts(a), beforeConfig = config();
  const beforeArchive = entries(archive());
  assert.ok(beforeArchive.has('Metadata/layer_heights_profile.txt'), 'fixture has variable layer height');
  command('orc_history_reset', context);
  const transaction = ok(call('orc_history_begin', ['string', 'string', 'string', 'string'], ['Assemble', 'project', JSON.stringify(context), '']));
  const receipt = merge([b.id, a.id]); // Click order must not change precedence.
  const committed = call('orc_history_commit', ['string', 'string'], [transaction.transactionId, JSON.stringify(context)]);
  assert.equal(committed.status.undoEntries.length, 1);
  const assembly = structure()[0];
  assert.equal(structure().length, 1); assert.equal(assembly.instances.length, 1);
  assert.equal(assembly.volumes.length, 3); assert.equal(new Set(assembly.volumes.map(v => v.id)).size, 3);
  assert.equal(assembly.printable, false); assert.equal(assembly.instances[0].printable, false);
  assert.equal(config().objects[assembly.id].layer_height, '0.12');
  assert.equal(config().objects[assembly.id].wall_loops, '5');
  const parts = call('orc_get_filament_session_snapshot').assignments.parts;
  assert.deepEqual(parts.map(p => p.effective_slot).sort(), [1, 2, 2]);
  const counts = paintCounts(assembly);
  for (const channel of Object.keys(beforePaint))
    assert.equal(counts[channel].filter(count => JSON.stringify(count) === JSON.stringify(beforePaint[channel][0])).length, 2, channel);
  const afterWorld = worldVertices();
  const expectedWorld = autoDrop ? beforeWorld.map(value => {
    const point = value.split(',').map(Number); point[2] -= 40;
    return point.map(v => Math.round(v * 1e5) / 1e5).join(',');
  }).sort() : beforeWorld;
  assert.deepEqual(afterWorld, expectedWorld, 'affine placements preserved with only the native common Z correction');
  const afterArchive = entries(archive());
  assert.match(afterArchive.get('Metadata/model_settings.config'), new RegExp(`auto_drop="${autoDrop ? 1 : 0}"`));
  assert.ok(!afterArchive.has('Metadata/layer_heights_profile.txt'), 'Orca does not merge variable layer profiles');
  assert.match(afterArchive.get('Metadata/layer_config_ranges.xml'), /0\.16/);
  const brim = afterArchive.get('Metadata/brim_ear_points.txt').trim().split('\n')[1].split('|')[1].trim().split(/\s+/).map(Number);
  assert.equal(brim.length, 8, 'one brim point per selected A instance');
  assert.equal(receipt.plate_session.dirty_reasons.includes('model-structure'), true);
  ok(call('orc_history_undo')); assert.deepEqual(structure(), before); assert.deepEqual(config(), beforeConfig); assert.deepEqual(worldVertices(), beforeWorld);
  assert.deepEqual(paintCounts(structure()[0]), beforePaint);
  ok(call('orc_history_redo')); assert.deepEqual(structure(), [assembly]); assert.deepEqual(worldVertices(), afterWorld);
  console.log(`PASS native assembly attributes, affine copies, unique IDs, one-step history; auto_drop=${autoDrop}`);
}
load(fixture(painted, false));
let a = structure()[0];
assign('object', a.id, 2);
assign('model-part', a.volumes[0].id, 1);
ok(setNativeScopedConfig(call, 'part', String(a.volumes[0].id), 'wall_loops', '7'));
for (const volumeType of ['negative_volume', 'parameter_modifier', 'support_blocker', 'support_enforcer'])
  ok(call('orc_add_volume', ['string', 'pointer', 'number'], [JSON.stringify({
    objectId: a.id, instanceId: a.instances[0].id, volumeType, shape: 'Cube',
  }), 0, 0]));
a = structure()[0];
const beforeTypes = a.volumes.map(v => v.type).sort();
merge([a.id]);
const multipart = structure()[0];
assert.deepEqual(multipart.volumes.map(v => v.type).sort(), [...beforeTypes, ...beforeTypes].sort());
assert.equal(config().parts[a.volumes[0].id].wall_loops, '7');
assert.equal(call('orc_get_filament_session_snapshot').assignments.parts.find(p => p.id === a.volumes[0].id).effective_slot, 1,
  'multipart sources retain explicit Part assignment');
console.log('PASS multipart overrides and all five volume types survive splitting and assembly');
// Reject all unresolved input before splitting or creating anything.
const unchanged = structure();
assert.equal(typeof call('orc_merge_objects_to_multipart', ['string', 'string'], [JSON.stringify([unchanged[0].id, 999999999]), 'Invalid']).error, 'string');
assert.deepEqual(structure(), unchanged);
console.log('PASS invalid assembly leaves the model unchanged');
