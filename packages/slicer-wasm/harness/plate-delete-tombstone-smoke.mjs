// Step 13 real-WASM deletion boundary.
//
// The native registry test pauses an active lease across deletion. This
// bridge-level smoke verifies the externally visible half of the contract:
// persistent deletion parks the target models immediately, selects a live
// survivor, and never exposes the deleted incarnation's completed result.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [moduleArg] = argv.slice(2);
if (!moduleArg)
  throw new Error('usage: node plate-delete-tombstone-smoke.mjs <out/orca_slice.js>');

const repoRoot = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(moduleArg))({
  noInitialRun: true,
  printErr: console.error,
});
await installProfilePackages(Module,
  createNodeProfileSource(resolve(repoRoot, 'packages/profile-resources/dist')));

function callJson(name, argTypes = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  try {
    return JSON.parse(Module.UTF8ToString(ptr));
  } finally {
    Module._free(ptr);
  }
}

function requireOk(label, value) {
  if (!value?.ok) throw new Error(`${label}: ${JSON.stringify(value)}`);
  return value;
}

requireOk('init', callJson('orc_init', ['string'], ['{"log_level":"error"}']));
requireOk('add survivor model',
  callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Survivor Cube']));
const survivor = callJson('orc_get_plate_session_snapshot').current_plate_id;

const added = requireOk('add deletion target plate', callJson('orc_add_plate'));
const target = added.current_plate_id;
if (target === survivor)
  throw new Error(`add deletion target plate: selected id did not change: ${target}`);
requireOk('add deletion target model',
  callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Deleted Cube']));
requireOk('recompute deletion target membership', callJson('orc_recompute_plate_membership'));

const beforeDelete = callJson('orc_get_plate_session_snapshot');
const targetRevision = beforeDelete.input_revisions[target];
const targetInstances = beforeDelete.instances
  .filter((instance) => instance.plate_id === target)
  .map((instance) => instance.instance_id);
if (targetInstances.length === 0)
  throw new Error(`deletion target has no member models: ${JSON.stringify(beforeDelete.instances)}`);

requireOk('slice deletion target', callJson('orc_slice_plate', ['string', 'string', 'number'],
  ['{}', target, targetRevision]));
requireOk('deletion target result starts publishable', callJson('orc_get_slice_result'));

const deleted = requireOk('delete active current plate',
  callJson('orc_delete_plate', ['string'], [target]));
if (deleted.current_plate_id !== survivor ||
    deleted.plates.some((plate) => plate.plate_id === target))
  throw new Error(`delete did not select only the live survivor: ${JSON.stringify(deleted)}`);
if (!targetInstances.every((instanceId) => deleted.instances.some((instance) =>
  instance.instance_id === instanceId && instance.plate_id === '' &&
  instance.parked === true && instance.unprintable === true)))
  throw new Error(`delete did not park target models immediately: ${JSON.stringify(deleted.instances)}`);

const selectedResult = callJson('orc_get_slice_result');
if (selectedResult.ok || !/stale|unavailable/.test(selectedResult.error ?? ''))
  throw new Error(`deleted result leaked onto survivor: ${JSON.stringify(selectedResult)}`);
const deletedExport = callJson('orc_export_gcode_plate', ['string', 'number'],
  [target, targetRevision]);
if (deletedExport.ok ||
    !/not found|not the current plate|stale|unavailable/.test(deletedExport.error ?? ''))
  throw new Error(`deleted receipt remained publishable: ${JSON.stringify(deletedExport)}`);

console.log('plate delete tombstone PASS');
