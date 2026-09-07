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
const tx = callJson('orc_history_begin', ['string', 'string', 'string'], ['Add Cubes', 'project', JSON.stringify(context)]);
if (!tx.ok || typeof tx.transactionId !== 'string') throw new Error(JSON.stringify(tx));
for (const name of ['History Cube A', 'History Cube B']) {
  const added = callJson('orc_add_shape', ['string', 'string'], ['Cube', name]);
  if (!added.ok) throw new Error(JSON.stringify(added));
}
const committed = callJson('orc_history_commit', ['string', 'string'], [tx.transactionId, JSON.stringify(context)]);
if (!committed.canUndo) throw new Error(`commit did not enable undo: ${JSON.stringify(committed)}`);
if (!Number.isFinite(committed.bytesUsed) || committed.bytesUsed <= 512)
  throw new Error(`history accounting omitted native restore storage: ${JSON.stringify(committed)}`);
const beforeEdit = callJson('orc_get_model_structure', [], []);
if (!beforeEdit.ok || beforeEdit.objects.length !== 2)
  throw new Error(`two-object baseline was not restored: ${JSON.stringify(beforeEdit)}`);

const editTx = callJson('orc_history_begin', ['string', 'string', 'string'], ['Toggle One Cube', 'project', JSON.stringify(context)]);
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
console.log(`history smoke passed (${moduleArg})`);
