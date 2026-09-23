// Real-WASM Step 10 configuration-scope invalidation smoke.
//
// Three plates retain independent native results. A plate override invalidates
// only its target, an object/part override invalidates both plates containing
// instances of the owner object, and a shared project override invalidates all
// plates. Undo/Redo and abort preserve the same scope and monotonic stamps.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { callAsyncTask, getSliceResult } from './async-task-mailbox.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [moduleArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node config-scope-invalidation-smoke.mjs <out/orca_slice.js>');
const repoRoot = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(moduleArg))({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(repoRoot, 'packages/profile-resources/dist')));

function callJson(name, argTypes = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
function requireOk(label, value) {
  if (!value?.ok) throw new Error(`${label}: ${JSON.stringify(value)}`);
  return value;
}
function requireStatus(label, value) {
  if (value?.error) throw new Error(`${label}: ${JSON.stringify(value)}`);
  return value;
}
function requireStale(label, value) {
  if (value?.ok || !['stale', 'unavailable'].includes(value?.status))
    throw new Error(`${label}: expected stale/unavailable, got ${JSON.stringify(value)}`);
}
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const session = () => requireOk('plate session', callJson('orc_get_plate_session_snapshot'));
const stamps = () => session().input_revisions;
const begin = (label) => requireOk(`begin ${label}`, callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], [label, 'project', JSON.stringify(context), '']));
const commit = (label, tx) => requireStatus(`commit ${label}`, callJson('orc_history_commit',
  ['string', 'string'], [tx.transactionId, JSON.stringify(context)]));
const setOverride = (scope, id, key, value) => setNativeScopedConfig(callJson, scope, id, key, value);
const select = (plateId) => requireOk(`select ${plateId}`, callJson('orc_select_plate', ['string'], [plateId]));
const receipts = new Map();
const result = (plateId) => {
  select(plateId);
  return getSliceResult(callJson, receipts.get(plateId));
};
const slice = async (plateId) => {
  select(plateId);
  const revision = stamps()[plateId];
  const sliced = requireOk(`slice ${plateId}`, await callAsyncTask(callJson, 'orc_slice_plate',
    ['string', 'string', 'number'], ['{}', plateId, revision]));
  receipts.set(plateId, sliced.receipt);
  requireOk(`materialize ${plateId}`, getSliceResult(callJson, sliced.receipt));
};
function expectScope(label, before, after, changed, unchanged) {
  for (const plateId of changed)
    if (!(after[plateId] > before[plateId]))
      throw new Error(`${label}: ${plateId} did not advance: ${JSON.stringify({ before, after })}`);
  for (const plateId of unchanged)
    if (after[plateId] !== before[plateId])
      throw new Error(`${label}: ${plateId} changed unexpectedly: ${JSON.stringify({ before, after })}`);
}

