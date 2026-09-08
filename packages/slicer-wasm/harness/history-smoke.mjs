// Step 2 real bridge history round trip.  Deliberately does not export 3MF.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [moduleArg, profileRootArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node history-smoke.mjs <out/orca_slice.js> [profile-package-root]');
const repoRoot = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(moduleArg))({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(profileRootArg ?? `${repoRoot}/packages/profile-resources/dist`)));
function callJson(name, argTypes, args) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, projectConfigOverlay: {} };
const init = callJson('orc_init', ['string'], ['{"log_level":"error"}']);
if (!init.ok) throw new Error(JSON.stringify(init));
const tx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'], ['Add Cubes', 'project', JSON.stringify(context), '']);
if (!tx.ok || typeof tx.transactionId !== 'string') throw new Error(JSON.stringify(tx));
for (const name of ['History Cube A', 'History Cube B']) {
  const added = callJson('orc_add_shape', ['string', 'string'], ['Cube', name]);
  if (!added.ok) throw new Error(JSON.stringify(added));
}
const committed = callJson('orc_history_commit', ['string', 'string'], [tx.transactionId, JSON.stringify(context)]);
if (!committed.canUndo) throw new Error(`commit did not enable undo: ${JSON.stringify(committed)}`);
if (!Number.isFinite(committed.bytesUsed) || committed.bytesUsed <= 512)
  throw new Error(`history accounting omitted native restore storage: ${JSON.stringify(committed)}`);
for (const key of ['optionalBytesReleased', 'evictedEntryCount', 'bytesUsed', 'byteBudget']) {
  if (!Number.isSafeInteger(committed[key]) || committed[key] < 0)
    throw new Error(`history resource diagnostic ${key} is not deterministic: ${JSON.stringify(committed)}`);
}
if (typeof committed.oldestRetainedEntryId !== 'string' ||
    typeof committed.oversizedEntryRetained !== 'boolean')
  throw new Error(`history retention diagnostics are incomplete: ${JSON.stringify(committed)}`);
const beforeEdit = callJson('orc_get_model_structure', [], []);
if (!beforeEdit.ok || beforeEdit.objects.length !== 2)
  throw new Error(`two-object baseline was not restored: ${JSON.stringify(beforeEdit)}`);

// Plate-session state is part of the same history frame as the model.  This
// is intentionally exercised before the model-only edits below: the old
// bridge restored the model but left the live plate collection untouched.
const plateBefore = callJson('orc_get_plate_session_snapshot', [], []);
if (!plateBefore.ok || plateBefore.plates.length !== 1)
  throw new Error(`single-plate history baseline was not restored: ${JSON.stringify(plateBefore)}`);
const plateTx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Add Plate', 'project', JSON.stringify(context), '']);
if (!plateTx.ok || typeof plateTx.transactionId !== 'string') throw new Error(JSON.stringify(plateTx));
const plateAdded = callJson('orc_add_plate', [], []);
if (!plateAdded.ok || plateAdded.plates.length !== 2)
  throw new Error(`plate add did not create two plates: ${JSON.stringify(plateAdded)}`);
const plateCommitted = callJson('orc_history_commit', ['string', 'string'],
  [plateTx.transactionId, JSON.stringify(context)]);
if (!plateCommitted.canUndo) throw new Error(`plate history commit failed: ${JSON.stringify(plateCommitted)}`);
const plateUndone = callJson('orc_history_undo', [], []);
const plateAfterUndo = callJson('orc_get_plate_session_snapshot', [], []);
if (!plateUndone.ok || !plateAfterUndo.ok || plateAfterUndo.plates.length !== 1)
  throw new Error(`plate undo did not restore one plate: ${JSON.stringify({ plateUndone, plateAfterUndo })}`);
