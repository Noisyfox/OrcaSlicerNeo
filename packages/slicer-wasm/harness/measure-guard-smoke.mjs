// Real-WASM target protection, including shared volume and last-Part normalization.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: measure-guard-smoke.mjs <orca_slice.js>');
const module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(pointer)); } finally { module._free(pointer); }
}
const command = (name, value) => call(name, ['string'], [JSON.stringify(value)]);
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const guarded = value => assert.match(value.error ?? '', /Close Measure/, JSON.stringify(value));
const structure = () => ok(call('orc_get_model_structure')).objects;
ok(command('orc_init', JSON.parse(fixtureProfileOptions(module))));
const bytes = await readFile(resolve(import.meta.dirname, '../fixtures/multipart.stl'));
const input = Number(module._malloc(bytes.length)); module.HEAPU8.set(bytes, input);
try { ok(call('orc_add_model', ['pointer', 'number', 'string', 'string'], [input, bytes.length, 'stl', 'multipart.stl'])); }
finally { module._free(input); }
let object = structure()[0];
assert.equal(object.volumes[0].isSplittable, true);
for (let i = 0; i < 2; ++i)
  ok(call('orc_add_volume', ['string', 'pointer', 'number'],
    [JSON.stringify({ objectId: object.id, instanceId: object.instances[0].id, volumeType: 'model_part', shape: 'Cube' }), 0, 0]));
ok(call('orc_add_instance', ['number'], [object.id]));
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Unrelated']));
[object] = structure();
const other = structure()[1];
const [first, second, third] = object.volumes.map(volume => volume.id);
const [instance, sibling] = object.instances.map(entry => entry.id);
const session = ok(command('orc_measure_open', { version: 1, targets: [{ objectId: object.id, instanceId: instance, volumeId: first }] }));
const handle = { version: 1, sessionId: session.sessionId, targetRevision: session.targetRevision };
const before = structure();
guarded(call('orc_clear_model'));
guarded(call('orc_delete_objects', ['string'], [JSON.stringify([other.id, object.id])]));
guarded(call('orc_delete_volumes', ['string'], [JSON.stringify([first])]));
guarded(call('orc_split_volume_to_parts', ['number', 'number', 'number'], [first, 1, 0]));
guarded(call('orc_split_object_to_objects', ['number', 'number'], [object.id, 0]));
guarded(call('orc_merge_objects_to_multipart', ['string', 'string'], [JSON.stringify([object.id, other.id]), 'Merged']));
guarded(call('orc_instances_to_separate_objects', ['number', 'string'], [object.id, JSON.stringify([instance])]));
guarded(call('orc_remove_instance', ['number', 'number'], [object.id, instance]));
guarded(command('orc_mesh_boolean', { entry: 'object', objectId: object.id, keepPainting: false }));
guarded(command('orc_mesh_boolean', { entry: 'gizmo', objectId: object.id, instanceId: sibling,
  sourceVolumeId: first, toolVolumeId: second, operation: 'difference', deleteInput: false, keepPainting: false }));
guarded(command('orc_mesh_boolean', { entry: 'gizmo', objectId: object.id, instanceId: sibling,
  sourceVolumeId: second, toolVolumeId: first, operation: 'union', deleteInput: false, keepPainting: false }));
assert.deepEqual(structure(), before, 'guarded operations have no partial effects');
ok(command('orc_measure_read', handle));
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const tx = ok(call('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Delete blocked target', 'project', JSON.stringify(context), '']));
guarded(call('orc_delete_objects', ['string'], [JSON.stringify([object.id])]));
ok(call('orc_history_abort', ['string'], [tx.transactionId]));
assert.deepEqual(structure(), before);
ok(command('orc_measure_read', handle));

// Removing one unrelated part is safe with three parts; removing the next
// would make Orca re-ID and normalize the measured last part.
ok(call('orc_delete_volumes', ['string'], [JSON.stringify([third])]));
ok(command('orc_measure_read', handle));
const afterFirstDeletion = structure();
guarded(call('orc_delete_volumes', ['string'], [JSON.stringify([second])]));
assert.deepEqual(structure(), afterFirstDeletion);
// The source volume is shared, but removing an unmeasured sibling instance
// leaves both the selected instance and its mesh untouched.
ok(call('orc_remove_instance', ['number', 'number'], [object.id, sibling]));
ok(command('orc_measure_read', handle));
ok(call('orc_delete_objects', ['string'], [JSON.stringify([other.id])]));
ok(command('orc_measure_read', handle));
ok(command('orc_measure_close', { version: 1, sessionId: session.sessionId }));
ok(call('orc_delete_volumes', ['string'], [JSON.stringify([first])]));

// Difference can preserve the tool Part. Measuring that retained Part must
// not block an operation which changes only the other source Part.
object = structure()[0];
const retained = object.volumes[0].id;
const added = ok(call('orc_add_volume', ['string', 'pointer', 'number'],
  [JSON.stringify({ objectId: object.id, instanceId: object.instances[0].id, volumeType: 'model_part', shape: 'Cube' }), 0, 0]));
const retainedSession = ok(command('orc_measure_open', { version: 1, targets: [{ objectId: object.id, instanceId: object.instances[0].id, volumeId: retained }] }));
ok(command('orc_mesh_boolean', { entry: 'gizmo', objectId: object.id, instanceId: object.instances[0].id,
  sourceVolumeId: added.volumeId, toolVolumeId: retained, operation: 'difference', deleteInput: false, keepPainting: false }));
ok(command('orc_measure_read', { version: 1, sessionId: retainedSession.sessionId, targetRevision: retainedSession.targetRevision }));
ok(command('orc_measure_close', { version: 1, sessionId: retainedSession.sessionId }));
console.log('Measure target guards passed');
