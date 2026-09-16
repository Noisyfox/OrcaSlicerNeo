// Step 7 real-WASM history/runtime reconciliation smoke.
//
// Plate B keeps its valid runtime result while history restores Plate A.  A
// changed Plate A never republishes its retained presentation on Undo/Redo,
// and an Add Plate Undo/Redo creates a fresh invalid runtime entry for the
// restored stable id.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { callAsyncTask, exportGcode, getSliceResult } from './async-task-mailbox.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [moduleArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node history-plate-runtime-smoke.mjs <out/orca_slice.js>');
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
function requireStale(label, value) {
  if (value?.ok || !['stale', 'unavailable'].includes(value?.status))
    throw new Error(`${label}: expected stale/unavailable, got ${JSON.stringify(value)}`);
}
function requireStatus(label, value) {
  if (value?.error) throw new Error(`${label}: ${JSON.stringify(value)}`);
  return value;
}

const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, projectConfigOverlay: {} };
requireOk('init', callJson('orc_init', ['string'], ['{"log_level":"error"}']));
requireOk('clear model', callJson('orc_clear_model'));
const historyBaseline = callJson('orc_history_reset', ['string'], [JSON.stringify(context)]);
if (historyBaseline.error) throw new Error(`history baseline: ${JSON.stringify(historyBaseline)}`);

const addATx = requireOk('begin Plate A object', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Add Cube A', 'project', JSON.stringify(context), '']));
requireOk('add Plate A object', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'History A']));
requireStatus('commit Plate A object', callJson('orc_history_commit', ['string', 'string'],
  [addATx.transactionId, JSON.stringify(context)]));
const initial = callJson('orc_get_plate_session_snapshot');
const plateA = initial.current_plate_id;
const addPlateTx = requireOk('begin Add Plate', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Add Plate', 'project', JSON.stringify(context), '']));
requireOk('add Plate B', callJson('orc_add_plate'));
const afterAddPlate = callJson('orc_get_plate_session_snapshot');
const plateB = afterAddPlate.current_plate_id;
requireStatus('commit Add Plate', callJson('orc_history_commit', ['string', 'string'],
  [addPlateTx.transactionId, JSON.stringify(context)]));
const addBTx = requireOk('begin Plate B object', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Add Cube B', 'project', JSON.stringify(context), '']));
requireOk('add Plate B object', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'History B']));
requireStatus('commit Plate B object', callJson('orc_history_commit', ['string', 'string'],
  [addBTx.transactionId, JSON.stringify(context)]));

let session = callJson('orc_get_plate_session_snapshot');
const sliceTarget = (plateId) => [plateId, session.input_revisions[plateId]];
const stamps = () => callJson('orc_get_plate_session_snapshot').input_revisions;
requireOk('select A', callJson('orc_select_plate', ['string'], [plateA]));
session = callJson('orc_get_plate_session_snapshot');
const sliceA = requireOk('slice A', await callAsyncTask(callJson, 'orc_slice_plate',
  ['string', 'string', 'number'], ['{}', ...sliceTarget(plateA)]));
requireOk('select B', callJson('orc_select_plate', ['string'], [plateB]));
session = callJson('orc_get_plate_session_snapshot');
const sliceB = requireOk('slice B', await callAsyncTask(callJson, 'orc_slice_plate',
  ['string', 'string', 'number'], ['{}', ...sliceTarget(plateB)]));
requireOk('B presentation before history', getSliceResult(callJson, sliceB.receipt));
const slicedStamps = stamps();

requireOk('select A for edit', callJson('orc_select_plate', ['string'], [plateA]));
const editTx = requireOk('begin A edit', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Add Cube A', 'project', JSON.stringify(context), '']));
requireOk('change A', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'History A changed']));
requireStatus('commit A edit', callJson('orc_history_commit', ['string', 'string'],
  [editTx.transactionId, JSON.stringify(context)]));