const plateRedone = callJson('orc_history_redo', [], []);
const plateAfterRedo = callJson('orc_get_plate_session_snapshot', [], []);
if (!plateRedone.ok || !plateAfterRedo.ok || plateAfterRedo.plates.length !== 2)
  throw new Error(`plate redo did not restore two plates: ${JSON.stringify({ plateRedone, plateAfterRedo })}`);
if (plateAfterRedo.current_plate_id !== plateAdded.current_plate_id ||
    plateAfterRedo.plates.map((plate) => plate.plate_id).join(',') !==
      plateAdded.plates.map((plate) => plate.plate_id).join(',') ||
    JSON.stringify(plateAfterRedo.input_revisions) !== JSON.stringify(plateAdded.input_revisions))
  throw new Error(`plate redo did not restore stable IDs/revisions: ${JSON.stringify({ plateAdded, plateAfterRedo })}`);

const configuredPlateId = plateAfterRedo.current_plate_id;
const configTx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Plate Config', 'project', JSON.stringify(context), '']);
if (!configTx.ok || typeof configTx.transactionId !== 'string') throw new Error(JSON.stringify(configTx));
const configured = callJson('orc_set_project_config_override',
  ['string', 'string', 'string', 'string'], ['plate', configuredPlateId, 'layer_height', '0.3']);
if (!configured.ok || configured.plate_session?.plates?.every((plate) =>
    plate.plate_id !== configuredPlateId || plate.settings.layer_height !== '0.3'))
  throw new Error(`plate configuration did not update the authoritative session: ${JSON.stringify(configured)}`);
const configuredCommit = callJson('orc_history_commit', ['string', 'string'],
  [configTx.transactionId, JSON.stringify(context)]);
const configuredAfter = callJson('orc_get_plate_session_snapshot', [], []);
if (!configuredCommit.canUndo || configuredAfter.plates.find((plate) => plate.plate_id === configuredPlateId)?.settings?.layer_height !== '0.3')
  throw new Error(`plate configuration history commit failed: ${JSON.stringify({ configuredCommit, configuredAfter })}`);
const configUndo = callJson('orc_history_undo', [], []);
const configAfterUndo = callJson('orc_get_plate_session_snapshot', [], []);
if (!configUndo.ok || configAfterUndo.plates.find((plate) => plate.plate_id === configuredPlateId)?.settings?.layer_height === '0.3')
  throw new Error(`plate configuration undo did not restore the prior session: ${JSON.stringify({ configUndo, configAfterUndo })}`);
const configRedo = callJson('orc_history_redo', [], []);
const configAfterRedo = callJson('orc_get_plate_session_snapshot', [], []);
if (!configRedo.ok || configAfterRedo.plates.find((plate) => plate.plate_id === configuredPlateId)?.settings?.layer_height !== '0.3')
  throw new Error(`plate configuration redo did not restore the session: ${JSON.stringify({ configRedo, configAfterRedo })}`);
const projectHistoryCountBeforeCoalesced = configRedo.status.undoEntries.length;

// The coalescing path is intentionally dormant in product UI, but the real
// bridge must keep a nested child inside one semantic outer history entry.
const outer = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Coalesced edit', 'project', JSON.stringify(context), '']);
if (!outer.ok || typeof outer.transactionId !== 'string') throw new Error(JSON.stringify(outer));
const outerEdit = callJson('orc_set_object_printable', ['number', 'number'], [beforeEdit.objects[0].id, 0]);
if (!outerEdit.ok) throw new Error(JSON.stringify(outerEdit));
const child = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Coalesced child', 'project', JSON.stringify(context),
    JSON.stringify({ coalesce: true, parentTransactionId: outer.transactionId })]);
if (!child.ok || typeof child.transactionId !== 'string') throw new Error(JSON.stringify(child));
const childEdit = callJson('orc_set_object_printable', ['number', 'number'], [beforeEdit.objects[1].id, 0]);
if (!childEdit.ok) throw new Error(JSON.stringify(childEdit));
const childCommit = callJson('orc_history_commit', ['string', 'string'], [child.transactionId, JSON.stringify(context)]);
if (childCommit.activeTransactionId !== outer.transactionId)
  throw new Error(`coalesced child escaped outer transaction: ${JSON.stringify(childCommit)}`);
