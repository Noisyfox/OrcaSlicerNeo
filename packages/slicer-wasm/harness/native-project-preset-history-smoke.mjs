import { fixtureProfileOptions } from './profile-installer.mjs';
// Focused real-WASM coverage for native Project Print-preset materialization.
// Ordinary Project print edits must create a native project-embedded child only
// when the edit changes the effective value, and history Undo/Redo must restore
// both that child and the selected native preset without a session sidecar.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { resetNativeScopedConfig, setNativeScopedConfig } from './native-scoped-command.mjs';
import { readZipEntries, replaceEntry } from './native-3mf-parser.mjs';

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

requireOk('init', callJson('orc_init', ['string'], [fixtureProfileOptions(Module)]));
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

// The metadata catalogue must expose region defaults at Project scope, and
// the same real Project mutation path must retain their native Print ownership.
const fuzzyValues = { fuzzy_skin: 'all', fuzzy_skin_thickness: '0.42', fuzzy_skin_point_distance: '1.1' };
const tx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Project Print override', 'project', JSON.stringify(historyContext), '']);
requireOk('begin Project Print history transaction', tx);
const changed = setNativeScopedConfig(callJson, 'project', undefined, 'layer_height', '0.24');
requireOk('set ordinary Project Print value', changed);
for (const [key, value] of Object.entries(fuzzyValues))
  requireOk(`set Project ${key}`, setNativeScopedConfig(callJson, 'project', undefined, key, value));
for (const [key, value] of Object.entries(fuzzyValues))
  check(`Project ${key} is stored and effective`, nativeSnapshot().project[key] === value &&
    presetSnapshot().project_config[key] === value);
const afterMutation = presetSnapshot();
const childName = afterMutation.print?.name;
check('first real ordinary Project mutation selects a project-embedded child',
  childName && childName !== parentName && /\(Project\)/.test(childName),
  JSON.stringify({ parentName, childName, print: afterMutation.print }));
const committed = callJson('orc_history_commit', ['string', 'string'], [tx.transactionId, JSON.stringify(historyContext)]).status;
check('Project Print history transaction commits', committed.canUndo === true, JSON.stringify(committed));
check('ordinary Project value is a native scoped diff', nativeSnapshot().project.layer_height === '0.24',
  JSON.stringify(nativeSnapshot()));

const undo = requireOk('undo Project Print history', callJson('orc_history_undo'));
const afterUndo = presetSnapshot();
check('Undo restores the parent Print selection', afterUndo.print?.name === parentName,
  JSON.stringify({ expected: parentName, actual: afterUndo.print?.name, undo }));
for (const key of Object.keys(fuzzyValues))
  check(`Undo removes Project ${key}`, !Object.hasOwn(nativeSnapshot().project, key));
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

for (const [key, value] of Object.entries(fuzzyValues))
  check(`Redo restores Project ${key}`, nativeSnapshot().project[key] === value &&
    presetSnapshot().project_config[key] === value);

// The catalogue projects the selected child into the source row, retaining
// the native child ID for commands while displaying only the source identity.
function printSources(snapshot) {
  return JSON.stringify(snapshot.prints.map(preset => preset.source_name ?? preset.name));
}
function checkPrintProjection(label, snapshot) {
  const child = snapshot.prints.find(preset => preset.name === childName);
  check(label, snapshot.print.name === childName && child?.source_name === parentName &&
    child.label === before.prints.find(preset => preset.name === parentName).label &&
    printSources(snapshot) === printSources(before) &&
    !snapshot.prints.some(preset => preset.name === parentName), JSON.stringify(child));
}
checkPrintProjection('Project child replaces its source picker row', afterRedo);
const filamentSource = requireOk('read Filament session', callJson('orc_get_filament_session_snapshot'))
  .slots[0].preset.name;
const filamentBefore = requireOk('read Filament draft', callJson('orc_get_preset_draft',
  ['string', 'string'], ['filament', filamentSource]));
const soluble = filamentBefore.effective_values.filament_soluble === '1' ? '0' : '1';
const filamentEdit = requireOk('edit filament_soluble', callJson('orc_mutate_preset_draft', ['string'],
  [JSON.stringify({ action: 'set', kind: 'filament', canonical_name: filamentSource,
    expected_revision: callJson('orc_history_status').revision, key: 'filament_soluble', value: soluble })]));
check('Filament edit changes the active source', filamentEdit.history_entry_delta === 1 &&
  callJson('orc_get_preset_draft', ['string', 'string'], ['filament', filamentSource])
    .effective_values.filament_soluble === soluble);
checkPrintProjection('Filament refresh keeps the child behind the source row', filamentEdit.profile_snapshot);
check('Filament refresh retains the Print override', filamentEdit.profile_snapshot.project_config.layer_height === '0.24');
requireOk('undo Filament edit', callJson('orc_history_undo'));
checkPrintProjection('Undo retains the child and source display', presetSnapshot());
requireOk('redo Filament edit', callJson('orc_history_redo'));
checkPrintProjection('Redo retains the child and source display', presetSnapshot());
requireOk('undo Filament edit before Process-only export', callJson('orc_history_undo'));

