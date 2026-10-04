import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';

const fixture = resolve(process.argv[3] ?? 'packages/slicer-wasm/fixtures/cube.stl');
const profiles = resolve(import.meta.dirname, '../../profile-resources/dist');
const factory = await loadModuleFactory(process.argv[2]);
const module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(module, createNodeProfileSource(profiles));
function call(name, types = [], args = []) {
  const ptr = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(ptr)); } finally { module._free(ptr); }
}
assert.equal(call('orc_init', ['string'], ['{"log_level":"error"}']).ok, true);
// Measure the real WASM geometry, rather than deriving an expectation from
// the Neo helper. These profile dimensions are the native Orca build areas.
function cubeSizes() {
  const result = call('orc_get_model_mesh');
  return result.geometries.map((geometry) => {
    try {
      const vertices = new Float32Array(module.HEAPU8.slice(Number(geometry.vertex_ptr),
        Number(geometry.vertex_ptr) + geometry.vertex_count * 12).buffer);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < vertices.length; i += 3)
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], vertices[i + axis]);
          max[axis] = Math.max(max[axis], vertices[i + axis]);
        }
      return max.map((value, axis) => value - min[axis]);
    } finally {
      module._free(Number(geometry.vertex_ptr));
      module._free(Number(geometry.index_ptr));
    }
  });
}
for (const [printer, expected] of [['Bambu Lab P1P 0.4 nozzle', 25.6],
  ['Bambu Lab A1 mini 0.4 nozzle', 18], ['Prusa MK4 0.4 nozzle', 25]]) {
  call('orc_clear_model');
  const selected = call('orc_select_preset', ['string', 'string'], ['printer', printer]);
  assert.equal(selected.ok, true, JSON.stringify(selected));
  assert.equal(call('orc_add_shape', ['string', 'string'], ['Cube', 'Size reference']).ok, true);
  const owner = call('orc_get_model_structure').objects[0];
  assert.equal(call('orc_add_volume', ['string', 'pointer', 'number'], [JSON.stringify({
    objectId: owner.id, instanceId: owner.instances[0].id, volumeType: 'model_part', shape: 'Cube',
  }), 0, 0]).ok, true);
  const sizes = cubeSizes();
  assert.equal(sizes.length, 2);
  for (const size of sizes) for (const value of size)
    assert.ok(Math.abs(value - expected) < 0.0001, `${printer}: ${size}, expected ${expected}`);
  console.log(`PASS ${printer}: object Cube and Cube Part both ${expected} mm`);
}
call('orc_clear_model');
assert.equal(call('orc_add_shape', ['string', 'string'], ['Cube', 'Owner']).ok, true);
const object = call('orc_get_model_structure').objects[0];
const objectId = object.id, instanceId = object.instances[0].id;
const target = { objectId, instanceId, volumeType: 'model_part' };
const original = call('orc_get_model_structure');
for (const bad of [{ ...target, objectId: 999 }, { ...target, instanceId: 999 }, { ...target, volumeType: 'bad' }]) {
  assert.equal(call('orc_add_volume', ['string', 'pointer', 'number'], [JSON.stringify({ ...bad, shape: 'Cube' }), 0, 0]).ok, false);
  assert.deepEqual(call('orc_get_model_structure'), original);
}
const volumeTypes = ['model_part', 'negative_volume', 'parameter_modifier', 'support_blocker', 'support_enforcer'];
const shapes = ['Cube', 'Cylinder', 'Sphere', 'Cone', 'Disc', 'Torus'];
for (const [index, shape] of shapes.entries()) {
  const volumeType = volumeTypes[index % volumeTypes.length];
  const added = call('orc_add_volume', ['string', 'pointer', 'number'], [JSON.stringify({ ...target, volumeType, shape }), 0, 0]);
  assert.equal(added.ok, true, JSON.stringify(added));
  const structure = call('orc_get_model_structure');
  assert.equal(structure.objects.length, 1);
  assert.equal(structure.objects[0].id, objectId);
  assert.equal(structure.objects[0].volumes.length, index + 2);
  assert.equal(structure.objects[0].volumes.find(v => v.id === added.volumeId).type, volumeType);
  const rendered = call('orc_get_model_mesh');
  assert.ok(rendered.renderables.some(v => v.volume_id === added.volumeId));
}
const beforeHistory = call('orc_get_model_structure');
const context = { selection: { mode: 'object', objectIds: [objectId], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
call('orc_history_reset', ['string'], [JSON.stringify(context)]);
const tx = call('orc_history_begin', ['string', 'string', 'string', 'string'], ['Add part', 'project', JSON.stringify(context), '']);
assert.equal(tx.ok, true);
const addedInHistory = call('orc_add_volume', ['string', 'pointer', 'number'], [JSON.stringify({ ...target, shape: 'Cube' }), 0, 0]);
assert.equal(addedInHistory.ok, true);
const afterContext = { ...context, selection: { mode: 'part', objectIds: [], partIds: [addedInHistory.volumeId], instanceIds: [instanceId] } };
assert.equal(call('orc_history_commit', ['string', 'string'], [tx.transactionId, JSON.stringify(afterContext)]).status.canUndo, true);
assert.equal(call('orc_history_undo').ok, true);
assert.deepEqual(call('orc_get_model_structure'), beforeHistory);
const redo = call('orc_history_redo');
assert.equal(redo.ok, true);
assert.deepEqual(redo.context.selection, afterContext.selection);
assert.ok(call('orc_get_model_structure').objects[0].volumes.some(v => v.id === addedInHistory.volumeId));
const beforeFile = call('orc_get_model_structure');
const bytes = new Uint8Array(await readFile(fixture)), ptr = Number(module._malloc(bytes.length));
try {
  module.HEAPU8.set(bytes, ptr);
  const added = call('orc_add_volume', ['string', 'pointer', 'number'],
    [JSON.stringify({ ...target, volumeType: 'negative_volume', ext: 'stl', name: 'hole.stl' }), ptr, bytes.length]);
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(call('orc_get_model_structure').objects[0].volumes.length, beforeFile.objects[0].volumes.length + 1);
  assert.equal(module.FS.analyzePath('/tmp/part-hole.stl').exists, false);
} finally { module._free(ptr); }
console.log('PASS add-volume native smoke: six primitives, five types, stable IDs, file import, failure atomicity and temporary-file cleanup');
process.exit(0);