const coalesced = callJson('orc_history_commit', ['string', 'string'], [outer.transactionId, JSON.stringify(context)]);
if (!coalesced.canUndo || coalesced.undoEntries.length !== projectHistoryCountBeforeCoalesced + 1)
  throw new Error(`coalesced outer did not publish one entry: ${JSON.stringify(coalesced)}`);
const coalescedUndo = callJson('orc_history_undo', [], []);
if (!coalescedUndo.ok) throw new Error(`coalesced undo failed: ${JSON.stringify(coalescedUndo)}`);
const coalescedRestored = callJson('orc_get_model_structure', [], []);
if (!coalescedRestored.ok || coalescedRestored.objects.some((object) => object.printable !== true))
  throw new Error(`coalesced undo did not restore both objects: ${JSON.stringify(coalescedRestored)}`);
const coalescedRedo = callJson('orc_history_redo', [], []);
if (!coalescedRedo.ok) throw new Error(`coalesced redo failed: ${JSON.stringify(coalescedRedo)}`);
// Leave the fixture at its pristine state for the remaining independent
// transaction checks below.
const coalescedReset = callJson('orc_history_undo', [], []);
if (!coalescedReset.ok) throw new Error(`coalesced reset failed: ${JSON.stringify(coalescedReset)}`);

const editTx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'], ['Toggle One Cube', 'project', JSON.stringify(context), '']);
if (!editTx.ok || typeof editTx.transactionId !== 'string') throw new Error(JSON.stringify(editTx));
const targetId = beforeEdit.objects[0].id;
const edited = callJson('orc_set_object_printable', ['number', 'number'], [targetId, 0]);
if (!edited.ok) throw new Error(JSON.stringify(edited));
const editedCommit = callJson('orc_history_commit', ['string', 'string'], [editTx.transactionId, JSON.stringify(context)]);
if (!editedCommit.canUndo || editedCommit.canRedo)
  throw new Error(`one-object edit did not commit: ${JSON.stringify(editedCommit)}`);
const undone = callJson('orc_history_undo', [], []);
if (!undone.ok || undone.status.canRedo !== true) throw new Error(`undo failed: ${JSON.stringify(undone)}`);
const restoredBeforeEdit = callJson('orc_get_model_structure', [], []);
if (!restoredBeforeEdit.ok || restoredBeforeEdit.objects.length !== 2 ||
    restoredBeforeEdit.objects.some((object) => object.printable !== true))
  throw new Error(`undo did not rebuild the exact two-object model: ${JSON.stringify(restoredBeforeEdit)}`);
const redone = callJson('orc_history_redo', [], []);
if (!redone.ok || !redone.status.canUndo) throw new Error(`redo failed: ${JSON.stringify(redone)}`);
const restored = callJson('orc_get_model_structure', [], []);
if (!restored.ok || restored.objects.length !== 2 || restored.objects[0].printable !== false ||
    restored.objects[1].printable !== true)
  throw new Error(`redo did not rebuild the one-object edit: ${JSON.stringify(restored)}`);