const afterEditStamps = stamps();
if (!(afterEditStamps[plateA] > slicedStamps[plateA]) || afterEditStamps[plateB] !== slicedStamps[plateB])
  throw new Error(`edit stamp reconciliation failed: ${JSON.stringify({ slicedStamps, afterEditStamps })}`);

requireStatus('Undo A edit', callJson('orc_history_undo'));
const afterUndoStamps = stamps();
if (!(afterUndoStamps[plateA] > afterEditStamps[plateA]) || afterUndoStamps[plateB] !== slicedStamps[plateB])
  throw new Error(`undo stamp reconciliation regressed or invalidated B: ${JSON.stringify({ afterEditStamps, afterUndoStamps })}`);
requireOk('select retained B after Undo', callJson('orc_select_plate', ['string'], [plateB]));
requireOk('B remains publishable after Undo', getSliceResult(callJson, sliceB.receipt));
requireOk('select changed A after Undo', callJson('orc_select_plate', ['string'], [plateA]));
requireStale('A never republishes historical presentation on Undo', getSliceResult(callJson, sliceA.receipt));
requireStale('A export rejects the pre-history target after Undo', exportGcode(callJson, sliceA.receipt));

requireStatus('Redo A edit', callJson('orc_history_redo'));
const afterRedoStamps = stamps();
if (!(afterRedoStamps[plateA] > afterUndoStamps[plateA]) || afterRedoStamps[plateB] !== slicedStamps[plateB])
  throw new Error(`redo stamp reconciliation regressed or invalidated B: ${JSON.stringify({ afterUndoStamps, afterRedoStamps })}`);
requireOk('select retained B after Redo', callJson('orc_select_plate', ['string'], [plateB]));
requireOk('B remains publishable after Redo', getSliceResult(callJson, sliceB.receipt));
requireOk('select changed A after Redo', callJson('orc_select_plate', ['string'], [plateA]));
requireStale('A never republishes historical presentation on Redo', getSliceResult(callJson, sliceA.receipt));

// Delete Plate's Undo restores B with the same session-stable id, but its
// runtime Print/result is a fresh invalid entry and cannot publish until an
// explicit slice. Redo removes it again.
const deleteTx = requireOk('begin Delete Plate B', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Delete Plate B', 'project', JSON.stringify(context), '']));
requireOk('delete Plate B', callJson('orc_delete_plate', ['string'], [plateB]));
requireStatus('commit Delete Plate B', callJson('orc_history_commit', ['string', 'string'],
  [deleteTx.transactionId, JSON.stringify(context)]));
requireStatus('Undo Delete Plate B', callJson('orc_history_undo'));
const afterRestore = callJson('orc_get_plate_session_snapshot');
if (!afterRestore.plates.some((plate) => plate.plate_id === plateB))
  throw new Error(`Delete Plate Undo did not restore stable plate id: ${JSON.stringify(afterRestore)}`);
requireOk('select restored B', callJson('orc_select_plate', ['string'], [plateB]));
const restoredStamps = afterRestore.input_revisions;
// Deleting B can reflow A's world origin, so A is allowed (and expected) to
// receive its own fresh stamp; it must never regress.  B is newly restored.
if (!(restoredStamps[plateB] > afterRedoStamps[plateB]) || restoredStamps[plateA] < afterRedoStamps[plateA])
  throw new Error(`delete undo stamp reconciliation failed: ${JSON.stringify({ afterRedoStamps, restoredStamps })}`);
requireStale('restored B requires a fresh slice', getSliceResult(callJson, sliceB.receipt));
requireStatus('Redo Delete Plate B', callJson('orc_history_redo'));
const afterRemove = callJson('orc_get_plate_session_snapshot');
if (afterRemove.plates.some((plate) => plate.plate_id === plateB))
  throw new Error(`Delete Plate Redo retained deleted plate: ${JSON.stringify(afterRemove)}`);

console.log('history plate runtime PASS');
