// Real-WASM Measure ABI, resource ownership, and project/history lifetime.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: measure-bridge-smoke.mjs <orca_slice.js>');
const module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(pointer)); } finally { module._free(pointer); }
}
const command = (name, value) => call(name, ['string'], [JSON.stringify(value)]);
const release = (name, value) => module.ccall(name, 'void', ['string'], [JSON.stringify(value)]);
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const reject = value => assert.equal(typeof value.error, 'string', JSON.stringify(value));
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
ok(command('orc_init', JSON.parse(fixtureProfileOptions(module))));
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Measure test']));
assert.equal(command('orc_history_reset', context).disabled, false);
const object = ok(call('orc_get_model_structure')).objects[0];
const target = { objectId: object.id, instanceId: object.instances[0].id, volumeId: object.volumes[0].id };
const mesh = ok(call('orc_get_model_mesh'));
const renderable = mesh.renderables[0];
const geometry = mesh.geometries.find(entry => entry.volume_id === target.volumeId);
const sourceVertices = new Float32Array(module.HEAPU8.slice(Number(geometry.vertex_ptr),
  Number(geometry.vertex_ptr) + geometry.vertex_count * 12).buffer);
function transform(matrix, [x, y, z]) {
  return [matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]];
}
const world = [];
for (let index = 0; index < sourceVertices.length; index += 3)
  world.push(transform(renderable.instance_transform.matrix,
    transform(renderable.volume_transform.matrix, [...sourceVertices.slice(index, index + 3)])));
const minX = Math.min(...world.map(point => point[0]));
const minY = Math.min(...world.map(point => point[1]));
const maxY = Math.max(...world.map(point => point[1]));
for (const geometry of [...mesh.geometries, ...mesh.paint_geometries]) {
  if (geometry.vertex_ptr) module._free(Number(geometry.vertex_ptr));
  if (geometry.index_ptr) module._free(Number(geometry.index_ptr));
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function event(x, y) {
  const projection = [...identity]; projection[0] = .025; projection[5] = .025; projection[10] = -.01;
  const view = [...identity]; view[12] = -renderable.offset[0]; view[13] = -renderable.offset[1]; view[14] = -100;
  return { pointer: [(x + 40) * 1.25, (40 - y) * 1.25], viewport: [0, 0, 100, 100], projection, view };
}
const scene = () => ({ model: call('orc_get_model_structure'), history: call('orc_history_status') });
const before = scene();
let current = ok(command('orc_measure_open', { version: 1, targets: [target] }));
let handle = () => ({ version: 1, sessionId: current.sessionId, targetRevision: current.targetRevision });
assert.equal(current.selectionRevision, 1);
assert.equal(current.first, null);
for (const bad of [{ targets: [] }, { targets: [target, target] }, { targets: [{ ...target, instanceId: 0 }] },
  { targets: [target], unknown: true }, { version: 2, targets: [target] }])
  reject(command('orc_measure_open', { version: 1, ...bad }));
assert.deepEqual(ok(command('orc_measure_read', handle())), current);
for (const bad of [{ sessionId: 'ms-01' }, { sessionId: current.sessionId + 'x' },
  { targetRevision: 2 }, { targetRevision: -1 }, { unknown: true }])
  reject(command('orc_measure_read', { ...handle(), ...bad }));
reject(call('orc_history_undo')); // A failed navigation retains the session.
ok(command('orc_measure_read', handle()));

for (const invalidEvent of [
  { ...event(3, 4), pointer: [Infinity, 4] },
  { ...event(3, 4), projection: [...identity.slice(0, 15), null] },
  { ...event(3, 4), viewport: [0, 0, 0, 100] },
]) reject(command('orc_measure_display', { ...handle(), event: invalidEvent }));
assert.deepEqual(ok(command('orc_measure_read', handle())), current);

const planeDisplay = ok(command('orc_measure_display', { ...handle(), event: event(3, 4) }));
assert.equal(planeDisplay.hover.feature.type, 'plane');
const planeRequest = { ...handle(), displayId: planeDisplay.displayId, role: 'hover',
  resourceId: planeDisplay.hover.feature.resourceId };
reject(command('orc_measure_plane', { ...planeRequest, resourceId: `${planeRequest.resourceId}-wrong` }));
const plane = ok(command('orc_measure_plane', planeRequest));
assert.equal(plane.resourceId, planeRequest.resourceId);
assert.ok(plane.vertexCount > 0 && plane.vertexCount % 3 === 0);
assert.equal(plane.vertex_ptr % 4, 0);
assert.ok(plane.vertex_ptr + plane.vertexCount * 12 <= module.HEAPU8.length);
const vertices = new Float32Array(module.HEAPU8.slice(plane.vertex_ptr, plane.vertex_ptr + plane.vertexCount * 12).buffer);
assert.ok(vertices.every(Number.isFinite));
assert.equal(plane.transform.length, 16);
current = ok(command('orc_measure_click', { ...handle(), displayId: planeDisplay.displayId, shift: false, event: event(3, 4) }));
assert.equal(current.outcome, 'selected');
assert.equal(current.first.value.type, 'plane');
const edgeDisplay = ok(command('orc_measure_display', { ...handle(),
  event: event(minX - renderable.offset[0] + .05, (minY + maxY) / 2 - renderable.offset[1]) }));
assert.equal(edgeDisplay.hover.feature.type, 'edge');
const midpoint = edgeDisplay.markers.find(marker => marker.item.kind === 'midpoint');
assert.ok(midpoint);
const relative = [midpoint.position[0] - renderable.offset[0], midpoint.position[1] - renderable.offset[1]];
current = ok(command('orc_measure_click', { ...handle(), displayId: edgeDisplay.displayId,
  marker: midpoint.index, shift: false, event: event(...relative) }));
assert.equal(current.outcome, 'selected');
assert.equal(current.second.kind, 'midpoint');
assert.equal(current.sameTarget, true);
assert.ok(current.result);
const stable = current;
reject(command('orc_measure_click', { ...handle(), displayId: edgeDisplay.displayId, marker: 999, shift: false, event: event(...relative) }));
assert.deepEqual(ok(command('orc_measure_read', handle())), (({ outcome, ...rest }) => rest)(stable));
release('orc_measure_display_release', { version: 1, sessionId: 'ms-999999', displayId: edgeDisplay.displayId });
const secondLease = ok(command('orc_measure_plane', planeRequest));
release('orc_measure_plane_release', { version: 1, leaseId: secondLease.leaseId });
release('orc_measure_display_release', { version: 1, sessionId: current.sessionId, displayId: planeDisplay.displayId });
reject(command('orc_measure_plane', planeRequest));
assert.deepEqual(scene(), before, 'measurement never mutates model or history');

// The native adapter retains selected features and recalculates them after an
// admitted transform; old display handles cannot be used against the new target.
const pointBefore = current.second.value.point;
const { matrix: ignoredMatrix, ...scaledInstance } = renderable.instance_transform;
scaledInstance.scale = scaledInstance.scale.map(value => value * 2);
ok(call('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'],
  [0, 0, 0, JSON.stringify(scaledInstance), JSON.stringify(renderable.volume_transform)]));