// Field reset restores inheritance, and its history root restores/erases the
// region default through the same edited native Print preset.
const resetTx = requireOk('begin Fuzzy reset', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Reset Fuzzy', 'project', JSON.stringify(historyContext), '']));
requireOk('reset Project fuzzy thickness', resetNativeScopedConfig(callJson, 'project', undefined, 'fuzzy_skin_thickness'));
check('Fuzzy reset removes local diff', !Object.hasOwn(nativeSnapshot().project, 'fuzzy_skin_thickness'));
check('Fuzzy reset restores inherited effective value', presetSnapshot().project_config.fuzzy_skin_thickness ===
  before.project_config.fuzzy_skin_thickness);
const resetCommit = callJson('orc_history_commit', ['string', 'string'],
  [resetTx.transactionId, JSON.stringify(historyContext)]).status;
check('Fuzzy reset commits to history', resetCommit?.canUndo === true && resetCommit?.activeTransactionId === null);
requireOk('undo Fuzzy reset', callJson('orc_history_undo'));
check('Undo restores reset Fuzzy value', nativeSnapshot().project.fuzzy_skin_thickness === fuzzyValues.fuzzy_skin_thickness);
requireOk('redo Fuzzy reset', callJson('orc_history_redo'));
check('Redo removes reset Fuzzy value', !Object.hasOwn(nativeSnapshot().project, 'fuzzy_skin_thickness'));
requireOk('restore Fuzzy thickness for save', setNativeScopedConfig(callJson, 'project', undefined,
  'fuzzy_skin_thickness', fuzzyValues.fuzzy_skin_thickness));

// A native Process child is ordinary project data, not a printer/filament
// G-code warning. Exercise the writer and reader rather than mocking flags.
requireOk('add roundtrip geometry', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Warning fixture']));
const exported = requireOk('save Process override', callJson('orc_export_project'));
const projectBytes = Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + exported.bytes_length);
Module._free(Number(exported.bytes_ptr));
checkPrintProjection('Export retains the live child and source display', presetSnapshot());
const entries = readZipEntries(projectBytes);
const projectConfig = JSON.parse(new TextDecoder().decode(
  entries.find(entry => entry.name === 'Metadata/project_settings.config').content));
const processDiffs = projectConfig.different_settings_to_system ?? [];
check('saved embedded Process archive declares its edited key as a diff',
  String(Array.isArray(processDiffs) ? processDiffs[0] : processDiffs).includes('layer_height'),
  JSON.stringify(processDiffs));
function loadArchive(bytes, name) {
  const ptr = Number(Module._malloc(bytes.length));
  Module.HEAPU8.set(bytes, ptr);
  try {
    return requireOk(name, callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
      [ptr, bytes.length, 0, name]));
  } finally { Module._free(ptr); }
}
const reloaded = loadArchive(projectBytes, 'process-only.3mf');
const cleanWarning = reloaded.embedded_preset_warnings;
check('Process-only save/reopen needs no compatibility confirmation',
  cleanWarning.process_count > 0 && cleanWarning.modified_printer_gcode === false &&
  cleanWarning.modified_filament_gcode === false && cleanWarning.missing_system_preset === false &&
  cleanWarning.filament_slot_changes.length === 0 && cleanWarning.requires_confirmation === false,
  JSON.stringify(cleanWarning));
check('Process-only save/reopen preserves the edited value',
  reloaded.preset_snapshot.project_config.layer_height === '0.24',
  JSON.stringify(reloaded.preset_snapshot.project_config.layer_height));

for (const [key, value] of Object.entries(fuzzyValues)) {
  check(`3MF Process diff records ${key}`, String(Array.isArray(processDiffs) ? processDiffs[0] : processDiffs).includes(key));
  check(`3MF reopen preserves Project ${key}`, reloaded.preset_snapshot.project_config[key] === value &&
    nativeSnapshot().project[key] === value);
}

function withProjectConfig(changes) {
  return replaceEntry(projectBytes, 'Metadata/project_settings.config',
    JSON.stringify({ ...projectConfig, ...changes }));
}
// Match the pinned Orca validator's different_settings_to_system indexing.
// It inspects slot 1 when filament_count is 2; do not invent a separate diff.
const modified = loadArchive(withProjectConfig({
  filament_diameter: [projectConfig.filament_diameter[0], projectConfig.filament_diameter[0]],
  filament_settings_id: [projectConfig.filament_settings_id[0], projectConfig.filament_settings_id[0]],
  inherits_group: ['', '', '', projectConfig.inherits_group?.at(-1) ?? ''],
  different_settings_to_system: ['', 'filament_start_gcode', '', ''],
}), 'modified-gcode.3mf').embedded_preset_warnings;
check('Orca-reported modified filament G-code still requires confirmation',
  modified.modified_filament_gcode === true && modified.requires_confirmation === true &&
  modified.modified_gcode_keys.includes('filament_start_gcode'), JSON.stringify(modified));
const missing = loadArchive(withProjectConfig({
  printer_settings_id: 'Missing fixture system printer',
  inherits_group: Array(projectConfig.filament_diameter.length + 2).fill(''),
}), 'missing-system.3mf').embedded_preset_warnings;
check('missing system printer still requires confirmation',
  missing.missing_system_preset === true && missing.requires_confirmation === true,
  JSON.stringify(missing));

console.log(`native project Print preset history smoke passed (${moduleArg})`);