// Transform history uses the same transaction boundary as the shared app.
// Exercise each semantic transform category against the real bridge and
// verify that Undo/Redo restores the exact native model version.
function modelMesh() {
  const result = callJson('orc_get_model_mesh', [], []);
  if (!result.ok || !result.objects?.length) throw new Error(`mesh unavailable: ${JSON.stringify(result)}`);
  return result.objects[0];
}
function cloneTransform(transform) {
  return JSON.parse(JSON.stringify(transform));
}
function assertTransformEqual(actual, expected, label) {
  for (const field of ['offset', 'rotation', 'scale', 'mirror']) {
    const values = actual[field];
    const target = expected[field];
    if (!Array.isArray(values) || values.length !== target.length ||
        values.some((value, index) => Math.abs(value - target[index]) > 1e-9))
      throw new Error(`${label} ${field} mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
function commitTransform(label, transform) {
  const started = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
    [label, 'project', JSON.stringify(context), '']);
  if (!started.ok || typeof started.transactionId !== 'string') throw new Error(JSON.stringify(started));
  const result = callJson('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'],
    [0, 0, 0, JSON.stringify(transform), JSON.stringify(modelMesh().volume_transform)]);
  if (!result.ok) throw new Error(`${label} transform failed: ${JSON.stringify(result)}`);
  const status = callJson('orc_history_commit', ['string', 'string'],
    [started.transactionId, JSON.stringify(context)]);
  if (!status.canUndo || status.canRedo) throw new Error(`${label} commit failed: ${JSON.stringify(status)}`);
  return status;
}
const transformCases = [
  ['Move', (transform) => ({ ...transform, offset: [transform.offset[0] + 5, transform.offset[1], transform.offset[2]] })],
  ['Rotate', (transform) => ({ ...transform, rotation: [transform.rotation[0], transform.rotation[1], transform.rotation[2] + 0.25] })],
  ['Scale', (transform) => ({ ...transform, scale: [transform.scale[0] * 1.25, transform.scale[1], transform.scale[2]] })],
  ['Drop to Bed', (transform) => ({ ...transform, offset: [transform.offset[0], transform.offset[1], transform.offset[2] - 2] })],
  ['Reset', (transform) => ({ ...transform, offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })],
];
for (const [label, edit] of transformCases) {
  const before = modelMesh();
  const base = cloneTransform(before.instance_transform);
  // Matrix is authoritative when present; the category checks intentionally
  // exercise the bridge's TRS transform payload.
  delete base.matrix;
  const next = edit(base);
  commitTransform(label, next);
  const committedTransform = modelMesh().instance_transform;
  assertTransformEqual(committedTransform, next, `${label} final transform`);
  const undoneTransform = callJson('orc_history_undo', [], []);
  if (!undoneTransform.ok) throw new Error(`${label} undo failed: ${JSON.stringify(undoneTransform)}`);
  const restoredTransform = modelMesh().instance_transform;
  assertTransformEqual(restoredTransform, before.instance_transform, `${label} undo`);
  const redoneTransform = callJson('orc_history_redo', [], []);
  if (!redoneTransform.ok) throw new Error(`${label} redo failed: ${JSON.stringify(redoneTransform)}`);
  assertTransformEqual(modelMesh().instance_transform, next, `${label} redo`);
}
// Branching after undo must truncate the old redo entry and preserve the new
// transform as the sole redo target.
const branchBase = cloneTransform(modelMesh().instance_transform);
delete branchBase.matrix;
const branchFirst = {
  ...branchBase,
  offset: [branchBase.offset[0] + 3, branchBase.offset[1], branchBase.offset[2]],
};
commitTransform('Branch Move', branchFirst);
const branchUndo = callJson('orc_history_undo', [], []);
if (!branchUndo.ok || branchUndo.status.canRedo !== true)
  throw new Error(`branch undo did not expose redo: ${JSON.stringify(branchUndo)}`);
assertTransformEqual(modelMesh().instance_transform, branchBase, 'branch undo');
const branchReplacement = {
  ...branchBase,
  offset: [branchBase.offset[0] + 7, branchBase.offset[1], branchBase.offset[2]],
};
const branchCommit = commitTransform('Branch Replacement', branchReplacement);
if (branchCommit.canRedo)
  throw new Error(`branch commit retained stale redo: ${JSON.stringify(branchCommit)}`);
assertTransformEqual(modelMesh().instance_transform, branchReplacement, 'branch replacement');
console.log(`history smoke passed (${moduleArg})`);
