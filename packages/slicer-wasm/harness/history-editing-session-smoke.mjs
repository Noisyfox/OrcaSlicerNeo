import { fixtureProfileOptions } from './profile-installer.mjs';
// Focused real-WASM coverage for the native history editing-session bridge.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [moduleArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node history-editing-session-smoke.mjs <out/orca_slice.js>');
const repoRoot = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(moduleArg))({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(repoRoot, 'packages/profile-resources/dist')));

function callJson(name, argTypes = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}

function check(label, condition, detail = '') {
  if (!condition) throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
  console.log(`history-session PASS ${label}`);
}

function requireOk(label, value) {
  check(label, value?.ok === true, JSON.stringify(value));
  return value;
}

function requireError(label, value) {
  check(label, value?.ok !== true && typeof value?.error === 'string', JSON.stringify(value));
  return value;
}

function historyStatus() {
  const value = callJson('orc_history_status');
  if (typeof value?.revision !== 'number' || !Array.isArray(value.undoEntries) ||
      !Array.isArray(value.redoEntries))
    throw new Error(`history status is invalid: ${JSON.stringify(value)}`);
  return value;
}

function openSession(options = '{}') {
  return callJson('orc_history_session_open', ['string'], [options]);
}

function closeSession(request) {
  return callJson('orc_history_session_close', ['string'], [JSON.stringify(request)]);
}

function sameJson(lhs, rhs) {
  return JSON.stringify(lhs) === JSON.stringify(rhs);
}

function observeProjectState() {
  const model = callJson('orc_get_model_structure');
  const plate = callJson('orc_get_plate_session_snapshot');
  const diagnostics = callJson('orc_history_restore_diagnostics');
  const history = historyStatus();
  if (model?.ok !== true || plate?.ok !== true || diagnostics?.ok === false)
    throw new Error(JSON.stringify({ model, plate, diagnostics, history }));
  return { model, plate, diagnostics, history };
}

function beginHistory(label) {
  return requireOk(`begin ${label}`, callJson('orc_history_begin',
    ['string', 'string', 'string', 'string'], [label, 'project', JSON.stringify(context), '']));
}

function addCube(label) {
  const begin = beginHistory(label);
  requireOk(`add ${label}`, callJson('orc_add_shape', ['string', 'string'], ['Cube', label]));
  const committed = callJson('orc_history_commit', ['string', 'string'],
    [begin.transactionId, JSON.stringify(context)]);
  if (committed?.status?.revision === undefined)
    throw new Error(`commit ${label} failed: ${JSON.stringify(committed)}`);
  return committed.status;
}

const context = {
  selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null,
  gizmo: null,
  nativeScopedConfig: {},
};

requireOk('initialize real WASM module', callJson('orc_init', ['string'], [fixtureProfileOptions(Module)]));
requireOk('clear fixture model', callJson('orc_clear_model'));
const reset = callJson('orc_history_reset', ['string'], [JSON.stringify(context)]);
check('fresh history has no session floor', reset.editingSession === null && reset.navigationFloor === null,
  JSON.stringify(reset));

const malformedOpenBefore = historyStatus();
for (const [label, options] of [
  ['reject missing options', ''],
  ['reject malformed options', '{'],
  ['reject non-object options', '[]'],
  ['reject unsupported options', '{"futureOption":true}'],
]) {
  requireError(label, openSession(options));
  check(`${label} leaves history unchanged`, sameJson(historyStatus(), malformedOpenBefore));
}

const afterFirstAdd = addCube('History A');
const firstEntryId = afterFirstAdd.undoEntries[0]?.id;
check('first transaction creates a real history entry', typeof firstEntryId === 'string' &&
  callJson('orc_get_model_structure').objects.length === 1, JSON.stringify(afterFirstAdd));
addCube('History B');
const undoB = requireOk('undo B to establish a retained Redo branch', callJson('orc_history_undo'));
const beforeEmptySession = historyStatus();
check('fixture has an earlier Undo and retained Redo', beforeEmptySession.canUndo && beforeEmptySession.canRedo &&
  beforeEmptySession.undoEntries.some((entry) => entry.id === firstEntryId), JSON.stringify(beforeEmptySession));
