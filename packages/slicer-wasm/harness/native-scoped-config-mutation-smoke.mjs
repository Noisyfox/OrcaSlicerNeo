// Focused real-WASM coverage for the native scoped mutation ABI.
//
// This keeps the mutation protocol independent from UI selection code and
// proves atomic multi-target staging, native bound normalization, erase-only
// reset semantics, and the reset exclusions which belong to filament/rack
// and scene-only authorities.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [moduleArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node native-scoped-config-mutation-smoke.mjs <out/orca_slice.js>');
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
function mutate(operation, targets, payload = {}) {
  return callJson('orc_mutate_native_scoped_config', ['string'], [JSON.stringify({
    version: 1, operation, targets, ...payload,
  })]);
}
const projectTarget = { scope: 'project' };
const setProject = (key, value) => mutate('set', [projectTarget], { key, value: String(value) });
const resetProject = (key) => mutate('reset', [projectTarget], { key });
const snapshot = () => requireOk('native snapshot', callJson('orc_get_native_scoped_config')).native_scoped_config.snapshot;
const session = () => requireOk('plate session', callJson('orc_get_plate_session_snapshot'));
const status = () => callJson('orc_history_status');
const historyContext = {
  selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {},
};

requireOk('init', callJson('orc_init', ['string'], ['{"log_level":"error"}']));
requireOk('clear model', callJson('orc_clear_model'));
requireOk('add cube', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Mutation fixture']));
const structure = requireOk('model structure', callJson('orc_get_model_structure'));
const objectId = String(structure.objects[0]?.id);
const partId = String(structure.objects[0]?.volumes[0]?.id);
if (!objectId || objectId === 'undefined' || !partId || partId === 'undefined')
  throw new Error(`mutation fixture has no object/part: ${JSON.stringify(structure)}`);

// Native routing slots remain project-owned for slicing/history, but are not
// generic Project/Scoped catalogue entries or mutation targets.
const optionMetadata = callJson('orc_get_option_metadata');
for (const key of ['wipe_tower_filament', 'support_filament', 'support_interface_filament',
  'outer_wall_filament_id', 'inner_wall_filament_id', 'sparse_infill_filament_id',
  'internal_solid_filament_id', 'top_surface_filament_id', 'bottom_surface_filament_id']) {
  if ((optionMetadata[key]?.scopes ?? []).length !== 0)
    throw new Error(`native routing key leaked into generic catalogue: ${key}: ${JSON.stringify(optionMetadata[key])}`);
}
const routingBefore = snapshot();
const routingRejected = setProject('support_filament', '1');
if (routingRejected.ok || routingRejected.error_code !== 'unsupported_reference' ||
    JSON.stringify(snapshot()) !== JSON.stringify(routingBefore))
  throw new Error(`generic routing mutation was not rejected atomically: ${JSON.stringify(routingRejected)}`);

// Two targets are staged first and committed only after both native parses
// succeed. The shared key is independently materialized in each native map.
const multiTarget = mutate('set', [
  { scope: 'object', id: objectId }, { scope: 'part', id: partId },
], { values: { wall_loops: '3', top_shell_layers: '4' } });
requireOk('multi-target set', multiTarget);
if (snapshot().objects?.[objectId]?.wall_loops !== '3' ||
    snapshot().parts?.[partId]?.wall_loops !== '3')
  throw new Error(`multi-target set did not materialize both native maps: ${JSON.stringify(multiTarget)}`);

// Repeating the same native values is a successful no-op, including inside
// a history transaction. It must not allocate new plate input stamps.
const beforeNoOpSession = session();
const beforeNoOpStatus = status();
const noOpTx = requireOk('begin no-op', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['No-op config', 'project', JSON.stringify(historyContext), '']));
const noOp = requireOk('repeat multi-target set', mutate('set', [
  { scope: 'object', id: objectId }, { scope: 'part', id: partId },
], { values: { wall_loops: '3', top_shell_layers: '4' } }));
if (noOp.plate_session || noOp.native_scoped_config.kind !== 'affected' ||
    noOp.native_scoped_config.replacements.length !== 2)
  throw new Error(`unexpected no-op receipt: ${JSON.stringify(noOp)}`);
const afterNoOpStatus = callJson('orc_history_commit', ['string', 'string'],
  [noOpTx.transactionId, JSON.stringify(historyContext)]).status;
if (JSON.stringify(session()) !== JSON.stringify(beforeNoOpSession) ||
    afterNoOpStatus.revision !== beforeNoOpStatus.revision ||
    afterNoOpStatus.dirty !== beforeNoOpStatus.dirty ||
    JSON.stringify(afterNoOpStatus.undoEntries) !== JSON.stringify(beforeNoOpStatus.undoEntries))
  throw new Error('no-op modified plate inputs or history');

