import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { awaitAsyncTask } from './async-task-mailbox.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: node slice-notifications-smoke.mjs <module.js>');
const root = resolve(import.meta.dirname, '../../..');
const module = await (await loadModuleFactory(resolve(modulePath)))({ noInitialRun: true, print() {}, printErr() {} });
await installProfilePackages(module, createNodeProfileSource(resolve(root, 'packages/profile-resources/dist')));
function call(name, types = [], args = []) {
  const ptr = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(ptr)); } finally { module._free(ptr); }
}
function must(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function set(key, value) { must(setNativeScopedConfig(call, 'project', undefined, key, value)); }
must(call('orc_init', ['string'], [fixtureProfileOptions(module)]));
must(call('orc_select_preset', ['string', 'string'], ['printer', 'Bambu Lab P1P 0.4 nozzle']));
must(call('orc_add_shape', ['string', 'string'], ['Cube', 'Notification fixture']));

async function slice() {
  const snapshot = must(call('orc_get_plate_session_snapshot'));
  const plate = snapshot.current_plate_id;
  const accepted = call('orc_slice_plate', ['string', 'string', 'number'], ['{}', plate, snapshot.input_revisions[plate]]);
  const messages = [];
  const result = await awaitAsyncTask(call, accepted, 120000, batch => messages.push(...batch));
  const diagnostics = messages.filter(m => m.type === 'slice-diagnostics' && m.task_id === accepted.task_id);
  assert.ok(diagnostics.every(m => m.plate_id === plate && m.input_revision === snapshot.input_revisions[plate]));
  for (const event of diagnostics) for (const diagnostic of event.diagnostics) {
    assert.equal(typeof diagnostic.key, 'string');
    assert.equal(typeof diagnostic.message, 'string');
    assert.ok(diagnostic.objectIds.every(id => typeof id === 'string' && /^[1-9]\d*$/.test(id)));
  }
  return { result, diagnostics, messages, accepted };
}

set('enable_prime_tower', '0');
set('enable_wrapping_detection', '1');
set('layer_height', '0.2');
const first = await slice();
assert.equal(first.result.ok, true, JSON.stringify(first.result));
assert.deepEqual(first.diagnostics.map(m => m.phase), ['validation', 'processing', 'slicing']);
assert.ok(first.diagnostics[0].diagnostics.some(d => d.message.includes('clumping detection')), JSON.stringify(first.diagnostics));
const repeated = await slice();
assert.equal(repeated.result.ok, true, JSON.stringify(repeated.result));
assert.ok(BigInt(repeated.accepted.task_id) > BigInt(first.accepted.task_id));
assert.deepEqual(repeated.diagnostics[0].diagnostics, first.diagnostics[0].diagnostics);

set('layer_height', '0.8');
const rejected = await slice();
assert.ok(rejected.result.error, JSON.stringify(rejected.result));
assert.deepEqual(rejected.diagnostics.map(m => m.phase), ['validation']);
assert.ok(rejected.diagnostics[0].diagnostics.some(d => d.severity === 'warning' && d.message.includes('clumping detection')), JSON.stringify(rejected.diagnostics));
assert.ok(rejected.diagnostics[0].diagnostics.some(d => d.severity === 'error' && d.objectIds.length));
assert.ok(rejected.messages.findIndex(m => m.type === 'slice-diagnostics') <
  rejected.messages.findIndex(m => m.type === 'task-terminal'));
console.log('PASS: native validation warnings, warning+error rejection, stable ownership, retry identity and ordered durable phases');