reject(command('orc_measure_read', handle()));
current = ok(command('orc_measure_rebase', handle()));
assert.equal(current.targetRevision, 2);
assert.equal(current.second.kind, 'midpoint');
for (let axis = 0; axis < 3; ++axis)
  assert.ok(Math.abs(current.second.value.point[axis] -
    (renderable.offset[axis] + 2 * (pointBefore[axis] - renderable.offset[axis]))) < 1e-5);
reject(command('orc_measure_click', { ...handle(), displayId: edgeDisplay.displayId,
  marker: midpoint.index, shift: false, event: event(...relative) }));

// The plane allocation is request-owned and stays readable after session close.
ok(command('orc_measure_close', { version: 1, sessionId: current.sessionId }));
assert.deepEqual(module.HEAPU8.slice(plane.vertex_ptr, plane.vertex_ptr + plane.vertexCount * 12),
  new Uint8Array(vertices.buffer));
release('orc_measure_plane_release', { version: 1, leaseId: plane.leaseId });
release('orc_measure_plane_release', { version: 1, leaseId: plane.leaseId });
reject(command('orc_measure_read', handle()));

assert.equal(command('orc_history_reset', context).disabled, false);
current = ok(command('orc_measure_open', { version: 1, targets: [target] }));
const tx = ok(call('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Rename', 'project', JSON.stringify(context), '']));
reject(command('orc_measure_read', handle()));
ok(command('orc_measure_close', { version: 1, sessionId: current.sessionId }));
reject(command('orc_measure_open', { version: 1, targets: [target] }));
ok(call('orc_rename_object', ['number', 'string'], [object.id, 'Changed']));
assert.equal(call('orc_history_commit', ['string', 'string'], [tx.transactionId, JSON.stringify(context)]).status.canUndo, true);
current = ok(command('orc_measure_open', { version: 1, targets: [target] }));
ok(call('orc_history_undo'));
reject(command('orc_measure_read', handle()));
current = ok(command('orc_measure_open', { version: 1, targets: [target] }));
ok(call('orc_close_project'));
reject(command('orc_measure_read', handle()));
console.log('Measure bridge smoke passed');