// A local receipt contains only requested maps, even with other configured
// entities present. Reset removes eligible keys and retains material authority.
const beforeLocalReset = snapshot();
const scopedReset = requireOk('reset object', mutate('reset-all', [{ scope: 'object', id: objectId }]));
if (scopedReset.native_scoped_config.replacements.length !== 1 ||
    Object.hasOwn(scopedReset.native_scoped_config.replacements[0].values, 'wall_loops') ||
    Object.hasOwn(scopedReset.native_scoped_config.replacements[0].values, 'top_shell_layers') ||
    scopedReset.native_scoped_config.replacements[0].values.extruder !== beforeLocalReset.objects[objectId]?.extruder ||
    snapshot().parts[partId]?.wall_loops !== '3')
  throw new Error(`local reset included or changed unrelated configuration: ${JSON.stringify(scopedReset)}`);
requireOk('re-edit sparse object', mutate('set', [{ scope: 'object', id: objectId }], { key: 'wall_loops', value: '3' }));

const beforeFailureSnapshot = snapshot();
const beforeFailureSession = session();
const beforeFailureStatus = status();
const rejected = mutate('set', [
  { scope: 'object', id: objectId }, { scope: 'object', id: '999999999' },
], { key: 'wall_loops', value: '7' });
if (rejected.ok || rejected.error_code !== 'unsupported_reference')
  throw new Error(`multi-target failure was accepted: ${JSON.stringify(rejected)}`);
if (JSON.stringify(snapshot()) !== JSON.stringify(beforeFailureSnapshot) ||
    JSON.stringify(session()) !== JSON.stringify(beforeFailureSession) ||
    JSON.stringify(status()) !== JSON.stringify(beforeFailureStatus))
  throw new Error('failed multi-target mutation changed native state, revisions, or history');

const clamped = setProject('preferred_orientation', '1000');
requireOk('native clamp', clamped);
// preferred_orientation is an edited-Print-preset option, not a native
// project_config key; inspect the native full effective config for its result.
const clampedValue = Number(requireOk('effective preset snapshot', callJson('orc_get_preset_snapshot'))
  .project_config?.preferred_orientation);
if (!Number.isFinite(clampedValue) || clampedValue >= 1000 ||
    clamped.configuration_status?.corrections?.length !== 1)
  throw new Error(`native bound clamp was not reported: ${JSON.stringify(clamped)}`);

const beforeBadParseSnapshot = snapshot();
const beforeBadParseSession = session();
const beforeBadParseStatus = status();
const badParse = setProject('layer_height', 'not-a-number');
if (badParse.ok || badParse.error_code !== 'native_validation_failure')
  throw new Error(`bad native parse was accepted: ${JSON.stringify(badParse)}`);
if (JSON.stringify(snapshot()) !== JSON.stringify(beforeBadParseSnapshot) ||
    JSON.stringify(session()) !== JSON.stringify(beforeBadParseSession) ||
    JSON.stringify(status()) !== JSON.stringify(beforeBadParseStatus))
  throw new Error('bad native parse changed state or history');

// Reset is erase-only. A key missing from the predecessor must stay missing
// after Undo/Redo because Project history restores the complete local map.
requireOk('set reset fixture', setProject('wall_loops', '5'));
if (snapshot().project?.wall_loops !== '5') throw new Error('reset fixture was not stored');
const tx = requireOk('begin reset transaction', callJson('orc_history_begin',
  ['string', 'string', 'string', 'string'], ['Reset Project Key', 'project', JSON.stringify(historyContext), '']));
requireOk('reset project key', resetProject('wall_loops'));
if (Object.hasOwn(snapshot().project ?? {}, 'wall_loops')) throw new Error('reset did not erase local key');
const committed = callJson('orc_history_commit',
  ['string', 'string'], [tx.transactionId, JSON.stringify(historyContext)]).status;
if (!committed.canUndo) throw new Error(`commit reset transaction: ${JSON.stringify(committed)}`);
requireOk('undo reset', callJson('orc_history_undo'));
if (snapshot().project?.wall_loops !== '5') throw new Error('Undo did not restore erased Project key');
requireOk('redo reset', callJson('orc_history_redo'));
if (Object.hasOwn(snapshot().project ?? {}, 'wall_loops')) throw new Error('Redo merged erased Project key');

// Category and Reset All operate only on eligible print keys. Extruder and
// filament/rack values remain owned by their dedicated authorities.
requireOk('set category fixture', setProject('wall_loops', '6'));
requireOk('reset Strength category', mutate('reset-category', [projectTarget], { category: 'Strength' }));
if (Object.hasOwn(snapshot().project ?? {}, 'wall_loops')) throw new Error('category reset did not erase Quality key');
requireOk('set extruder exclusion', setProject('extruder', '1'));
const filamentColour = snapshot().project?.filament_colour;
if (typeof filamentColour === 'string') requireOk('materialize filament exclusion', setProject('filament_colour', filamentColour));
requireOk('reset all eligible keys', mutate('reset-all', [projectTarget]));
const afterAll = snapshot().project ?? {};
const afterAllEffective = requireOk('effective preset snapshot after reset all', callJson('orc_get_preset_snapshot'))
  .project_config ?? {};
if (afterAllEffective.extruder !== '1' ||
    (typeof filamentColour === 'string' && afterAll.filament_colour !== filamentColour))
  throw new Error(`Reset All erased an excluded key: ${JSON.stringify(afterAll)}`);

console.log('native scoped config mutation PASS');