requireOk('init', callJson('orc_init', ['string'], ['{"log_level":"error"}']));
requireOk('clear model', callJson('orc_clear_model'));
requireOk('add shared cube', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Shared object']));
const initialStructure = requireOk('initial structure', callJson('orc_get_model_structure'));
const sharedObjectId = initialStructure.objects[0]?.id;
const sharedPartId = initialStructure.objects[0]?.volumes[0]?.id;
if (!sharedObjectId || !sharedPartId) throw new Error(`missing shared object identity: ${JSON.stringify(initialStructure)}`);

const plateA = session().current_plate_id;
requireOk('add plate B', callJson('orc_add_plate'));
const plateB = session().current_plate_id;
requireOk('add plate C', callJson('orc_add_plate'));
const plateC = session().current_plate_id;
const threePlateSession = session();
const origin = (plateId) => threePlateSession.plates.find((plate) => plate.plate_id === plateId)?.origin;
const originA = origin(plateA);
const originB = origin(plateB);
if (!originA || !originB) throw new Error(`missing plate origins: ${JSON.stringify(threePlateSession)}`);

requireOk('add shared instance', callJson('orc_add_instance', ['number'], [sharedObjectId]));
const sharedMesh = requireOk('shared mesh', callJson('orc_get_model_mesh'));
const firstInstance = sharedMesh.objects?.find((entry) => entry.object_idx === 0 && entry.instance_idx === 0);
if (!firstInstance) throw new Error(`missing shared instance transform: ${JSON.stringify(sharedMesh)}`);
const offset = firstInstance.instance_transform.offset;
requireOk('place shared instance on B', callJson('orc_set_instance_offset',
  ['number', 'number', 'number', 'number', 'number'],
  [0, 1, offset[0] + originB[0] - originA[0], offset[1] + originB[1] - originA[1], offset[2]]));
requireOk('recompute shared membership', callJson('orc_recompute_plate_membership'));
select(plateC);
requireOk('add isolated cube on C', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Isolated object']));

const membership = session();
const sharedMembership = membership.instances.filter((entry) => entry.object_id === sharedObjectId && entry.member);
if (!sharedMembership.some((entry) => entry.plate_id === plateA) ||
    !sharedMembership.some((entry) => entry.plate_id === plateB))
  throw new Error(`shared object is not a member of A and B: ${JSON.stringify(sharedMembership)}`);
requireStatus('reset history baseline', callJson('orc_history_reset', ['string'], [JSON.stringify(context)]));

for (const plateId of [plateA, plateB, plateC]) await slice(plateId);

// Rejection is atomic: neither native configuration, stamps, nor any valid presentation is
// touched when native option parsing fails.
const beforeRejectSession = session();
const beforeRejectSnapshot = requireOk('snapshot before rejection', callJson('orc_get_native_scoped_config'));
const rejected = setOverride('plate', plateA, 'print_sequence', 'not-a-sequence');
if (rejected.ok || rejected.error_code !== 'native_validation_failure')
  throw new Error(`invalid plate override was not rejected: ${JSON.stringify(rejected)}`);
if (!sameJson(session(), beforeRejectSession) ||
    !sameJson(requireOk('snapshot after rejection', callJson('orc_get_native_scoped_config')), beforeRejectSnapshot))
  throw new Error('rejected configuration changed authoritative state');
for (const plateId of [plateA, plateB, plateC]) requireOk(`result retained after rejection ${plateId}`, result(plateId));

// Plate-local mutation and its history restore touch A only.
let before = stamps();
const plateTx = begin('Plate Configuration');
const plateEdit = requireOk('plate-local override', setOverride('plate', plateA, 'print_sequence', 'by object'));
if (!sameJson(plateEdit.plate_session.affected_plate_ids, [plateA]))
  throw new Error(`plate-local affected set is wrong: ${JSON.stringify(plateEdit)}`);
let after = stamps();
expectScope('plate-local edit', before, after, [plateA], [plateB, plateC]);
commit('Plate Configuration', plateTx);
requireStale('A stale after plate edit', result(plateA));
requireOk('B retained after plate edit', result(plateB));
requireOk('C retained after plate edit', result(plateC));

before = after;
requireStatus('undo plate configuration', callJson('orc_history_undo'));
after = stamps();
expectScope('plate-local undo', before, after, [plateA], [plateB, plateC]);
requireStale('A remains stale after plate Undo', result(plateA));
requireOk('B retained after plate Undo', result(plateB));
before = after;
requireStatus('redo plate configuration', callJson('orc_history_redo'));
after = stamps();
expectScope('plate-local redo', before, after, [plateA], [plateB, plateC]);
requireStale('A remains stale after plate Redo', result(plateA));
requireOk('C retained after plate Redo', result(plateC));
await slice(plateA);

// Aborting a published local edit restores both stamps and presentation.
const beforeAbort = stamps();
const abortTx = begin('Abort Plate Configuration');
requireOk('temporary plate override', setOverride('plate', plateA, 'print_sequence', 'by layer'));
requireStale('A stale during aborted edit', result(plateA));
requireOk('abort plate configuration', callJson('orc_history_abort', ['string'], [abortTx.transactionId]));
if (!sameJson(stamps(), beforeAbort)) throw new Error(`abort did not restore stamps: ${JSON.stringify({ beforeAbort, after: stamps() })}`);
requireOk('A presentation restored after abort', result(plateA));

// One object has instances on A and B. Object and part scopes invalidate both
// owner plates while C's independent result remains publishable.
before = stamps();
const objectTx = begin('Object Configuration');
const objectEdit = requireOk('object override', setOverride('object', String(sharedObjectId), 'wall_loops', '3'));
if (!sameJson(objectEdit.plate_session.affected_plate_ids, [plateA, plateB]))
  throw new Error(`object affected set is wrong: ${JSON.stringify(objectEdit)}`);
after = stamps();
expectScope('object edit', before, after, [plateA, plateB], [plateC]);
commit('Object Configuration', objectTx);
requireStale('A stale after object edit', result(plateA));
requireStale('B stale after object edit', result(plateB));
requireOk('C retained after object edit', result(plateC));

before = after;
requireStatus('undo object configuration', callJson('orc_history_undo'));
after = stamps();
expectScope('object undo', before, after, [plateA, plateB], [plateC]);
before = after;
requireStatus('redo object configuration', callJson('orc_history_redo'));
after = stamps();
expectScope('object redo', before, after, [plateA, plateB], [plateC]);
requireOk('C retained through object history', result(plateC));
await slice(plateA);
await slice(plateB);

before = stamps();
const partTx = begin('Part Configuration');
const partEdit = requireOk('part override', setOverride('part', String(sharedPartId), 'enable_support', '1'));
after = stamps();
expectScope('part edit', before, after, [plateA, plateB], [plateC]);
if (!sameJson(partEdit.plate_session.affected_plate_ids, [plateA, plateB]))
  throw new Error(`part affected set is wrong: ${JSON.stringify(partEdit)}`);
commit('Part Configuration', partTx);
requireOk('C retained after part edit', result(plateC));

before = after;
requireStatus('undo part configuration', callJson('orc_history_undo'));
after = stamps();
expectScope('part undo', before, after, [plateA, plateB], [plateC]);
before = after;
requireStatus('redo part configuration', callJson('orc_history_redo'));
after = stamps();
expectScope('part redo', before, after, [plateA, plateB], [plateC]);
requireOk('C retained through part history', result(plateC));
await slice(plateA);
await slice(plateB);

// Filament rack state is shared slicing input and therefore fans out to every
// plate even when only one slot field changes.
before = stamps();
const filament = requireOk('filament snapshot', callJson('orc_get_filament_session_snapshot'));
const filamentEdit = requireOk('filament colour edit', callJson('orc_set_filament_slot_colour', ['string'],
  [JSON.stringify({ version: 1, revision: filament.revisions.session, slot: 1, colour: '#A1B2C3' })]));
after = stamps();
expectScope('filament edit', before, after, [plateA, plateB, plateC], []);
for (const plateId of [plateA, plateB, plateC]) requireStale(`plate stale after filament edit ${plateId}`, result(plateId));
for (const plateId of [plateA, plateB, plateC]) await slice(plateId);

// Project configuration remains the shared/global boundary.
before = stamps();
const globalEdit = requireOk('global override', setOverride('project', '', 'layer_height', '0.24'));
after = stamps();
expectScope('global edit', before, after, [plateA, plateB, plateC], []);
if (!sameJson(globalEdit.plate_session.affected_plate_ids, [plateA, plateB, plateC]))
  throw new Error(`global affected set is wrong: ${JSON.stringify(globalEdit)}`);
for (const plateId of [plateA, plateB, plateC]) requireStale(`plate stale after global edit ${plateId}`, result(plateId));
for (const plateId of [plateA, plateB, plateC]) await slice(plateId);

// Printer/process profile activation enters through this shared marker rather
// than the native scoped setter, but it has the same all-plate invalidation contract.
before = stamps();
const presetEdit = requireOk('shared preset mutation', callJson('orc_mark_shared_configuration_mutation'));
after = stamps();
expectScope('shared preset edit', before, after, [plateA, plateB, plateC], []);
if (!sameJson(presetEdit.affected_plate_ids, [plateA, plateB, plateC]))
  throw new Error(`shared preset affected set is wrong: ${JSON.stringify(presetEdit)}`);
for (const plateId of [plateA, plateB, plateC]) requireStale(`plate stale after shared preset edit ${plateId}`, result(plateId));

console.log('configuration scope invalidation PASS');