const savedAtEntry = callJson('orc_history_mark_saved', ['string'], [JSON.stringify(context)]);
check('mark the session entry saved', savedAtEntry.savedCheckpoint === savedAtEntry.cursor && savedAtEntry.dirty === false,
  JSON.stringify(savedAtEntry));

const activeTxForOpen = beginHistory('Refused session open');
const beforeRefusedOpen = historyStatus();
requireError('refuse open during an active native transaction', openSession());
check('refused open during a transaction leaves status unchanged', sameJson(historyStatus(), beforeRefusedOpen));
const abortedTx = callJson('orc_history_abort', ['string'], [activeTxForOpen.transactionId]);
requireOk('abort no-effect transaction after refused open', abortedTx);
check('aborted open conflict leaves no editing session', historyStatus().editingSession === null);
const beforeOpen = observeProjectState();

const opened = requireOk('open a no-effect session', openSession());
const sessionId = opened.sessionId;
check('session ID is a canonical opaque decimal handle', typeof sessionId === 'string' && /^hs-[1-9][0-9]*$/.test(sessionId),
  JSON.stringify(opened));
const openStatus = opened.status;
check('opening advances history metadata epoch once', openStatus.revision === beforeOpen.history.revision + 1,
  JSON.stringify({ before: beforeOpen.history.revision, after: openStatus.revision }));
check('opening captures the current timestamp as its reachable floor',
  openStatus.editingSession?.id === sessionId &&
  openStatus.editingSession.entryTimestamp === beforeOpen.history.cursor &&
  openStatus.editingSession.hasEffectiveCommit === false &&
  openStatus.navigationFloor === beforeOpen.history.cursor,
  JSON.stringify(openStatus));
const afterOpen = observeProjectState();
check('opening does not capture model state or change project inputs',
  sameJson(beforeOpen.model, afterOpen.model) && sameJson(beforeOpen.plate, afterOpen.plate) &&
  beforeOpen.diagnostics.serializedObjectCount === afterOpen.diagnostics.serializedObjectCount &&
  beforeOpen.diagnostics.serializedMeshCount === afterOpen.diagnostics.serializedMeshCount,
  JSON.stringify({ before: beforeOpen, after: afterOpen }));
check('opening retains the prior Redo branch and saved marker',
  sameJson(openStatus.redoEntries, beforeOpen.history.redoEntries) && openStatus.canRedo &&
  openStatus.savedCheckpoint === beforeOpen.history.savedCheckpoint && openStatus.dirty === beforeOpen.history.dirty,
  JSON.stringify({ before: beforeOpen.history, after: openStatus }));
check('opening hides Undo entries below its floor', !openStatus.canUndo && openStatus.undoEntries.length === 0 &&
  openStatus.undoLabel === null, JSON.stringify(openStatus));

const duplicateOpenBefore = historyStatus();
requireError('reject duplicate open while a session is active', openSession());
check('duplicate open leaves history unchanged', sameJson(historyStatus(), duplicateOpenBefore));

const malformedCloseRequests = [
  ['reject missing session ID', {}],
  ['reject numeric session ID', { sessionId: 1 }],
  ['reject zero session ID', { sessionId: 'hs-0' }],
  ['reject leading zero session ID', { sessionId: 'hs-01' }],
  ['reject trailing junk in session ID', { sessionId: 'hs-1tail' }],
  ['reject wrong session ID prefix', { sessionId: 'entry-1' }],
  ['reject overflowing session ID', { sessionId: 'hs-18446744073709551616' }],
  ['reject embedded NUL and trailing session ID data', { sessionId: `${sessionId}\0tail` }],
  ['reject empty close label', { sessionId, label: '' }],
  ['reject unsupported close field', { sessionId, unsupported: true }],
];
for (const [label, request] of malformedCloseRequests) {
  const before = historyStatus();
  requireError(label, closeSession(request));
  check(`${label} leaves history unchanged`, sameJson(historyStatus(), before));
}

