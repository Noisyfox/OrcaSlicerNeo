// Real-WASM checks for stale sessions after ordinary model mutations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: measure-stale-target-smoke.mjs <orca_slice.js>');
const module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(pointer)); } finally { module._free(pointer); }
}
const command = (name, value) => call(name, ['string'], [JSON.stringify(value)]);
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const stale = value => assert.match(value.error ?? '', /stale/, JSON.stringify(value));
const structure = () => ok(call('orc_get_model_structure')).objects;
ok(command('orc_init', JSON.parse(fixtureProfileOptions(module))));
const bytes = await readFile(resolve(import.meta.dirname, '../fixtures/multipart.stl'));
const input = Number(module._malloc(bytes.length)); module.HEAPU8.set(bytes, input);
try { ok(call('orc_add_model', ['pointer', 'number', 'string', 'string'], [input, bytes.length, 'stl', 'multipart.stl'])); }
finally { module._free(input); }
let object = structure()[0];
for (let i = 0; i < 2; ++i)
  ok(call('orc_add_volume', ['string', 'pointer', 'number'],
    [JSON.stringify({ objectId: object.id, instanceId: object.instances[0].id, volumeType: 'model_part', shape: 'Cube' }), 0, 0]));
[object] = structure();
const [first, second, third] = object.volumes.map(volume => volume.id);
const opened = ok(command('orc_measure_open', { version: 1, targets: [{
  objectId: object.id, instanceId: object.instances[0].id, volumeId: first,
}] }));
const handle = { version: 1, sessionId: opened.sessionId, targetRevision: opened.targetRevision };
ok(call('orc_delete_volumes', ['string'], [JSON.stringify([third])]));
ok(command('orc_measure_read', handle));
// Orca normalizes and re-IDs the last remaining part.
ok(call('orc_delete_volumes', ['string'], [JSON.stringify([second])]));
stale(command('orc_measure_read', handle));
ok(command('orc_measure_close', { version: 1, sessionId: opened.sessionId }));

[object] = structure();
const reopened = ok(command('orc_measure_open', { version: 1, targets: [{
  objectId: object.id, instanceId: object.instances[0].id, volumeId: object.volumes[0].id,
}] }));
ok(call('orc_delete_objects', ['string'], [JSON.stringify([object.id])]));
stale(command('orc_measure_read', { version: 1, sessionId: reopened.sessionId, targetRevision: reopened.targetRevision }));
ok(command('orc_measure_close', { version: 1, sessionId: reopened.sessionId }));
console.log('Measure stale-target handling passed');
