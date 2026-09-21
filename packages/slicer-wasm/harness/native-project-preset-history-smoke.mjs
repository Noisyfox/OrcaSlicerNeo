// Focused real-WASM coverage for native Project Print-preset materialization.
// Ordinary Project print edits must create a native project-embedded child only
// when the edit changes the effective value, and history Undo/Redo must restore
// both that child and the selected native preset without a session sidecar.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';

const [moduleArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node native-project-preset-history-smoke.mjs <out/orca_slice.js>');
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
function check(label, condition, detail = '') {
  if (!condition) throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
  console.log(`project-preset PASS ${label}`);
}
function presetSnapshot() {
  return requireOk('preset snapshot', callJson('orc_get_preset_snapshot'));
}
function nativeSnapshot() {
  return requireOk('native scoped snapshot', callJson('orc_get_native_scoped_config'))
    .native_scoped_config.snapshot;
}

requireOk('init', callJson('orc_init', ['string'], ['{"log_level":"error"}']));
requireOk('clear model', callJson('orc_clear_model'));
const historyContext = {
  selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null,
  gizmo: null,
  nativeScopedConfig: {},
};
const reset = callJson('orc_history_reset', ['string'], [JSON.stringify(historyContext)]);
check('reset history', reset.canUndo === false && reset.canRedo === false, JSON.stringify(reset));

const before = presetSnapshot();
const parentName = before.print?.name;
check('baseline has a selected non-embedded Print profile', typeof parentName === 'string' && parentName.length > 0,
  JSON.stringify(before.print));

// A no-op ordinary Print mutation must not materialize a child.
const sameValue = String(before.project_config?.layer_height ?? '0.2');
const noOp = setNativeScopedConfig(callJson, 'project', undefined, 'layer_height', sameValue);
check('equal ordinary Project value is a no-op', noOp.ok === true && presetSnapshot().print?.name === parentName,
  JSON.stringify({ noOp, print: presetSnapshot().print }));

// Materialization happens before target resolution so the native child is
// available to the real mutation. If a later target fails, the selection,
// child catalog, and scoped value must all roll back together.
const failedAfterMaterialization = callJson('orc_mutate_native_scoped_config', ['string'], [JSON.stringify({
  version: 1,
  operation: 'set',
  targets: [{ scope: 'project' }, { scope: 'object', id: '999999999' }],
  key: 'layer_height',
  value: '0.24',
})]);
const failedSnapshot = presetSnapshot();
const failedNative = nativeSnapshot();
check('failed Project Print mutation rolls back native materialization',
  failedAfterMaterialization.ok === false && failedAfterMaterialization.error_code === 'unsupported_reference' &&
  failedSnapshot.print?.name === parentName && failedNative.project?.layer_height === undefined,
  JSON.stringify({ failedAfterMaterialization, failedSnapshot, failedNative }));

const tx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Project Print override', 'project', JSON.stringify(historyContext), '']);
requireOk('begin Project Print history transaction', tx);
const changed = setNativeScopedConfig(callJson, 'project', undefined, 'layer_height', '0.24');
requireOk('set ordinary Project Print value', changed);
const afterMutation = presetSnapshot();
const childName = afterMutation.print?.name;
check('first real ordinary Project mutation selects a project-embedded child',
  childName && childName !== parentName && /\(Project\)/.test(childName),
  JSON.stringify({ parentName, childName, print: afterMutation.print }));
const committed = callJson('orc_history_commit', ['string', 'string'], [tx.transactionId, JSON.stringify(historyContext)]);
check('Project Print history transaction commits', committed.canUndo === true, JSON.stringify(committed));
check('ordinary Project value is a native scoped diff', nativeSnapshot().project.layer_height === '0.24',
  JSON.stringify(nativeSnapshot()));

const undo = requireOk('undo Project Print history', callJson('orc_history_undo'));
const afterUndo = presetSnapshot();
check('Undo restores the parent Print selection', afterUndo.print?.name === parentName,
  JSON.stringify({ expected: parentName, actual: afterUndo.print?.name, undo }));
check('Undo removes the project Print diff', !Object.hasOwn(nativeSnapshot().project, 'layer_height'),
  JSON.stringify(nativeSnapshot()));
check('Undo context records no project-embedded Print child',
  undo.context?.nativePrintPreset?.selected_project_embedded === false &&
  (undo.context?.nativePrintPreset?.project_embedded_names ?? []).length === 0,
  JSON.stringify(undo.context?.nativePrintPreset));

const redo = requireOk('redo Project Print history', callJson('orc_history_redo'));
const afterRedo = presetSnapshot();
check('Redo recreates and selects the native project Print child',
  afterRedo.print?.name === childName &&
  redo.context?.nativePrintPreset?.selected_project_embedded === true &&
  (redo.context?.nativePrintPreset?.project_embedded_names ?? []).includes(childName),
  JSON.stringify({ expected: childName, actual: afterRedo.print?.name,
    nativePrintPreset: redo.context?.nativePrintPreset }));
check('Redo restores the ordinary Project Print diff', nativeSnapshot().project.layer_height === '0.24',
  JSON.stringify(nativeSnapshot()));

console.log(`native project Print preset history smoke passed (${moduleArg})`);