const beforeFloorRejects = observeProjectState();
requireError('refuse Undo at the session floor', callJson('orc_history_undo'));
requireError('refuse a direct Undo jump below the session floor',
  callJson('orc_history_jump', ['string', 'string'], [firstEntryId, 'undo']));
const afterFloorRejects = observeProjectState();
check('floor refusals happen before model capture or project mutation',
  sameJson(beforeFloorRejects.model, afterFloorRejects.model) &&
  sameJson(beforeFloorRejects.plate, afterFloorRejects.plate) &&
  beforeFloorRejects.diagnostics.serializedObjectCount === afterFloorRejects.diagnostics.serializedObjectCount &&
  beforeFloorRejects.diagnostics.serializedMeshCount === afterFloorRejects.diagnostics.serializedMeshCount &&
  beforeFloorRejects.history.revision === afterFloorRejects.history.revision,
  JSON.stringify({ before: beforeFloorRejects, after: afterFloorRejects }));

const activeTxForClose = beginHistory('Refused session close');
const beforeRefusedClose = historyStatus();
requireError('refuse close during an active native transaction', closeSession({ sessionId }));
check('refused close preserves the active session and history', sameJson(historyStatus(), beforeRefusedClose));
const abortedCloseTx = callJson('orc_history_abort', ['string'], [activeTxForClose.transactionId]);
requireOk('abort no-effect transaction after refused close', abortedCloseTx);
check('session remains open after the refused close', historyStatus().editingSession?.id === sessionId);

const beforeEmptyClose = historyStatus();
const emptyClosed = requireOk('close no-effect session and preserve Redo', closeSession({ sessionId }));
const emptyCloseStatus = emptyClosed.status;
check('empty close advances history metadata epoch once', emptyCloseStatus.revision === beforeEmptyClose.revision + 1,
  JSON.stringify({ before: beforeEmptyClose.revision, after: emptyCloseStatus.revision }));
check('empty close preserves Redo, cursor, saved checkpoint, and dirty state',
  sameJson(emptyCloseStatus.redoEntries, beforeEmptyClose.redoEntries) &&
  emptyCloseStatus.cursor === beforeEmptyClose.cursor &&
  emptyCloseStatus.savedCheckpoint === beforeEmptyClose.savedCheckpoint &&
  emptyCloseStatus.dirty === beforeEmptyClose.dirty,
  JSON.stringify({ before: beforeEmptyClose, after: emptyCloseStatus }));
check('closed status clears session metadata and the temporary floor',
  emptyCloseStatus.editingSession === null && emptyCloseStatus.navigationFloor === null,
  JSON.stringify(emptyCloseStatus));
requireError('reject duplicate close with a stale session ID', closeSession({ sessionId }));

const effectiveOpen = requireOk('open session for a non-paint transaction', openSession());
const effectiveSessionId = effectiveOpen.sessionId;
requireOk('redo pre-existing operation inside the session', callJson('orc_history_redo'));
const afterEffectiveCommit = addCube('Interleaved non-paint edit');
check('ordinary transaction commit sets the session lifetime latch',
  afterEffectiveCommit.editingSession?.id === effectiveSessionId &&
  afterEffectiveCommit.editingSession.hasEffectiveCommit === true,
  JSON.stringify(afterEffectiveCommit));
const savedRedoState = callJson('orc_history_mark_saved', ['string'], [JSON.stringify(context)]);
check('save while open marks the committed mixed-history state',
  savedRedoState.savedCheckpoint === savedRedoState.cursor && savedRedoState.dirty === false,
  JSON.stringify(savedRedoState));
requireOk('Undo the committed non-paint edit', callJson('orc_history_undo'));
requireOk('Undo the pre-existing Redo operation back to session entry', callJson('orc_history_undo'));
const atEntryAfterEffectiveCommit = historyStatus();
check('Undo to the entry preserves the effective-commit latch and both Redo entries',
  atEntryAfterEffectiveCommit.cursor === effectiveOpen.status.cursor &&
  atEntryAfterEffectiveCommit.editingSession?.hasEffectiveCommit === true &&
  atEntryAfterEffectiveCommit.redoEntries.length === 2 &&
  atEntryAfterEffectiveCommit.dirty === true,
  JSON.stringify(atEntryAfterEffectiveCommit));
