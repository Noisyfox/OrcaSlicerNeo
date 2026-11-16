import { fixtureProfileOptions } from './profile-installer.mjs';
// Real-WASM Step9 transform invalidation smoke.
//
// Plate B is sliced first and must remain publishable while a committed Move
// changes A. Undo and Redo each assign a fresh A stamp and withdraw only A's
// presentation. The transform is submitted once, matching one final drag
// frame rather than intermediate renderer frames.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { callAsyncTask, getSliceResult } from './async-task-mailbox.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [moduleArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node transform-plate-invalidation-smoke.mjs <out/orca_slice.js>');
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

const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const stampMap = () => callJson('orc_get_plate_session_snapshot').input_revisions;
requireOk('init', callJson('orc_init', ['string'], [fixtureProfileOptions(Module)]));
requireOk('clear model', callJson('orc_clear_model'));
const baseline = callJson('orc_history_reset', ['string'], [JSON.stringify(context)]);
if (baseline.error) throw new Error(`history baseline: ${JSON.stringify(baseline)}`);

const addA = requireOk('begin A', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Add Cube A', 'project', JSON.stringify(context), '']));
requireOk('add A', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Transform A']));
requireStatus('commit A', callJson('orc_history_commit', ['string', 'string'],
  [addA.transactionId, JSON.stringify(context)]).status);
const first = callJson('orc_get_plate_session_snapshot');
const plateA = first.current_plate_id;
const addPlate = requireOk('begin add plate', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Add Plate', 'project', JSON.stringify(context), '']));
requireOk('add plate B', callJson('orc_add_plate'));
const second = callJson('orc_get_plate_session_snapshot');
const plateB = second.current_plate_id;
requireStatus('commit add plate', callJson('orc_history_commit', ['string', 'string'],
  [addPlate.transactionId, JSON.stringify(context)]).status);
const addB = requireOk('begin B', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Add Cube B', 'project', JSON.stringify(context), '']));
requireOk('add B', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Transform B']));
requireStatus('commit B', callJson('orc_history_commit', ['string', 'string'],
  [addB.transactionId, JSON.stringify(context)]).status);

requireOk('select A', callJson('orc_select_plate', ['string'], [plateA]));
let snapshot = callJson('orc_get_plate_session_snapshot');
let sliceA = requireOk('slice A', await callAsyncTask(callJson, 'orc_slice_plate',
  ['string', 'string', 'number', 'string'], ['{}', plateA, snapshot.input_revisions[plateA], 'null']));
requireOk('select B', callJson('orc_select_plate', ['string'], [plateB]));
snapshot = callJson('orc_get_plate_session_snapshot');
const sliceB = requireOk('slice B', await callAsyncTask(callJson, 'orc_slice_plate',
  ['string', 'string', 'number', 'string'], ['{}', plateB, snapshot.input_revisions[plateB], 'null']));
requireOk('B result before Move', getSliceResult(callJson, sliceB.receipt));
const beforeMoveStamps = stampMap();

requireOk('select A for Move', callJson('orc_select_plate', ['string'], [plateA]));
const mesh = callJson('orc_get_model_mesh');
const target = mesh.renderables?.find((entry) => entry.object_idx === 0);
if (!target) throw new Error(`missing A transform target: ${JSON.stringify(mesh)}`);
const nextInstance = { ...target.instance_transform,
  offset: [target.instance_transform.offset[0] + 10,
    target.instance_transform.offset[1], target.instance_transform.offset[2]] };
// Full matrices are authoritative in the bridge; use TRS for this ordinary
// translation test so the changed offset is applied.
delete nextInstance.matrix;
const move = requireOk('begin Move', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Move', 'project', JSON.stringify(context), '']));
const moved = requireOk('move A', callJson('orc_set_model_transforms', ['string', 'string'],
  [move.transactionId, JSON.stringify([{
    objectIdx: target.object_idx, volumeIdx: target.volume_idx, instanceIdx: target.instance_idx,
    instanceTransform: nextInstance, volumeTransform: target.volume_transform,
  }])]));
const afterMoveStamps = stampMap();
if (!(afterMoveStamps[plateA] > beforeMoveStamps[plateA]) || afterMoveStamps[plateB] !== beforeMoveStamps[plateB])
  throw new Error(`Move stamp scope failed: ${JSON.stringify({ beforeMoveStamps, afterMoveStamps, moved })}`);
requireStatus('commit Move', callJson('orc_history_commit', ['string', 'string'],
  [move.transactionId, JSON.stringify(context)]).status);
requireOk('select B after Move', callJson('orc_select_plate', ['string'], [plateB]));
requireOk('B remains publishable after Move', getSliceResult(callJson, sliceB.receipt));
requireOk('select A after Move', callJson('orc_select_plate', ['string'], [plateA]));
requireStale('A presentation invalid after Move', getSliceResult(callJson, sliceA.receipt));

requireStatus('Undo Move', callJson('orc_history_undo'));
const afterUndoStamps = stampMap();
if (!(afterUndoStamps[plateA] > afterMoveStamps[plateA]) || afterUndoStamps[plateB] !== beforeMoveStamps[plateB])
  throw new Error(`Undo stamp scope failed: ${JSON.stringify({ afterMoveStamps, afterUndoStamps })}`);
requireOk('select B after Undo', callJson('orc_select_plate', ['string'], [plateB]));
requireOk('B remains publishable after Undo', getSliceResult(callJson, sliceB.receipt));
requireOk('select A after Undo', callJson('orc_select_plate', ['string'], [plateA]));
requireStale('A presentation invalid after Undo', getSliceResult(callJson, sliceA.receipt));

requireStatus('Redo Move', callJson('orc_history_redo'));
const afterRedoStamps = stampMap();
if (!(afterRedoStamps[plateA] > afterUndoStamps[plateA]) || afterRedoStamps[plateB] !== beforeMoveStamps[plateB])
  throw new Error(`Redo stamp scope failed: ${JSON.stringify({ afterUndoStamps, afterRedoStamps })}`);
requireOk('select B after Redo', callJson('orc_select_plate', ['string'], [plateB]));
requireOk('B remains publishable after Redo', getSliceResult(callJson, sliceB.receipt));
requireOk('select A after Redo', callJson('orc_select_plate', ['string'], [plateA]));
requireStale('A presentation invalid after Redo', getSliceResult(callJson, sliceA.receipt));

// An aborted transform must restore both the stamp and the previously valid
// presentation lifecycle.  The native core allocation is retained throughout.
snapshot = callJson('orc_get_plate_session_snapshot');
sliceA = requireOk('reslice A for abort proof', await callAsyncTask(callJson, 'orc_slice_plate',
  ['string', 'string', 'number', 'string'], ['{}', plateA, snapshot.input_revisions[plateA], 'null']));
requireOk('A valid before abort', getSliceResult(callJson, sliceA.receipt));
const beforeAbortStamps = stampMap();
const abortMove = requireOk('begin abort Move', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Move', 'project', JSON.stringify(context), '']));
const abortInstance = { ...nextInstance,
  offset: [nextInstance.offset[0] + 10, nextInstance.offset[1], nextInstance.offset[2]] };
const duringAbort = requireOk('apply abort Move', callJson('orc_set_model_transforms', ['string', 'string'],
  [abortMove.transactionId, JSON.stringify([{
    objectIdx: target.object_idx, volumeIdx: target.volume_idx, instanceIdx: target.instance_idx,
    instanceTransform: abortInstance, volumeTransform: target.volume_transform,
  }])]));
const duringAbortStamps = stampMap();
if (!(duringAbortStamps[plateA] > beforeAbortStamps[plateA]) || duringAbortStamps[plateB] !== beforeAbortStamps[plateB])
  throw new Error(`abort setup stamp scope failed: ${JSON.stringify({ beforeAbortStamps, duringAbortStamps, duringAbort })}`);
requireOk('abort Move', callJson('orc_history_abort', ['string'], [abortMove.transactionId]));
const afterAbortStamps = stampMap();
if (afterAbortStamps[plateA] !== beforeAbortStamps[plateA] || afterAbortStamps[plateB] !== beforeAbortStamps[plateB])
  throw new Error(`abort stamp rollback failed: ${JSON.stringify({ beforeAbortStamps, afterAbortStamps })}`);
requireOk('A presentation restored after abort', getSliceResult(callJson, sliceA.receipt));

// A part is shared by every instance of its object, including copies on other
// plates. A part edit submitted through one composite must invalidate both.
const object = callJson('orc_get_model_structure').objects[0];
const addCopy = requireOk('begin copy', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Add Instance', 'project', JSON.stringify(context), '']));
requireOk('add copy', callJson('orc_add_instance', ['number'], [object.id]));
requireStatus('commit copy', callJson('orc_history_commit', ['string', 'string'],
  [addCopy.transactionId, JSON.stringify(context)]).status);
const copyMesh = callJson('orc_get_model_mesh');
const copy = copyMesh.renderables.find(entry => entry.object_idx === 0 && entry.instance_idx === 1);
if (!copy) throw new Error('missing copied instance');
snapshot = callJson('orc_get_plate_session_snapshot');
const originA = snapshot.plates.find(plate => plate.plate_id === plateA).origin;
const originB = snapshot.plates.find(plate => plate.plate_id === plateB).origin;
const copyPosition = { ...copy.instance_transform,
  offset: [copy.instance_transform.offset[0] + originB[0] - originA[0],
    copy.instance_transform.offset[1] + originB[1] - originA[1], copy.instance_transform.offset[2]] };
delete copyPosition.matrix;
const moveCopy = requireOk('begin move copy', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Move Copy', 'project', JSON.stringify(context), '']));
requireOk('move copy to B', callJson('orc_set_model_transforms', ['string', 'string'],
  [moveCopy.transactionId, JSON.stringify([{ objectIdx: 0, volumeIdx: copy.volume_idx, instanceIdx: 1,
    instanceTransform: copyPosition, volumeTransform: copy.volume_transform }])]));
requireStatus('commit move copy', callJson('orc_history_commit', ['string', 'string'],
  [moveCopy.transactionId, JSON.stringify(context)]).status);
snapshot = callJson('orc_get_plate_session_snapshot');
if (!snapshot.instances.some(item => item.instance_id === object.instances[0].id && item.plate_id === plateA) ||
    !snapshot.instances.some(item => item.instance_id === copy.instance_id && item.plate_id === plateB))
  throw new Error(`instances not on separate plates: ${JSON.stringify(snapshot.instances)}`);
const original = callJson('orc_get_model_mesh').renderables.find(entry => entry.object_idx === 0 && entry.instance_idx === 0);
const part = { ...original.volume_transform, offset: [original.volume_transform.offset[0] + 1,
  original.volume_transform.offset[1], original.volume_transform.offset[2]] };
delete part.matrix;
const beforePart = stampMap();
const partTx = requireOk('begin part edit', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Move Part', 'project', JSON.stringify(context), '']));
const partResult = requireOk('edit shared part', callJson('orc_set_model_transforms', ['string', 'string'],
  [partTx.transactionId, JSON.stringify([{ objectIdx: 0, volumeIdx: original.volume_idx, instanceIdx: 0,
    instanceTransform: original.instance_transform, volumeTransform: part }])]));
const afterPart = stampMap();
if (!(afterPart[plateA] > beforePart[plateA] && afterPart[plateB] > beforePart[plateB]))
  throw new Error(`shared part must invalidate both instance plates: ${JSON.stringify({ beforePart, afterPart, partResult })}`);
requireStatus('commit part edit', callJson('orc_history_commit', ['string', 'string'],
  [partTx.transactionId, JSON.stringify(context)]).status);

console.log('transform plate invalidation PASS');
