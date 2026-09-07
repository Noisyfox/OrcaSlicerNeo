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
const tx = callJson('orc_history_begin', ['string', 'string', 'string'], ['Add Cube', 'project', JSON.stringify(context)]);
if (!tx.ok || typeof tx.transactionId !== 'string') throw new Error(JSON.stringify(tx));
const added = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'History Cube']);
if (!added.ok) throw new Error(JSON.stringify(added));
const committed = callJson('orc_history_commit', ['string', 'string'], [tx.transactionId, JSON.stringify(context)]);
if (!committed.canUndo) throw new Error(`commit did not enable undo: ${JSON.stringify(committed)}`);
const undone = callJson('orc_history_undo', [], []);
if (!undone.ok || undone.status.canRedo !== true) throw new Error(`undo failed: ${JSON.stringify(undone)}`);
const empty = callJson('orc_get_model_structure', [], []);
if (!empty.ok || empty.objects.length !== 0) throw new Error(`undo did not restore empty model: ${JSON.stringify(empty)}`);
const redone = callJson('orc_history_redo', [], []);
if (!redone.ok || !redone.status.canUndo) throw new Error(`redo failed: ${JSON.stringify(redone)}`);
const restored = callJson('orc_get_model_structure', [], []);
if (!restored.ok || restored.objects.length !== 1) throw new Error(`redo did not restore model: ${JSON.stringify(restored)}`);
console.log(`history smoke passed (${moduleArg})`);