const beforeEffectiveClose = observeProjectState();
const effectiveClosed = requireOk('close effective session and drop all Redo', closeSession({ sessionId: effectiveSessionId }));
const effectiveCloseStatus = effectiveClosed.status;
check('effective close removes the complete Redo branch',
  effectiveCloseStatus.canRedo === false && effectiveCloseStatus.redoEntries.length === 0,
  JSON.stringify(effectiveCloseStatus));
check('effective close stays at the session-entry project and releases floor',
  effectiveCloseStatus.cursor === effectiveOpen.status.cursor &&
  effectiveCloseStatus.editingSession === null && effectiveCloseStatus.navigationFloor === null &&
  effectiveCloseStatus.canUndo === true &&
  sameJson(beforeEffectiveClose.model.objects.map((object) => object.id),
    callJson('orc_get_model_structure').objects.map((object) => object.id)),
  JSON.stringify({ before: beforeEffectiveClose, after: effectiveCloseStatus }));
check('close invalidates a saved checkpoint removed with the Redo branch',
  effectiveCloseStatus.savedCheckpoint === null && effectiveCloseStatus.savedCheckpointEvicted === true &&
  effectiveCloseStatus.dirty === true, JSON.stringify(effectiveCloseStatus));

const resetSession = requireOk('open session before explicit history reset', openSession());
const resetStaleId = resetSession.sessionId;
const resetStatus = callJson('orc_history_reset', ['string'], [JSON.stringify(context)]);
check('history reset clears the editing session and navigation floor',
  resetStatus.editingSession === null && resetStatus.navigationFloor === null,
  JSON.stringify(resetStatus));
const afterReset = historyStatus();
requireError('history reset makes its old session ID stale', closeSession({ sessionId: resetStaleId }));
check('stale close after reset leaves the new baseline unchanged', sameJson(historyStatus(), afterReset));
const postResetOpen = requireOk('open a fresh session after reset', openSession());
check('session IDs remain fresh across history clear', postResetOpen.sessionId !== resetStaleId,
  JSON.stringify({ resetStaleId, newId: postResetOpen.sessionId }));
requireOk('close fresh post-reset session', closeSession({ sessionId: postResetOpen.sessionId }));

const exported = requireOk('export real model for project replacement', callJson('orc_export_project'));
const projectBytes = Module.HEAPU8.slice(Number(exported.bytes_ptr),
  Number(exported.bytes_ptr) + Number(exported.bytes_length));
Module._free(Number(exported.bytes_ptr));
const replacementOpen = requireOk('open session before project replacement', openSession());
const replacementPtr = Number(Module._malloc(projectBytes.byteLength));
Module.HEAPU8.set(projectBytes, replacementPtr);
let replacement;
try {
  replacement = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [replacementPtr, projectBytes.byteLength, 0, 'history-session-replacement.3mf']);
} finally {
  Module._free(replacementPtr);
}
requireOk('replace project through the existing native load path', replacement);
const replacedStatus = historyStatus();
check('project replacement clears session metadata, floor, and dirty state',
  replacedStatus.editingSession === null && replacedStatus.navigationFloor === null &&
  replacedStatus.dirty === false && replacedStatus.canUndo === false && replacedStatus.canRedo === false,
  JSON.stringify(replacedStatus));
requireError('project replacement makes its old session ID stale', closeSession({ sessionId: replacementOpen.sessionId }));
const postReplacement = requireOk('open session after project replacement', openSession());
check('project replacement does not reuse a stale session ID', postReplacement.sessionId !== replacementOpen.sessionId,
  JSON.stringify({ oldId: replacementOpen.sessionId, newId: postReplacement.sessionId }));
requireOk('close fresh post-replacement session', closeSession({ sessionId: postReplacement.sessionId }));

console.log('history editing-session bridge smoke passed against real serial WASM');
