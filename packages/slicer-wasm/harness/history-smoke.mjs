// Step 2 real bridge history round trip.  Deliberately does not export 3MF.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { readFile } from 'node:fs/promises';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { mutateNativeScopedConfig, setNativeScopedConfig } from './native-scoped-command.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { awaitAsyncTask, getSliceResult } from './async-task-mailbox.mjs';

const [moduleArg, profileRootArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node history-smoke.mjs <out/orca_slice.js> [profile-package-root]');
const repoRoot = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(moduleArg))({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(profileRootArg ?? `${repoRoot}/packages/profile-resources/dist`)));
function callJson(name, argTypes, args) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
function writeBytes(bytes) {
  const ptr = Number(Module._malloc(bytes.byteLength));
  Module.HEAPU8.set(bytes, ptr);
  return ptr;
}
function readAndFree(ptr, length) {
  const bytes = Module.HEAPU8.slice(Number(ptr), Number(ptr) + Number(length));
  Module._free(Number(ptr));
  return bytes;
}
function historyCheck(label, condition, detail = '') {
  if (!condition) throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
  console.log(`history PASS ${label}`);
}
function sessionShape(snapshot) {
  const records = new Map((snapshot.instances ?? []).map((item) =>
    [`${item.object_index}:${item.instance_index}`, item]));
  const keyForId = new Map((snapshot.instances ?? []).map((item) => [item.instance_id,
    `${item.object_index}:${item.instance_index}`]));
  const plateMembers = (ids) => ids.map((id) => keyForId.get(id) ?? `missing:${id}`).sort();
  return {
    current_plate_id: snapshot.current_plate_id,
    input_revisions: snapshot.input_revisions,
    plates: (snapshot.plates ?? []).map((plate) => ({
      plate_id: plate.plate_id, display_index: plate.display_index, origin: plate.origin,
      name: plate.name, locked: plate.locked, settings: plate.settings,
      opaque_metadata: plate.opaque_metadata, future_metadata: plate.future_metadata,
      instance_ids: [...(plate.instance_ids ?? [])].sort((a, b) => a - b),
      out_of_bounds_instance_ids: [...(plate.out_of_bounds_instance_ids ?? [])].sort((a, b) => a - b),
      instance_keys: plateMembers(plate.instance_ids ?? []),
      out_of_bounds_keys: plateMembers(plate.out_of_bounds_instance_ids ?? []),
    })),
    instances: [...records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => ({
      key, instance_id: item.instance_id, object_id: item.object_id,
      plate_id: item.plate_id, member: item.member, parked: item.parked,
      out_of_bounds: item.out_of_bounds,
    })),
  };
}
function modelIdentity(structure) {
  return (structure.objects ?? []).map((object) => ({
    object_id: object.id,
    volume_ids: (object.volumes ?? []).map((volume) => volume.id),
    instance_ids: (object.instances ?? []).map((instance) => instance.id),
  }));
}
function assertSceneDelta(label, restored, identities, plateIds, objectOrder) {
  const expected = {
    object_ids: identities.map((object) => object.object_id).sort((a, b) => a - b),
    volume_ids: identities.flatMap((object) => object.volume_ids).sort((a, b) => a - b),
    instance_ids: identities.flatMap((object) => object.instance_ids).sort((a, b) => a - b),
    plate_ids: [...plateIds].sort(),
    object_order: [...objectOrder],
  };
  const actual = restored.scene_delta;
  historyCheck(label, restored.impact?.model === 'delta' && actual?.version === 1 &&
    JSON.stringify(actual.object_ids) === JSON.stringify(expected.object_ids) &&
    JSON.stringify(actual.volume_ids) === JSON.stringify(expected.volume_ids) &&
    JSON.stringify(actual.instance_ids) === JSON.stringify(expected.instance_ids) &&
    JSON.stringify(actual.plate_ids) === JSON.stringify(expected.plate_ids) &&
    JSON.stringify(actual.object_order) === JSON.stringify(expected.object_order),
  JSON.stringify({ expected, actual, impact: restored.impact }));
}
function mergeIdentities(...groups) {
  const merged = new Map();
  for (const object of groups.flat()) {
    const current = merged.get(object.object_id) ?? {
      object_id: object.object_id, volume_ids: [], instance_ids: [],
    };
    current.volume_ids = [...new Set([...current.volume_ids, ...object.volume_ids])];
    current.instance_ids = [...new Set([...current.instance_ids, ...object.instance_ids])];
    merged.set(object.object_id, current);
  }
  return [...merged.values()];
}
function stableSessionShape(snapshot) {
  const shape = sessionShape(snapshot);
  delete shape.input_revisions;
  return shape;
}
function assertLiveSessionIntegrity(snapshot, label) {
  const model = callJson('orc_get_model_structure', [], []);
  const modelKeys = new Set((model.objects ?? []).flatMap((object) =>
    (object.instances ?? []).map((instance) => `${object.index}:${instance.index}`)));
  const snapshotKeys = new Set((snapshot.instances ?? []).map((item) =>
    `${item.object_index}:${item.instance_index}`));
  const ids = new Set((snapshot.instances ?? []).map((item) => item.instance_id));
  const listedIds = new Set((snapshot.plates ?? []).flatMap((plate) => plate.instance_ids ?? []));
  const memberIds = new Set((snapshot.instances ?? []).filter((item) => item.member).map((item) => item.instance_id));
  const validCurrent = (snapshot.plates ?? []).some((plate) => plate.plate_id === snapshot.current_plate_id);
  const complete = model.ok === true && modelKeys.size === snapshotKeys.size &&
    [...modelKeys].every((key) => snapshotKeys.has(key)) &&
    [...ids].every((id) => Number.isSafeInteger(id) && id > 0) &&
    [...listedIds].every((id) => memberIds.has(id)) && listedIds.size === memberIds.size &&
    validCurrent && (snapshot.plates ?? []).every((plate, index) => plate.display_index === index &&
      (snapshot.input_revisions ?? {})[plate.plate_id] !== undefined);
  historyCheck(`${label} has complete live instance IDs and membership`, complete,
    JSON.stringify({ model, snapshot }));
}
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const init = callJson('orc_init', ['string'], ['{"log_level":"error"}']);
if (!init.ok) throw new Error(JSON.stringify(init));
// A freshly created project exercises the first ordinary body move: Undo must
// restore the one-Cube frame and leave the complete filament projection valid.
// In particular, routing uses stable native object/part IDs after archive
// restoration; this is the exact projection consumed by the Prepare rack.
historyCheck('reset fresh-project filament history fixture',
  callJson('orc_clear_model', [], []).ok === true &&
  callJson('orc_history_reset', ['string'], [JSON.stringify(context)]).canUndo === false);
const freshAddTx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Add Cube', 'project', JSON.stringify(context), '']);
if (!freshAddTx.ok || typeof freshAddTx.transactionId !== 'string') throw new Error(JSON.stringify(freshAddTx));
historyCheck('fresh-project Cube add succeeds',
  callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Fresh history Cube']).ok === true);
const freshAddCommit = callJson('orc_history_commit', ['string', 'string'],
  [freshAddTx.transactionId, JSON.stringify(context)]);
if (!freshAddCommit.canUndo) throw new Error(`fresh Cube commit failed: ${JSON.stringify(freshAddCommit)}`);
const freshBeforeMove = callJson('orc_get_model_mesh', [], []);
const freshBeforeMoveStructure = callJson('orc_get_model_structure', [], []);
const freshStableIds = modelIdentity(freshBeforeMoveStructure);
const freshMoveTx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Move', 'project', JSON.stringify(context), '']);
if (!freshMoveTx.ok || typeof freshMoveTx.transactionId !== 'string') throw new Error(JSON.stringify(freshMoveTx));
const freshBody = freshBeforeMove.objects?.[0];
if (!freshBody) throw new Error(`fresh Cube mesh unavailable: ${JSON.stringify(freshBeforeMove)}`);
const freshMove = { ...freshBody.instance_transform,
  offset: [freshBody.instance_transform.offset[0] + 10, freshBody.instance_transform.offset[1], freshBody.instance_transform.offset[2]] };
delete freshMove.matrix;
historyCheck('fresh-project Cube move succeeds', callJson('orc_set_model_transforms', ['string', 'string'],
  [freshMoveTx.transactionId, JSON.stringify([{ objectIdx: freshBody.object_idx, volumeIdx: freshBody.volume_idx,
    instanceIdx: freshBody.instance_idx, instanceTransform: freshMove, volumeTransform: freshBody.volume_transform }])]).ok === true);
const freshScopedConfigMutation = mutateNativeScopedConfig(callJson, 'set', [
  { scope: 'object', id: String(freshStableIds[0].object_id) },
  { scope: 'part', id: String(freshStableIds[0].volume_ids[0]) },
], { key: 'layer_height', value: '0.2' });
historyCheck('fresh-project move transaction records object and part scoped config targets',
  freshScopedConfigMutation.ok === true, JSON.stringify(freshScopedConfigMutation));
const freshMoveCommit = callJson('orc_history_commit', ['string', 'string'],
  [freshMoveTx.transactionId, JSON.stringify(context)]);
if (!freshMoveCommit.canUndo) throw new Error(`fresh Cube move commit failed: ${JSON.stringify(freshMoveCommit)}`);
const freshMoveId = freshMoveCommit.undoEntries?.[0]?.id;
if (typeof freshMoveId !== 'string') throw new Error(`fresh Cube move ID missing: ${JSON.stringify(freshMoveCommit)}`);
// Drain the mutation profile so this assertion isolates the authoritative
// native timestamp restore performed by the real Undo operation below.
callJson('orc_take_performance_profile', [], []);
const freshMoveUndo = callJson('orc_history_undo', [], []);
if (!freshMoveUndo.ok) throw new Error(`fresh Cube move undo failed: ${JSON.stringify(freshMoveUndo)}`);
const freshMoveUndoProfile = callJson('orc_take_performance_profile', [], []);
const restoreSamples = (freshMoveUndoProfile.samples ?? []).filter((sample) => sample.operation === 'history_restore');
const restoreStages = [
  'immutable_mesh_reconnect',
  'model_staging_deserialization',
  'plate_session_native_config_restore',
  'total',
];
historyCheck('fresh-project move Undo exposes bounded native restore stages', restoreSamples.length === 1 &&
  Object.keys(restoreSamples[0].stages_ms).sort().join(',') === [...restoreStages].sort().join(',') &&
  restoreStages.every((stage) => Number.isFinite(restoreSamples[0].stages_ms[stage]) &&
    restoreSamples[0].stages_ms[stage] >= 0) &&
  restoreSamples[0].stages_ms.total >= Math.max(...restoreStages.filter((stage) => stage !== 'total')
    .map((stage) => restoreSamples[0].stages_ms[stage])), JSON.stringify({ restoreSamples, restoreStages }));
historyCheck('fresh-project move Undo returns the SceneDelta timestamped-restore ABI response', freshMoveUndo.ok === true &&
  freshMoveUndo.context && typeof freshMoveUndo.context === 'object' &&
  freshMoveUndo.impact?.model === 'delta' && freshMoveUndo.impact?.plateSession === true &&
  freshMoveUndo.impact?.nativeScopedConfig === true && freshMoveUndo.impact?.preview === 'all' &&
  !Object.hasOwn(freshMoveUndo, 'direct') && !Object.hasOwn(freshMoveUndo, 'transform_receipt'),
  JSON.stringify(freshMoveUndo));
const freshMoveRemovedTargets = new Set((freshMoveUndo.native_scoped_config?.removed_targets ?? [])
  .map((target) => `${target.scope}:${target.id ?? ''}`));
historyCheck('fresh-project move Undo publishes a scoped tombstone for the erased part map',
  freshMoveRemovedTargets.has(`part:${freshStableIds[0].volume_ids[0]}`),
  JSON.stringify({ freshMoveRemovedTargets: [...freshMoveRemovedTargets], native_scoped_config: freshMoveUndo.native_scoped_config }));
const freshPlateIds = freshMoveUndo.context.plateSession.plates.map((plate) => plate.plate_id);
assertSceneDelta('fresh-project move Undo publishes the exact stable-ID delta', freshMoveUndo,
  freshStableIds, freshPlateIds, freshStableIds.map((object) => object.object_id));
historyCheck('instance transform and scoped config Undo retains unchanged renderer geometry',
  JSON.stringify(freshMoveUndo.scene_delta.retained_renderer_object_ids) ===
    JSON.stringify(freshStableIds.map((object) => object.object_id)) &&
  freshMoveUndo.scene_delta.retained_volume_transforms?.length === 1 &&
  freshMoveUndo.context.plateSession.instance_transforms?.length === 1 &&
  Math.abs(freshMoveUndo.context.plateSession.instance_transforms[0].world_transform.offset[0] -
    freshBody.instance_transform.offset[0]) < 1e-8 &&
  freshMoveUndo.impact.filamentRack === false, JSON.stringify({ delta: freshMoveUndo.scene_delta,
    before: freshBeforeMoveStructure, after: callJson('orc_get_model_structure'), impact: freshMoveUndo.impact,
    transforms: freshMoveUndo.context.plateSession.instance_transforms }));
const freshScenePatch = callJson('orc_get_model_scene_patch', ['string'],
  [JSON.stringify(freshMoveUndo.scene_delta.object_ids)]);
historyCheck('fresh-project move Undo targeted patch returns only the touched native object',
  freshScenePatch.ok === true &&
  JSON.stringify(freshScenePatch.object_order) === JSON.stringify(freshMoveUndo.scene_delta.object_order) &&
  JSON.stringify(modelIdentity(freshScenePatch)) === JSON.stringify(freshStableIds) &&
  freshScenePatch.meshes.length === 1 &&
  freshScenePatch.meshes[0].object_id === freshStableIds[0].object_id &&
  freshScenePatch.meshes[0].volume_id === freshStableIds[0].volume_ids[0] &&
  freshScenePatch.meshes[0].instance_id === freshStableIds[0].instance_ids[0],
  JSON.stringify(freshScenePatch));
for (const mesh of freshScenePatch.meshes ?? []) {
  readAndFree(mesh.vertex_ptr, mesh.vertex_count * 3 * Float32Array.BYTES_PER_ELEMENT);
  readAndFree(mesh.index_ptr, mesh.index_count * Uint32Array.BYTES_PER_ELEMENT);
}
console.log(`history restore native stages ms ${JSON.stringify(restoreSamples[0].stages_ms)}`);
const freshFilament = callJson('orc_get_filament_session_snapshot', [], []);
const freshStructure = callJson('orc_get_model_structure', [], []);
historyCheck('fresh-project move Undo keeps filament routing contract valid',
  freshFilament.ok === true && Array.isArray(freshFilament.routing) &&
  freshStructure.objects?.[0]?.volumes?.[0]?.id === freshBeforeMoveStructure.objects?.[0]?.volumes?.[0]?.id &&
  freshFilament.routing.every((route) => route.target === 'project'
    ? route.id === 0 && route.object_id === 0
    : Number.isSafeInteger(route.id) && route.id > 0 && Number.isSafeInteger(route.object_id) && route.object_id > 0),
  JSON.stringify({ freshFilament, freshStructure, freshBeforeMoveStructure }));
const freshCubeUndo = callJson('orc_history_undo', [], []);
historyCheck('second Undo removes the fresh-project Cube', freshCubeUndo.ok === true &&
  callJson('orc_get_model_structure', [], []).objects.length === 0,
  JSON.stringify({ freshCubeUndo, status: callJson('orc_history_status', [], []) }));
const freshCubeRemovedTargets = new Set((freshCubeUndo.native_scoped_config?.removed_targets ?? [])
  .map((target) => `${target.scope}:${target.id ?? ''}`));
historyCheck('second Undo publishes an explicit native scoped tombstone for the deleted object',
  freshCubeRemovedTargets.has(`object:${freshStableIds[0].object_id}`),
  JSON.stringify({ freshCubeRemovedTargets: [...freshCubeRemovedTargets], native_scoped_config: freshCubeUndo.native_scoped_config }));
assertSceneDelta('second Undo publishes the exact delete delta', freshCubeUndo,
  freshStableIds, freshPlateIds, []);
const freshCubeRedo = callJson('orc_history_redo', [], []);
const freshCubeRedoStructure = callJson('orc_get_model_structure', [], []);
historyCheck('first Redo fully restores the fresh-project Cube with exact native IDs',
  freshCubeRedo.ok === true &&
  JSON.stringify(modelIdentity(freshCubeRedoStructure)) === JSON.stringify(freshStableIds),
  JSON.stringify({ freshCubeRedo, expected: freshStableIds, actual: modelIdentity(freshCubeRedoStructure) }));
assertSceneDelta('first Redo publishes the exact add delta', freshCubeRedo,
  freshStableIds, freshPlateIds, freshStableIds.map((object) => object.object_id));
const freshMoveRedo = callJson('orc_history_redo', [], []);
const freshMoveRedoMesh = callJson('orc_get_model_mesh', [], []);
const freshMoveRedoStructure = callJson('orc_get_model_structure', [], []);
historyCheck('second Redo reapplies Move with exact native IDs', freshMoveRedo.ok === true &&
  freshMoveRedoMesh.objects?.[0]?.instance_transform?.offset?.[0] === freshMove.offset[0] &&
  JSON.stringify(modelIdentity(freshMoveRedoStructure)) === JSON.stringify(freshStableIds),
  JSON.stringify({ freshMoveRedo, freshMoveRedoMesh, expected: freshStableIds,
    actual: modelIdentity(freshMoveRedoStructure) }));
assertSceneDelta('second Redo publishes the exact move delta', freshMoveRedo,
  freshStableIds, freshPlateIds, freshStableIds.map((object) => object.object_id));
const threading = callJson('orc_get_threading_info', [], []);
if (threading.threaded) {
  const beforeActiveRestore = callJson('orc_get_plate_session_snapshot', [], []);
  const activePlateId = beforeActiveRestore.current_plate_id;
  const activeRevision = beforeActiveRestore.input_revisions?.[activePlateId];
  const activeSlice = callJson('orc_slice_plate', ['string', 'string', 'number'], [
    JSON.stringify({ layer_height: '0.17' }), activePlateId, activeRevision,
  ]);
  historyCheck('threaded history fixture admits a detached Slice task', activeSlice.accepted === true,
    JSON.stringify(activeSlice));
  const restoreStartedAt = Date.now();
  const activeSliceUndo = callJson('orc_history_undo', [], []);
  historyCheck('threaded Undo restores immediately while Slice is active', activeSliceUndo.ok === true &&
    Date.now() - restoreStartedAt < 1_000, JSON.stringify({ activeSliceUndo,
      elapsed_ms: Date.now() - restoreStartedAt }));
  const restoredRevisions = activeSliceUndo.context?.plateSession?.input_revisions ?? {};
  historyCheck('threaded Undo advances every plate input stamp',
    Object.entries(beforeActiveRestore.input_revisions ?? {}).every(([plateId, revision]) =>
      Number.isSafeInteger(restoredRevisions[plateId]) && restoredRevisions[plateId] !== revision),
    JSON.stringify({ before: beforeActiveRestore.input_revisions, after: restoredRevisions }));
  // Cancellation is deliberately requested after the authoritative restore;
  // its terminal is not awaited before the history call above completes.
  callJson('orc_cancel', [], []);
  const obsoleteTerminal = await awaitAsyncTask(callJson, activeSlice);
  const obsoleteProjection = obsoleteTerminal.receipt
    ? getSliceResult(callJson, obsoleteTerminal.receipt)
    : obsoleteTerminal;
  historyCheck('late cancelled or completed Slice output stays non-authoritative after Undo',
    obsoleteProjection.ok !== true && /cancel|stale|unavailable|supersed/i.test(obsoleteProjection.error ?? ''),
    JSON.stringify({ obsoleteTerminal, obsoleteProjection }));
  historyCheck('threaded history fixture returns to the moved state',
    callJson('orc_history_redo', [], []).ok === true);
}
const freshMoveJumpUndo = callJson('orc_history_jump', ['string', 'string'], [freshMoveId, 'undo']);
historyCheck('adjacent Undo jump loads the rematerialized Move target', freshMoveJumpUndo.ok === true &&
  callJson('orc_get_model_mesh', [], []).objects?.[0]?.instance_transform?.offset?.[0] ===
    freshBody.instance_transform.offset[0], JSON.stringify(freshMoveJumpUndo));
assertSceneDelta('adjacent Undo jump publishes the exact move delta', freshMoveJumpUndo,
  freshStableIds, freshPlateIds, freshStableIds.map((object) => object.object_id));
const freshMoveJumpRedo = callJson('orc_history_jump', ['string', 'string'], [freshMoveId, 'redo']);
historyCheck('adjacent Redo jump reapplies the rematerialized Move target', freshMoveJumpRedo.ok === true &&
  callJson('orc_get_model_mesh', [], []).objects?.[0]?.instance_transform?.offset?.[0] === freshMove.offset[0],
  JSON.stringify(freshMoveJumpRedo));
assertSceneDelta('adjacent Redo jump publishes the exact move delta', freshMoveJumpRedo,
  freshStableIds, freshPlateIds, freshStableIds.map((object) => object.object_id));
historyCheck('reset fresh-project filament history fixture after regression',
  callJson('orc_clear_model', [], []).ok === true &&
  callJson('orc_history_reset', ['string'], [JSON.stringify(context)]).canUndo === false);
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
for (const key of ['evictedEntryCount', 'bytesUsed', 'byteBudget']) {
  if (!Number.isSafeInteger(committed[key]) || committed[key] < 0)
    throw new Error(`history resource diagnostic ${key} is not deterministic: ${JSON.stringify(committed)}`);
}
if (typeof committed.oldestRetainedEntryId !== 'string' ||
    typeof committed.oversizedEntryRetained !== 'boolean')
  throw new Error(`history retention diagnostics are incomplete: ${JSON.stringify(committed)}`);
const beforeEdit = callJson('orc_get_model_structure', [], []);
const beforeEditSession = callJson('orc_get_plate_session_snapshot', [], []);
if (!beforeEdit.ok || beforeEdit.objects.length !== 2)
  throw new Error(`two-object baseline was not restored: ${JSON.stringify(beforeEdit)}`);

// UI-only selection/plate changes never call history. They preserve Redo, and
// the next genuine mutation attaches the then-current context to its retained
// predecessor before truncating the branch.
const contextUndo = callJson('orc_history_undo', [], []);
const contextUndoModel = callJson('orc_get_model_structure', [], []);
if (!contextUndo.ok || !contextUndoModel.ok || contextUndoModel.objects.length !== 0 ||
    contextUndo.status.canRedo !== true)
  throw new Error(`mutation A Undo did not expose Redo: ${JSON.stringify({ contextUndo, contextUndoModel })}`);
assertSceneDelta('multi-object compound Undo publishes one exact add/delete delta', contextUndo,
  modelIdentity(beforeEdit), beforeEditSession.plates.map((plate) => plate.plate_id), []);
const statusBeforeUiContext = callJson('orc_history_status', [], []);
const plateDuringUiContext = callJson('orc_get_plate_session_snapshot', [], []);
const selectSamePlate = callJson('orc_select_plate', ['string'], [plateDuringUiContext.current_plate_id]);
const selectionBeforeB = { ...context,
  activePlateId: plateDuringUiContext.current_plate_id,
  selection: { ...context.selection, mode: 'part', objectIds: [101], partIds: [202] } };
const statusAfterUiContext = callJson('orc_history_status', [], []);
if (!selectSamePlate.ok || statusAfterUiContext.canRedo !== true ||
    statusAfterUiContext.cursor !== statusBeforeUiContext.cursor ||
    statusAfterUiContext.revision !== statusBeforeUiContext.revision)
  throw new Error(`UI context changed history: ${JSON.stringify({ statusBeforeUiContext, statusAfterUiContext })}`);
const contextRedo = callJson('orc_history_redo', [], []);
const contextRedoModel = callJson('orc_get_model_structure', [], []);
if (!contextRedo.ok || !contextRedoModel.ok || contextRedoModel.objects.length !== 2)
  throw new Error(`mutation A Redo was lost after UI context: ${JSON.stringify({ contextRedo, contextRedoModel })}`);
const uiBranchUndo = callJson('orc_history_undo', [], []);
if (!uiBranchUndo.ok) throw new Error(`mutation A second Undo failed: ${JSON.stringify({
  uiBranchUndo, status: callJson('orc_history_status', [], []),
})}`);
const uiBranchTx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Mutation B', 'project', JSON.stringify(selectionBeforeB), '']);
if (!uiBranchTx.ok || typeof uiBranchTx.transactionId !== 'string') throw new Error(JSON.stringify(uiBranchTx));
for (const name of ['Branched history Cube A', 'Branched history Cube B']) {
  const branchAdded = callJson('orc_add_shape', ['string', 'string'], ['Cube', name]);
  if (!branchAdded.ok) throw new Error(JSON.stringify(branchAdded));
}
const uiBranchCommit = callJson('orc_history_commit', ['string', 'string'],
  [uiBranchTx.transactionId, JSON.stringify(selectionBeforeB)]);
if (uiBranchCommit.canRedo !== false)
  throw new Error(`mutation B did not truncate Redo: ${JSON.stringify(uiBranchCommit)}`);
const branchMutationUndo = callJson('orc_history_undo', [], []);
if (!branchMutationUndo.ok || branchMutationUndo.context.selection.objectIds[0] !== 101 ||
    branchMutationUndo.context.selection.partIds[0] !== 202)
  throw new Error(`mutation B predecessor context was not restored: ${JSON.stringify(branchMutationUndo)}`);
const branchMutationRedo = callJson('orc_history_redo', [], []);
if (!branchMutationRedo.ok) throw new Error(`mutation B Redo failed: ${JSON.stringify(branchMutationRedo)}`);
const activeBeforeEdit = callJson('orc_get_model_structure', [], []);
if (!activeBeforeEdit.ok || activeBeforeEdit.objects.length !== 2)
  throw new Error(`mutation B model was not restored: ${JSON.stringify(activeBeforeEdit)}`);

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
// Session plate IDs and logical model membership are persistent history
// identity. Native ModelInstance IDs are rematerialized by the model archive,
// so sessionShape deliberately compares members by object/instance index while
// retaining the stable ModelObject ID. Slice-input revisions are runtime
// invalidation stamps: every restored affected plate must receive a fresh,
// strictly newer stamp and must never recover the old numeric value.
const stablePlateStateRestored =
  JSON.stringify(stableSessionShape(plateAfterRedo)) === JSON.stringify(stableSessionShape(plateAdded));
const restoredRevisionsAdvanced = plateAdded.plates.every(({ plate_id: plateId }) =>
  Number.isSafeInteger(plateAfterRedo.input_revisions[plateId]) &&
  plateAfterRedo.input_revisions[plateId] > plateAdded.input_revisions[plateId]);
if (!stablePlateStateRestored || !restoredRevisionsAdvanced)
  throw new Error(`plate redo did not restore stable identity with fresh revisions: ${JSON.stringify({
    plateAdded: stableSessionShape(plateAdded),
    plateAfterRedo: stableSessionShape(plateAfterRedo),
    addedRevisions: plateAdded.input_revisions,
    redoneRevisions: plateAfterRedo.input_revisions,
  })}`);
assertLiveSessionIntegrity(plateAfterRedo, 'plate redo');

const configuredPlateId = plateAfterRedo.current_plate_id;
const configTx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Plate Config', 'project', JSON.stringify(context), '']);
if (!configTx.ok || typeof configTx.transactionId !== 'string') throw new Error(JSON.stringify(configTx));
const configured = setNativeScopedConfig(callJson, 'project', undefined, 'wipe_tower_x', '101,202');
if (configured.ok || configured.error_code !== 'unsupported_reference')
  throw new Error(`generic X/Y setting unexpectedly accepted: ${JSON.stringify(configured)}`);
const configuredCommit = callJson('orc_history_commit', ['string', 'string'],
  [configTx.transactionId, JSON.stringify(context)]);
const configuredAfter = callJson('orc_get_plate_session_snapshot', [], []);
if (!configuredCommit.canUndo || configuredAfter.plates.some((plate) => Object.hasOwn(plate.settings ?? {}, 'wipe_tower_x')))
  throw new Error(`plate configuration history commit failed: ${JSON.stringify({ configuredCommit, configuredAfter })}`);
const configUndo = callJson('orc_history_undo', [], []);
const configAfterUndo = callJson('orc_get_plate_session_snapshot', [], []);
if (!configUndo.ok || configAfterUndo.plates.some((plate) => Object.hasOwn(plate.settings ?? {}, 'wipe_tower_x')))
  throw new Error(`plate configuration undo did not restore the prior session: ${JSON.stringify({ configUndo, configAfterUndo })}`);
const configRedo = callJson('orc_history_redo', [], []);
const configAfterRedo = callJson('orc_get_plate_session_snapshot', [], []);
if (!configRedo.ok || configAfterRedo.plates.some((plate) => Object.hasOwn(plate.settings ?? {}, 'wipe_tower_x')))
  throw new Error(`plate configuration redo did not restore the session: ${JSON.stringify({ configRedo, configAfterRedo })}`);
const projectHistoryCountBeforeCoalesced = configRedo.status.undoEntries.length;

// The coalescing path is intentionally dormant in product UI, but the real
// bridge must keep a nested child inside one semantic outer history entry.
const outer = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Coalesced edit', 'project', JSON.stringify(context), '']);
if (!outer.ok || typeof outer.transactionId !== 'string') throw new Error(JSON.stringify(outer));
const outerEdit = callJson('orc_set_object_printable', ['number', 'number'], [activeBeforeEdit.objects[0].id, 0]);
if (!outerEdit.ok) throw new Error(JSON.stringify(outerEdit));
const child = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Coalesced child', 'project', JSON.stringify(context),
    JSON.stringify({ coalesce: true, parentTransactionId: outer.transactionId })]);
if (!child.ok || typeof child.transactionId !== 'string') throw new Error(JSON.stringify(child));
const childEdit = callJson('orc_set_object_printable', ['number', 'number'], [activeBeforeEdit.objects[1].id, 0]);
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
const targetId = activeBeforeEdit.objects[0].id;
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
historyCheck('renderer retention rejects changed native presentation',
  !undone.scene_delta.retained_renderer_object_ids.includes(targetId) &&
  !redone.scene_delta.retained_renderer_object_ids.includes(targetId), JSON.stringify({ undone, redone }));
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
  const result = callJson('orc_set_model_transforms', ['string', 'string'], [started.transactionId,
    JSON.stringify([{ objectIdx: 0, volumeIdx: 0, instanceIdx: 0,
      instanceTransform: transform, volumeTransform: modelMesh().volume_transform }])]);
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
  if (label === 'Move') {
    const transformProfile = callJson('orc_take_performance_profile', [], []);
    const transformSample = transformProfile.samples.find((sample) => sample.operation === 'set_model_transforms');
    const historySamples = transformProfile.samples.filter((sample) =>
      sample.operation === 'history_begin' || sample.operation === 'history_commit').slice(-2);
    const captureStages = [
      'capture_collection_cache',
      'capture_mutable_object_archive',
      'capture_immutable_mesh_retention',
      'capture_model_state',
    ];
    const requiredStages = [
      'input_json_decode', 'request_validation_target_resolution', 'transform_mutation',
      'plate_membership_reflow', 'response_json_serialization', 'total',
    ];
    historyCheck('model transform timing exposes bounded native stages only', transformProfile.version === 1 && Boolean(transformSample) &&
      requiredStages.every((stage) => Number.isFinite(transformSample.stages_ms[stage]) && transformSample.stages_ms[stage] >= 0) &&
      Object.keys(transformSample.stages_ms).every((stage) => requiredStages.includes(stage)) &&
      Object.keys(transformSample).every((key) => ['operation', 'stages_ms'].includes(key)));
    historyCheck('Move history captures the canonical timestamp roots', historySamples.length === 2 &&
      historySamples.every((sample) => captureStages.every((stage) =>
        Number.isFinite(sample.stages_ms[stage]) && sample.stages_ms[stage] >= 0)) &&
      Object.keys(historySamples[0].stages_ms).every((stage) =>
        ['total', ...captureStages].includes(stage)) &&
      Object.keys(historySamples[1].stages_ms).every((stage) =>
        ['history_store', 'total', ...captureStages].includes(stage)),
      JSON.stringify(historySamples));
    console.log('history capture stages (ms)', JSON.stringify(historySamples));
  }
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

// One semantic transaction may combine structural and transform mutations
// across several objects. Undo/Redo must publish the complete root set once,
// with no observable intermediate add/move/delete state.
const compoundBeforeStructure = callJson('orc_get_model_structure', [], []);
const compoundBeforeMesh = callJson('orc_get_model_mesh', [], []);
const compoundTransformState = (mesh) => mesh.objects.map((entry) => ({
  object_idx: entry.object_idx, volume_idx: entry.volume_idx, instance_idx: entry.instance_idx,
  instance_transform: entry.instance_transform, volume_transform: entry.volume_transform,
}));
const compoundBeforeIds = modelIdentity(compoundBeforeStructure);
const compoundPlateIds = callJson('orc_get_plate_session_snapshot', [], []).plates
  .map((plate) => plate.plate_id);
const compoundBeforeObjectIds = new Set(compoundBeforeStructure.objects.map((object) => object.id));
const compoundTx = beginHistory('Compound add move delete');
for (const name of ['Compound added A', 'Compound added B']) {
  const added = callJson('orc_add_shape', ['string', 'string'], ['Cube', name]);
  historyCheck(`${name} applies inside compound transaction`, added.ok === true, JSON.stringify(added));
}
const compoundAddedStructure = callJson('orc_get_model_structure', [], []);
const compoundNewObjects = compoundAddedStructure.objects.filter((object) => !compoundBeforeObjectIds.has(object.id));
historyCheck('compound transaction creates two stable-ID objects', compoundNewObjects.length === 2,
  JSON.stringify(compoundAddedStructure));
const compoundMesh = callJson('orc_get_model_mesh', [], []);
const compoundMoveIndexes = [0, compoundAddedStructure.objects.findIndex((object) => object.id === compoundNewObjects[0].id)];
const compoundMoves = compoundMoveIndexes.map((objectIdx, index) => {
  const body = compoundMesh.objects.find((entry) => entry.object_idx === objectIdx);
  if (!body) throw new Error(`compound move target ${objectIdx} missing`);
  const transform = cloneTransform(body.instance_transform);
  transform.offset[0] += 13 + index;
  delete transform.matrix;
  return { objectIdx: body.object_idx, volumeIdx: body.volume_idx, instanceIdx: body.instance_idx,
    instanceTransform: transform, volumeTransform: body.volume_transform };
});
const compoundMoved = callJson('orc_set_model_transforms', ['string', 'string'],
  [compoundTx, JSON.stringify(compoundMoves)]);
historyCheck('compound transaction moves existing and added objects', compoundMoved.ok === true,
  JSON.stringify(compoundMoved));
const compoundDeleted = callJson('orc_delete_objects', ['string'],
  [JSON.stringify([compoundBeforeStructure.objects[1].id, compoundNewObjects[1].id])]);
historyCheck('compound transaction deletes existing and added objects atomically', compoundDeleted.ok === true,
  JSON.stringify(compoundDeleted));
const compoundCommit = commitHistory('Compound add move delete', compoundTx);
const compoundAfterStructure = callJson('orc_get_model_structure', [], []);
const compoundAfterMesh = callJson('orc_get_model_mesh', [], []);
const compoundTouchedIds = new Set([
  compoundBeforeStructure.objects[0].id,
  compoundBeforeStructure.objects[1].id,
  compoundNewObjects[0].id,
]);
const compoundTouchedIdentity = mergeIdentities(
  compoundBeforeIds.filter((object) => compoundTouchedIds.has(object.object_id)),
  modelIdentity(compoundAfterStructure).filter((object) => compoundTouchedIds.has(object.object_id)),
);
historyCheck('compound transaction commits exactly one entry',
  compoundCommit.undoEntries[0]?.label === 'Compound add move delete');
const compoundUndo = callJson('orc_history_undo', [], []);
historyCheck('compound Undo restores the exact predecessor atomically', compoundUndo.ok === true &&
  JSON.stringify(modelIdentity(callJson('orc_get_model_structure', [], []))) === JSON.stringify(compoundBeforeIds) &&
  JSON.stringify(compoundTransformState(callJson('orc_get_model_mesh', [], []))) ===
    JSON.stringify(compoundTransformState(compoundBeforeMesh)),
  JSON.stringify(compoundUndo));
assertSceneDelta('compound Undo publishes the exact multi-object add/delete/move delta once', compoundUndo,
  compoundTouchedIdentity, compoundPlateIds, compoundBeforeIds.map((object) => object.object_id));
const compoundRedo = callJson('orc_history_redo', [], []);
historyCheck('compound Redo restores exact final stable IDs and transforms', compoundRedo.ok === true &&
  JSON.stringify(modelIdentity(callJson('orc_get_model_structure', [], []))) ===
    JSON.stringify(modelIdentity(compoundAfterStructure)) &&
  JSON.stringify(compoundTransformState(callJson('orc_get_model_mesh', [], []))) ===
    JSON.stringify(compoundTransformState(compoundAfterMesh)),
  JSON.stringify(compoundRedo));
assertSceneDelta('compound Redo publishes the exact multi-object add/delete/move delta once', compoundRedo,
  compoundTouchedIdentity, compoundPlateIds,
  modelIdentity(compoundAfterStructure).map((object) => object.object_id));

// A multi-object renderer gesture is one atomic Worker command and one
// history entry. Rejecting its second target must leave the first untouched;
// stale transaction IDs are rejected before any model write.
const atomicBefore = callJson('orc_get_model_mesh', [], []);
const atomicTx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Atomic multi-object Move', 'project', JSON.stringify(context), '']);
if (!atomicTx.ok || typeof atomicTx.transactionId !== 'string') throw new Error(JSON.stringify(atomicTx));
const atomicTransforms = atomicBefore.objects.slice(0, 2).map((entry, index) => {
  const instanceTransform = cloneTransform(entry.instance_transform);
  delete instanceTransform.matrix;
  instanceTransform.offset[0] += (index + 1) * 11;
  return {
    objectIdx: entry.object_idx, volumeIdx: entry.volume_idx, instanceIdx: entry.instance_idx,
    instanceTransform,
    volumeTransform: entry.volume_transform,
  };
});
const atomicMoved = callJson('orc_set_model_transforms', ['string', 'string'],
  [atomicTx.transactionId, JSON.stringify(atomicTransforms)]);
historyCheck('atomic multi-object transform result', atomicMoved.ok === true && Array.isArray(atomicMoved.instance_transforms));
const atomicAfter = callJson('orc_get_model_mesh', [], []);
historyCheck('atomic multi-object transform changes both live targets',
  atomicAfter.objects.slice(0, 2).every((entry, index) =>
    entry.instance_transform.offset[0] === atomicTransforms[index].instanceTransform.offset[0]),
  JSON.stringify({ atomicBefore, atomicTransforms, atomicAfter }));
const atomicCommit = callJson('orc_history_commit', ['string', 'string'], [atomicTx.transactionId, JSON.stringify(context)]);
historyCheck('atomic multi-object transform commits one history entry',
  atomicCommit.undoEntries?.filter((entry) => entry.label === 'Atomic multi-object Move').length === 1,
  JSON.stringify(atomicCommit));
const atomicUndo = callJson('orc_history_undo', [], []);
historyCheck('atomic multi-object transform undo', atomicUndo.ok === true &&
  callJson('orc_get_model_mesh', [], []).objects.slice(0, 2).every((entry, index) =>
    entry.instance_transform.offset[0] === atomicBefore.objects[index].instance_transform.offset[0]));
const atomicRedo = callJson('orc_history_redo', [], []);
historyCheck('atomic multi-object transform redo', atomicRedo.ok === true);
const rejectedTx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Rejected Atomic Move', 'project', JSON.stringify(context), '']);
const beforeRejected = callJson('orc_get_model_mesh', [], []);
const rejected = callJson('orc_set_model_transforms', ['string', 'string'], [rejectedTx.transactionId,
  JSON.stringify([atomicTransforms[0], { ...atomicTransforms[1], objectIdx: 999 }])]);
historyCheck('atomic second target rejection rolls back all targets', rejected.ok === false &&
  JSON.stringify(callJson('orc_get_model_mesh', [], []).objects.slice(0, 2).map((entry) => entry.instance_transform)) ===
    JSON.stringify(beforeRejected.objects.slice(0, 2).map((entry) => entry.instance_transform)));
const rejectedAbort = callJson('orc_history_abort', ['string'], [rejectedTx.transactionId]);
historyCheck('atomic rejected transaction abort is revision-stable', rejectedAbort.ok === true && rejectedAbort.status.revision === atomicRedo.status.revision);
const staleTx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Stale Atomic Move', 'project', JSON.stringify(context), '']);
const stale = callJson('orc_set_model_transforms', ['string', 'string'], ['tx-stale', JSON.stringify([atomicTransforms[0]])]);
historyCheck('atomic stale transaction is rejected', stale.ok === false);
callJson('orc_history_abort', ['string'], [staleTx.transactionId]);
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

// Repair 1 regression matrix: use the pinned native Orca fixture so a locked
// plate is present, then make a real structural history edit around members
// that cover every live membership state.  The current release has no direct
// plate-reorder command; deleting an intermediate plate is the native grid
// compaction/reorder path and exercises the same ordered session snapshot.
const fixtureArchive = await readFile(resolve(repoRoot,
  'packages/slicer-wasm/fixtures/native-interoperability/orca-native-multi-plate.3mf'));
// The pinned Neo metadata intentionally records both locks as false for the
// interoperability fixture.  Change only the in-memory fixture copy so the
// history baseline contains a real imported locked plate.
const fixtureEntries = readZipEntries(fixtureArchive);
const fixturePaintStates = ['4', '8', '4', '8', '4', '8', '4', '8', '4', '8', '4', '8'];
const fixtureModelEntry = fixtureEntries.find((entry) => entry.name === '3D/3dmodel.model');
if (!fixtureModelEntry) throw new Error('native history fixture is missing 3D/3dmodel.model');
let paintedTriangle = 0;
const fixtureModelText = new TextDecoder().decode(fixtureModelEntry.content);
fixtureModelEntry.content = new TextEncoder().encode(fixtureModelText.replace(
  /<triangle\b[^>]*\/>/g,
  (source) => paintedTriangle < fixturePaintStates.length
    ? source.replace('/>', ` paint_color="${fixturePaintStates[paintedTriangle++]}"/>`)
    : source,
));
historyCheck('paint the native structural history fixture',
  paintedTriangle === fixturePaintStates.length, `painted=${paintedTriangle}`);
const fixtureMetadata = {
  schema: 'org.orcaslicerneo.plate-session', version: 1, current_plate_index: 0,
  plates: [
    { plate_index: 0, origin: [0, 0, 0], name: 'Native Plate 1', locked: false,
      settings: {}, opaque_metadata: [{ key: 'native_future_key', value: 'native-future-value' }] },
    { plate_index: 1, origin: [248.4, 0, 0], name: 'Native Plate 2', locked: true,
      settings: {}, opaque_metadata: [{ key: 'native_second_key', value: 'native-second-value' }] },
  ],
};
fixtureEntries.push({ name: 'Metadata/orca_neo_plate_session_v1.json',
  content: new TextEncoder().encode(JSON.stringify(fixtureMetadata)) });
const fixtureBytes = writeStoredZip(fixtureEntries);
let fixturePtr = writeBytes(fixtureBytes);
const loadedFixture = callJson('orc_load_project',
  ['pointer', 'number', 'number', 'string'], [fixturePtr, fixtureBytes.length, 0, 'history-plate-fixture.3mf']);
Module._free(fixturePtr);
historyCheck('load locked multi-plate fixture', loadedFixture.ok === true && loadedFixture.plate_count === 2,
  JSON.stringify(loadedFixture));
let fixtureSession = callJson('orc_get_plate_session_snapshot', [], []);
const lockedPlateId = fixtureSession.plates.find((plate) => plate.locked)?.plate_id;
historyCheck('fixture retains locked plate state', typeof lockedPlateId === 'string', JSON.stringify(fixtureSession));
const importedFixtureStructure = callJson('orc_get_model_structure', [], []);
const multiInstanceObjectId = importedFixtureStructure.objects?.[0]?.id;
const addedFixtureInstance = callJson('orc_add_instance', ['number'], [multiInstanceObjectId]);
historyCheck('add a second instance to the first imported object',
  addedFixtureInstance.ok === true && Number.isSafeInteger(addedFixtureInstance.instanceId),
  JSON.stringify({ importedFixtureStructure, addedFixtureInstance }));
fixtureSession = callJson('orc_recompute_plate_membership', [], []);
const multiInstanceStructure = callJson('orc_get_model_structure', [], []);
historyCheck('multi-object fixture has stable multi-instance plate membership',
  multiInstanceStructure.objects?.length === 2 &&
  multiInstanceStructure.objects[0].instances?.length === 2 &&
  fixtureSession.instances?.length === 3 &&
  fixtureSession.instances.every((instance) => Number.isSafeInteger(instance.instance_id) &&
    instance.instance_id > 0 && (instance.member || instance.parked)),
  JSON.stringify({ multiInstanceStructure, fixtureSession }));

const fixturePlateOne = fixtureSession.plates[0].plate_id;
const fixturePlateTwo = fixtureSession.plates[1].plate_id;
const addedHistoryPlate = callJson('orc_add_plate', [], []);
const fixturePlateThree = addedHistoryPlate.current_plate_id;
historyCheck('history fixture has three ordered plates', addedHistoryPlate.plates.length === 3 &&
  addedHistoryPlate.plates.map((plate) => plate.display_index).join(',') === '0,1,2');
historyCheck('select plate two for parked fixture', callJson('orc_select_plate', ['string'], [fixturePlateTwo]).ok === true);
const parkedAdded = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'History parked member']);
historyCheck('add parked-member fixture', parkedAdded.ok === true);
historyCheck('select plate three for out-of-bounds fixture',
  callJson('orc_select_plate', ['string'], [fixturePlateThree]).ok === true);
const outOfBoundsAdded = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'History out-of-bounds member']);
historyCheck('add out-of-bounds fixture', outOfBoundsAdded.ok === true);

const fixtureMesh = callJson('orc_get_model_mesh', [], []);
const outOfBoundsObject = (fixtureMesh.objects ?? []).find((object) => object.object_idx === 3);
historyCheck('locate out-of-bounds fixture instance', outOfBoundsObject?.instance_idx === 0,
  JSON.stringify(fixtureMesh));
const outOfBoundsTransform = JSON.stringify({
  offset: [fixturePlateThree ? addedHistoryPlate.plates[2].origin[0] + 120 : 120,
    addedHistoryPlate.plates[2].origin[1], 10],
  rotation: [0, 0, 0], scale: [30, 30, 30], mirror: [1, 1, 1],
});
const movedOutOfBounds = callJson('orc_set_model_transform',
  ['number', 'number', 'number', 'string', 'string'],
  [3, 0, 0, outOfBoundsTransform, JSON.stringify(outOfBoundsObject.volume_transform)]);
historyCheck('move member partially outside plate three', movedOutOfBounds.ok === true,
  JSON.stringify(movedOutOfBounds));
const recomputedFixture = callJson('orc_recompute_plate_membership', [], []);
const outOfBoundsRecord = recomputedFixture.instances?.find((item) => item.object_index === 3);
historyCheck('fixture records member and out-of-bounds independently',
  outOfBoundsRecord?.plate_id === fixturePlateThree && outOfBoundsRecord.out_of_bounds === true,
  JSON.stringify(recomputedFixture));
historyCheck('select plate three before structural history',
  callJson('orc_select_plate', ['string'], [fixturePlateThree]).current_plate_id === fixturePlateThree);

const resetFixtureHistory = callJson('orc_history_reset', ['string'], [JSON.stringify(context)]);
historyCheck('establish structural fixture history baseline',
  resetFixtureHistory.canUndo === false, JSON.stringify(resetFixtureHistory));
let structuralBaseline = callJson('orc_get_plate_session_snapshot', [], []);
const structuralBaselineIdentity = modelIdentity(callJson('orc_get_model_structure', [], []));
assertLiveSessionIntegrity(structuralBaseline, 'structural baseline');
function coordinateArraysMatchPlateCount(session) {
  const snapshot = callJson('orc_get_native_scoped_config');
  const values = snapshot.native_scoped_config?.snapshot;
  return ['wipe_tower_x', 'wipe_tower_y'].every((key) =>
    typeof values?.project?.[key] === 'string' && values.project[key].split(',').length === session.plates.length) &&
    session.plates.every((plate, index) => !Object.hasOwn(plate.settings ?? {}, 'wipe_tower_x') &&
      !Object.hasOwn(plate.settings ?? {}, 'wipe_tower_y'));
}
function coordinateArrayAt(session, plateId, key) {
  const plate = session.plates.find((entry) => entry.plate_id === plateId);
  if (!plate) throw new Error(`missing coordinate plate ${plateId}`);
  const snapshot = callJson('orc_get_native_scoped_config');
  const values = snapshot.native_scoped_config?.snapshot;
  if (typeof values?.project?.[key] !== 'string') throw new Error(`${key} is not serialized`);
  return values.project[key].split(',').map(Number);
}
function coordinateIdentityValues(session, expected) {
  return Object.entries(expected).every(([plateId, values]) =>
    ['wipe_tower_x', 'wipe_tower_y'].every((key) => {
      const actual = coordinateArrayAt(session, plateId, key);
      return actual.length === session.plates.length && actual[values.index] === values[key];
    }));
}
function setProjectCoordinate(key, value) {
  const result = setNativeScopedConfig(callJson, 'project', undefined, key, String(value));
  if (!result.ok) throw new Error(`set project ${key} failed: ${JSON.stringify(result)}`);
}
const coordinateBaselineReset = callJson('orc_history_reset', ['string'], [JSON.stringify(context)]);
historyCheck('coordinate baseline reset retains no extra history entry',
  coordinateBaselineReset.canUndo === false, JSON.stringify(coordinateBaselineReset));
structuralBaseline = callJson('orc_get_plate_session_snapshot', [], []);
const expectedBaselineCoordinates = {
  [fixturePlateOne]: { index: 0, wipe_tower_x: coordinateArrayAt(structuralBaseline, fixturePlateOne, 'wipe_tower_x')[0], wipe_tower_y: coordinateArrayAt(structuralBaseline, fixturePlateOne, 'wipe_tower_y')[0] },
  [fixturePlateTwo]: { index: 1, wipe_tower_x: coordinateArrayAt(structuralBaseline, fixturePlateTwo, 'wipe_tower_x')[1], wipe_tower_y: coordinateArrayAt(structuralBaseline, fixturePlateTwo, 'wipe_tower_y')[1] },
  [fixturePlateThree]: { index: 2, wipe_tower_x: coordinateArrayAt(structuralBaseline, fixturePlateThree, 'wipe_tower_x')[2], wipe_tower_y: coordinateArrayAt(structuralBaseline, fixturePlateThree, 'wipe_tower_y')[2] },
};
historyCheck('structural baseline coordinate arrays match plate count',
  coordinateArraysMatchPlateCount(structuralBaseline));
historyCheck('structural baseline coordinate identity order is explicit',
  coordinateIdentityValues(structuralBaseline, expectedBaselineCoordinates));
historyCheck('structural baseline contains locked plate and all memberships',
  structuralBaseline.plates.some((plate) => plate.plate_id === lockedPlateId && plate.locked) &&
  structuralBaseline.instances.some((item) => item.object_index === 2 && item.plate_id === fixturePlateTwo && item.parked === false) &&
  structuralBaseline.instances.some((item) => item.object_index === 3 && item.plate_id === fixturePlateThree && item.out_of_bounds === true));

function beginHistory(label) {
  const started = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
    [label, 'project', JSON.stringify(context), '']);
  if (!started.ok || typeof started.transactionId !== 'string') throw new Error(`${label} begin failed: ${JSON.stringify(started)}`);
  return started.transactionId;
}
function commitHistory(label, transactionId) {
  const committedHistory = callJson('orc_history_commit', ['string', 'string'],
    [transactionId, JSON.stringify(context)]);
  if (!committedHistory.canUndo || committedHistory.canRedo)
    throw new Error(`${label} commit failed: ${JSON.stringify(committedHistory)}`);
  return committedHistory;
}
function restoreAndCompare(label, expected) {
  const restoredSession = callJson('orc_get_plate_session_snapshot', [], []);
  assertLiveSessionIntegrity(restoredSession, label);
  const revisionsAreFresh = (expected.plates ?? []).every(({ plate_id: plateId }) =>
    Number.isSafeInteger(restoredSession.input_revisions?.[plateId]) &&
    restoredSession.input_revisions[plateId] > expected.input_revisions[plateId]);
  historyCheck(`${label} restores complete session`,
    JSON.stringify(stableSessionShape(restoredSession)) === JSON.stringify(stableSessionShape(expected)) &&
      revisionsAreFresh,
    JSON.stringify({ expected: stableSessionShape(expected), actual: stableSessionShape(restoredSession),
      expectedRevisions: expected.input_revisions, actualRevisions: restoredSession.input_revisions }));
  return restoredSession;
}

// Delete Plate Undo/Redo parks the deleted plate's member and must preserve
// the surviving plate's out-of-bounds member and current identity.
const deleteTransaction = beginHistory('Delete Plate');
const deletedPlate = callJson('orc_delete_plate', ['string'], [fixturePlateTwo]);
historyCheck('delete plate creates parked member and preserves current plate',
  deletedPlate.ok === true && deletedPlate.current_plate_id === fixturePlateThree &&
  deletedPlate.instances.some((item) => item.object_index === 2 && item.plate_id === '' && item.parked) &&
  deletedPlate.instances.some((item) => item.object_index === 3 && item.plate_id === fixturePlateThree && item.out_of_bounds),
  JSON.stringify(deletedPlate));
const deleteAfter = callJson('orc_get_plate_session_snapshot', [], []);
historyCheck('delete compacts coordinate arrays without a separate repair history entry',
  coordinateArraysMatchPlateCount(deleteAfter));
historyCheck('delete compacts surviving coordinate identity order',
  coordinateIdentityValues(deleteAfter, {
    [fixturePlateOne]: { index: 0, wipe_tower_x: expectedBaselineCoordinates[fixturePlateOne].wipe_tower_x, wipe_tower_y: expectedBaselineCoordinates[fixturePlateOne].wipe_tower_y },
    [fixturePlateThree]: { index: 1, wipe_tower_x: expectedBaselineCoordinates[fixturePlateThree].wipe_tower_x, wipe_tower_y: expectedBaselineCoordinates[fixturePlateThree].wipe_tower_y },
  }));
commitHistory('Delete Plate', deleteTransaction);
const deleteUndo = callJson('orc_history_undo', [], []);
historyCheck('Delete Plate undo succeeds', deleteUndo.ok === true, JSON.stringify(deleteUndo));
const deleteUndoSession = restoreAndCompare('Delete Plate undo', structuralBaseline);
historyCheck('multi-instance multi-object restore preserves complete native IDs and plate memberships',
  JSON.stringify(modelIdentity(callJson('orc_get_model_structure', [], []))) ===
    JSON.stringify(structuralBaselineIdentity) &&
  JSON.stringify(stableSessionShape(deleteUndoSession)) ===
    JSON.stringify(stableSessionShape(structuralBaseline)),
  JSON.stringify({ expectedIdentity: structuralBaselineIdentity,
    actualIdentity: modelIdentity(callJson('orc_get_model_structure', [], [])),
    expectedSession: stableSessionShape(structuralBaseline),
    actualSession: stableSessionShape(deleteUndoSession) }));
historyCheck('Delete Plate undo restores coordinate arrays to three plates',
  coordinateArraysMatchPlateCount(deleteUndoSession));
historyCheck('Delete Plate undo restores coordinate identity order',
  coordinateIdentityValues(deleteUndoSession, expectedBaselineCoordinates));
historyCheck('Delete Plate undo restores current plate and member flags',
  deleteUndoSession.current_plate_id === fixturePlateThree &&
  deleteUndoSession.instances.some((item) => item.object_index === 2 && item.plate_id === fixturePlateTwo && !item.parked) &&
  deleteUndoSession.instances.some((item) => item.object_index === 3 && item.plate_id === fixturePlateThree && item.out_of_bounds));
const paintedRestoreExport = callJson('orc_export_project', [], []);
historyCheck('painted history restore exports a native project',
  paintedRestoreExport.ok === true && paintedRestoreExport.bytes_ptr > 0 &&
  paintedRestoreExport.bytes_length > 0, JSON.stringify(paintedRestoreExport));
const paintedRestoreBytes = readAndFree(
  paintedRestoreExport.bytes_ptr, paintedRestoreExport.bytes_length);
const paintedRestoreModel = readZipEntries(paintedRestoreBytes)
  .find((entry) => entry.name === '3D/3dmodel.model');
const restoredPaintStates = paintedRestoreModel
  ? [...new TextDecoder().decode(paintedRestoreModel.content).matchAll(/paint_color="([^"]+)"/g)]
    .map((match) => match[1])
  : [];
historyCheck('painting survives full bridge history restore',
  JSON.stringify(restoredPaintStates) === JSON.stringify(fixturePaintStates),
  JSON.stringify({ expected: fixturePaintStates, actual: restoredPaintStates }));
const deleteRedo = callJson('orc_history_redo', [], []);
historyCheck('Delete Plate redo succeeds', deleteRedo.ok === true, JSON.stringify(deleteRedo));
const deleteRedoSession = restoreAndCompare('Delete Plate redo', deleteAfter);
historyCheck('Delete Plate redo keeps coordinate arrays at two plates',
  coordinateArraysMatchPlateCount(deleteRedoSession));
historyCheck('Delete Plate redo restores compact coordinate identity order',
  coordinateIdentityValues(deleteRedoSession, {
    [fixturePlateOne]: { index: 0, wipe_tower_x: expectedBaselineCoordinates[fixturePlateOne].wipe_tower_x, wipe_tower_y: expectedBaselineCoordinates[fixturePlateOne].wipe_tower_y },
    [fixturePlateThree]: { index: 1, wipe_tower_x: expectedBaselineCoordinates[fixturePlateThree].wipe_tower_x, wipe_tower_y: expectedBaselineCoordinates[fixturePlateThree].wipe_tower_y },
  }));

// Return to the baseline, then exercise the release's plate-order change
// path explicitly.  Intermediate deletion compacts the ordered collection;
// the history frame must restore the original order and current identity.
historyCheck('return to structural baseline before reorder check', callJson('orc_history_undo', [], []).ok === true);
restoreAndCompare('reorder precondition', structuralBaseline);
const reorderTransaction = beginHistory('Reorder Plate');
const reordered = callJson('orc_delete_plate', ['string'], [fixturePlateOne]);
historyCheck('reorder plate compaction changes ordered collection',
  reordered.ok === true && reordered.plates.map((plate) => plate.plate_id).join(',') ===
    `${fixturePlateTwo},${fixturePlateThree}` && reordered.current_plate_id === fixturePlateThree,
  JSON.stringify(reordered));
const reorderAfter = callJson('orc_get_plate_session_snapshot', [], []);
historyCheck('reorder compacts coordinate arrays to two plates',
  coordinateArraysMatchPlateCount(reorderAfter));
historyCheck('reorder compacts coordinate identity order',
  coordinateIdentityValues(reorderAfter, {
    [fixturePlateTwo]: { index: 0, wipe_tower_x: expectedBaselineCoordinates[fixturePlateTwo].wipe_tower_x, wipe_tower_y: expectedBaselineCoordinates[fixturePlateTwo].wipe_tower_y },
    [fixturePlateThree]: { index: 1, wipe_tower_x: expectedBaselineCoordinates[fixturePlateThree].wipe_tower_x, wipe_tower_y: expectedBaselineCoordinates[fixturePlateThree].wipe_tower_y },
  }));
commitHistory('Reorder Plate', reorderTransaction);
historyCheck('Reorder Plate undo succeeds', callJson('orc_history_undo', [], []).ok === true);
const reorderUndoSession = restoreAndCompare('Reorder Plate undo', structuralBaseline);
historyCheck('reorder Undo restores coordinate arrays to three plates',
  coordinateArraysMatchPlateCount(reorderUndoSession));
historyCheck('reorder Undo restores coordinate identity order',
  coordinateIdentityValues(reorderUndoSession, expectedBaselineCoordinates));
historyCheck('Reorder Plate redo succeeds', callJson('orc_history_redo', [], []).ok === true);
const reorderRedoSession = restoreAndCompare('Reorder Plate redo', reorderAfter);
historyCheck('reorder Redo keeps coordinate arrays at two plates',
  coordinateArraysMatchPlateCount(reorderRedoSession));
historyCheck('reorder Redo restores compact coordinate identity order',
  coordinateIdentityValues(reorderRedoSession, {
    [fixturePlateTwo]: { index: 0, wipe_tower_x: expectedBaselineCoordinates[fixturePlateTwo].wipe_tower_x, wipe_tower_y: expectedBaselineCoordinates[fixturePlateTwo].wipe_tower_y },
    [fixturePlateThree]: { index: 1, wipe_tower_x: expectedBaselineCoordinates[fixturePlateThree].wipe_tower_x, wipe_tower_y: expectedBaselineCoordinates[fixturePlateThree].wipe_tower_y },
  }));
historyCheck('locked plate state survives reorder Undo/Redo',
  reorderAfter.plates.find((plate) => plate.plate_id === lockedPlateId)?.locked === true);

// Add Plate remains one timestamped operation whether or not its layout
// reflows existing instances. The mutation response still identifies moved
// instances for renderer projection, while history captures the three roots.
historyCheck('return to three-plate baseline before add reflow profile',
  callJson('orc_history_undo', [], []).ok === true);
const addNoReflowBefore = callJson('orc_get_plate_session_snapshot', [], []);
const addNoReflowBeforeMesh = callJson('orc_get_model_mesh', [], []);
const addNoReflowPlateIds = new Set(addNoReflowBefore.plates.map((plate) => plate.plate_id));
const modelTransformState = (mesh) => (mesh.objects ?? []).map((object) => ({
  object_idx: object.object_idx,
  instance_transform: object.instance_transform,
}));
const addNoReflowTransaction = beginHistory('Add Plate');
const addNoReflow = callJson('orc_add_plate', [], []);
historyCheck('Add Plate no-reflow omits unchanged transforms',
  addNoReflow.ok === true && addNoReflow.plates.length === 4 &&
  (!Object.hasOwn(addNoReflow, 'instance_transforms') || addNoReflow.instance_transforms.length === 0),
  JSON.stringify(addNoReflow));
const addNoReflowStableBefore = {
  plates: addNoReflowBefore.plates.filter((plate) => addNoReflowPlateIds.has(plate.plate_id)),
  instances: addNoReflowBefore.instances,
  input_revisions: Object.fromEntries([...addNoReflowPlateIds].map((id) => [id, addNoReflowBefore.input_revisions[id]])),
};
const addNoReflowStableAfter = {
  plates: addNoReflow.plates.filter((plate) => addNoReflowPlateIds.has(plate.plate_id)),
  instances: addNoReflow.instances,
  input_revisions: Object.fromEntries([...addNoReflowPlateIds].map((id) => [id, addNoReflow.input_revisions[id]])),
};
historyCheck('Add Plate stable-origin gate preserves old state',
  JSON.stringify(addNoReflowStableAfter) === JSON.stringify(addNoReflowStableBefore) &&
  JSON.stringify(modelTransformState(callJson('orc_get_model_mesh', [], []))) ===
    JSON.stringify(modelTransformState(addNoReflowBeforeMesh)) &&
  Array.isArray(addNoReflow.affected_plate_ids) && addNoReflow.affected_plate_ids.length === 0,
  JSON.stringify({ before: addNoReflowStableBefore, after: addNoReflowStableAfter, addNoReflow }));
historyCheck('Add Plate creates a fresh zero-revision plate entry',
  addNoReflow.plates.some((plate) => !addNoReflowPlateIds.has(plate.plate_id)) &&
  addNoReflow.plates.filter((plate) => !addNoReflowPlateIds.has(plate.plate_id))
    .every((plate) => addNoReflow.input_revisions[plate.plate_id] === 0),
  JSON.stringify(addNoReflow));
const addNoReflowCommit = commitHistory('Add Plate no-reflow', addNoReflowTransaction);
const addNoReflowProfile = callJson('orc_take_performance_profile', [], []);
const addNoReflowHistorySamples = addNoReflowProfile.samples.filter((sample) =>
  ['history_begin', 'add_plate', 'history_commit'].includes(sample.operation)).slice(-3);
historyCheck('Add Plate no-reflow captures timestamp roots',
  addNoReflowHistorySamples.length === 3 &&
  addNoReflowHistorySamples.filter((sample) => sample.operation !== 'add_plate')
    .every((sample) => typeof sample.stages_ms.capture_model_state === 'number' &&
      typeof sample.stages_ms.capture_collection_cache === 'number'));
const addReflowTransaction = beginHistory('Add Plate');
const addReflowBefore = callJson('orc_get_plate_session_snapshot', [], []);
const addReflow = callJson('orc_add_plate', [], []);
historyCheck('Add Plate reflow records only moved instances',
  addReflow.ok === true && addReflow.plates.length === 5 &&
  Array.isArray(addReflow.instance_transforms) && addReflow.instance_transforms.length > 0,
  JSON.stringify(addReflow));
const addReflowChanged = new Set(addReflow.affected_plate_ids ?? []);
const addReflowOldIds = addReflowBefore.plates.map((plate) => plate.plate_id);
const expectedAddReflowChanged = new Set(addReflowBefore.plates
  .filter((beforePlate) => {
    const afterPlate = addReflow.plates.find((plate) => plate.plate_id === beforePlate.plate_id);
    return afterPlate !== undefined && afterPlate.origin.some((value, axis) => value !== beforePlate.origin[axis]);
  })
  .map((plate) => plate.plate_id));
historyCheck('Add Plate reflow invalidates only origin-changed plates',
  addReflowChanged.size === expectedAddReflowChanged.size &&
  addReflow.affected_plate_ids?.length === expectedAddReflowChanged.size &&
  [...expectedAddReflowChanged].every((id) => addReflowChanged.has(id)) &&
  addReflowOldIds.every((id) => addReflowChanged.has(id)
    ? addReflow.input_revisions[id] > addReflowBefore.input_revisions[id]
    : addReflow.input_revisions[id] === addReflowBefore.input_revisions[id]) &&
  addReflow.plates.filter((plate) => !addReflowOldIds.includes(plate.plate_id))
    .every((plate) => addReflow.input_revisions[plate.plate_id] === 0),
  JSON.stringify({ before: addReflowBefore.input_revisions, after: addReflow.input_revisions,
    expected: [...expectedAddReflowChanged], affected: addReflow.affected_plate_ids }));
const addReflowCommit = commitHistory('Add Plate reflow', addReflowTransaction);
const addReflowProfile = callJson('orc_take_performance_profile', [], []);
const addReflowHistorySamples = addReflowProfile.samples.filter((sample) =>
  ['history_begin', 'add_plate', 'history_commit'].includes(sample.operation)).slice(-3);
historyCheck('Add Plate reflow captures timestamp roots',
  addReflowHistorySamples.length === 3 &&
  addReflowHistorySamples.filter((sample) => sample.operation !== 'add_plate')
    .every((sample) => typeof sample.stages_ms.capture_model_state === 'number' &&
      typeof sample.stages_ms.capture_collection_cache === 'number'));
const afterAddTransform = cloneTransform((callJson('orc_get_model_mesh', [], []).objects ?? [])
  .find((object) => object.object_idx === 3)?.instance_transform);
delete afterAddTransform.matrix;
const afterAddVolumeTransform = cloneTransform((callJson('orc_get_model_mesh', [], []).objects ?? [])
  .find((object) => object.object_idx === 3)?.volume_transform);
delete afterAddVolumeTransform.matrix;
const afterAddEdit = { ...afterAddTransform,
  offset: [afterAddTransform.offset[0] + 7, afterAddTransform.offset[1], afterAddTransform.offset[2]] };
const afterAddVolumeEdit = { ...afterAddVolumeTransform,
  offset: [afterAddVolumeTransform.offset[0] + 3, afterAddVolumeTransform.offset[1], afterAddVolumeTransform.offset[2]] };
const normalAfterAddTransaction = beginHistory('Move After Add Plate');
const normalAfterAddMutation = callJson('orc_set_model_transform',
  ['number', 'number', 'number', 'string', 'string'],
  [3, 0, 0, JSON.stringify(afterAddEdit), JSON.stringify(afterAddVolumeEdit)]);
if (!normalAfterAddMutation.ok)
  throw new Error(`normal edit after Add Plate failed: ${JSON.stringify(normalAfterAddMutation)}`);
const normalAfterAddCommit = commitHistory('Move After Add Plate', normalAfterAddTransaction);
const normalAfterAddUndo = callJson('orc_history_undo', [], []);
const afterAddUndoMesh = (callJson('orc_get_model_mesh', [], []).objects ?? [])
  .find((object) => object.object_idx === 3)?.instance_transform;
historyCheck('normal undo returns to Add Plate after-transform state',
  normalAfterAddUndo.ok === true && normalAfterAddUndo.impact?.model === 'delta' &&
  !Object.hasOwn(normalAfterAddUndo, 'instance_transforms') &&
  callJson('orc_get_plate_session_snapshot', [], []).plates.length === 5,
  JSON.stringify({ normalAfterAddUndo, afterAddUndoMesh }));
assertTransformEqual(afterAddUndoMesh, afterAddTransform, 'Add Plate after-transform state');
const afterAddUndoVolume = (callJson('orc_get_model_mesh', [], []).objects ?? [])
  .find((object) => object.object_idx === 3)?.volume_transform;
assertTransformEqual(afterAddUndoVolume, afterAddVolumeTransform, 'Add Plate volume baseline state');
const normalAfterAddRedo = callJson('orc_history_redo', [], []);
const afterAddRedoMesh = (callJson('orc_get_model_mesh', [], []).objects ?? [])
  .find((object) => object.object_idx === 3)?.instance_transform;
historyCheck('normal redo restores edit after Add Plate', normalAfterAddRedo.ok === true,
  JSON.stringify(normalAfterAddRedo));
assertTransformEqual(afterAddRedoMesh, afterAddEdit, 'normal edit after Add Plate');
const afterAddRedoVolume = (callJson('orc_get_model_mesh', [], []).objects ?? [])
  .find((object) => object.object_idx === 3)?.volume_transform;
assertTransformEqual(afterAddRedoVolume, afterAddVolumeEdit, 'normal volume edit after Add Plate');
const normalAfterAddUndoAgain = callJson('orc_history_undo', [], []);
historyCheck('normal undo again returns to Add Plate state',
  normalAfterAddUndoAgain.ok === true && callJson('orc_get_plate_session_snapshot', [], []).plates.length === 5,
  JSON.stringify(normalAfterAddUndoAgain));
const addReflowUndo = callJson('orc_history_undo', [], []);
historyCheck('Add Plate reflow undo restores four plates',
  addReflowUndo.ok === true && callJson('orc_get_plate_session_snapshot', [], []).plates.length === 4,
  JSON.stringify({ addReflowUndo, status: callJson('orc_history_status', [], []) }));
const addNoReflowUndo = callJson('orc_history_undo', [], []);
historyCheck('Add Plate no-reflow undo restores three plates',
  addNoReflowUndo.ok === true && callJson('orc_get_plate_session_snapshot', [], []).plates.length === 3,
  JSON.stringify(addNoReflowUndo));
const addNoReflowRedo = callJson('orc_history_redo', [], []);
historyCheck('Add Plate no-reflow redo restores four plates',
  addNoReflowRedo.ok === true && callJson('orc_get_plate_session_snapshot', [], []).plates.length === 4,
  JSON.stringify(addNoReflowRedo));
const addAfterUndo = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Add Plate', 'project', JSON.stringify(context), '']);
if (!addAfterUndo.ok) throw new Error(`Add Plate branch begin failed: ${JSON.stringify(addAfterUndo)}`);
const addAfterUndoMutation = callJson('orc_add_plate', [], []);
const addAfterUndoCommit = commitHistory('Add Plate after undo', addAfterUndo.transactionId);
historyCheck('Add Plate after undo discards redo branch',
  addAfterUndoMutation.ok === true && addAfterUndoCommit.canRedo === false &&
  callJson('orc_get_plate_session_snapshot', [], []).plates.length === 5,
  JSON.stringify(addAfterUndoCommit));
historyCheck('restore add-plate profile fixture baseline',
  callJson('orc_history_undo', [], []).ok === true &&
  callJson('orc_history_undo', [], []).ok === true &&
  callJson('orc_get_plate_session_snapshot', [], []).plates.length === 3);

// Repair 5 directional menu-jump matrix.  Isolate the real bridge exercise
// from the structural fixture above: the reset gives the scenario a known
// empty baseline, and the final reset prevents this diagnostic from leaking
// state into any future checks added below.
historyCheck('reset directional jump fixture',
  callJson('orc_clear_model', [], []).ok === true &&
  callJson('orc_history_reset', ['string'], [JSON.stringify(context)]).canUndo === false);
const jumpFirstTransaction = beginHistory('Jump First');
const jumpFirstAdded = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Jump first']);
historyCheck('directional jump first edit applies', jumpFirstAdded.ok === true, JSON.stringify(jumpFirstAdded));
const jumpFirstCommit = commitHistory('Jump First', jumpFirstTransaction);
const jumpFirstId = jumpFirstCommit.undoEntries[0]?.id;
historyCheck('capture first directional jump ID', typeof jumpFirstId === 'string', JSON.stringify(jumpFirstCommit));

const jumpSecondTransaction = beginHistory('Jump Second');
const jumpSecondAdded = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Jump second']);
historyCheck('directional jump second edit applies', jumpSecondAdded.ok === true, JSON.stringify(jumpSecondAdded));
const jumpSecondCommit = commitHistory('Jump Second', jumpSecondTransaction);
const jumpSecondId = jumpSecondCommit.undoEntries[0]?.id;
historyCheck('capture second directional jump ID', typeof jumpSecondId === 'string', JSON.stringify(jumpSecondCommit));

const topUndoJump = callJson('orc_history_jump', ['string', 'string'], [jumpSecondId, 'undo']);
const afterTopUndoJump = callJson('orc_get_model_structure', [], []);
historyCheck('top Undo jump changes the model', topUndoJump.ok === true && afterTopUndoJump.objects.length === 1,
  JSON.stringify({ topUndoJump, afterTopUndoJump }));

const olderUndoJump = callJson('orc_history_jump', ['string', 'string'], [jumpFirstId, 'undo']);
const afterOlderUndoJump = callJson('orc_get_model_structure', [], []);
historyCheck('older Undo removes selected and later project edits',
  olderUndoJump.ok === true && afterOlderUndoJump.objects.length === 0,
  JSON.stringify({ olderUndoJump, afterOlderUndoJump }));

const firstRedoJump = callJson('orc_history_jump', ['string', 'string'], [jumpFirstId, 'redo']);
const secondRedoJump = callJson('orc_history_jump', ['string', 'string'], [jumpSecondId, 'redo']);
const afterRedoJump = callJson('orc_get_model_structure', [], []);
historyCheck('Redo restores the selected after-state',
  firstRedoJump.ok === true && secondRedoJump.ok === true && afterRedoJump.objects.length === 2,
  JSON.stringify({ firstRedoJump, secondRedoJump, afterRedoJump }));

const oppositeDirection = callJson('orc_history_jump', ['string', 'string'], [jumpSecondId, 'redo']);
historyCheck('opposite-direction jump is rejected', typeof oppositeDirection.error === 'string',
  JSON.stringify(oppositeDirection));
historyCheck('stale jump is rejected after branching',
  typeof callJson('orc_history_jump', ['string', 'string'], ['entry-999999', 'undo']).error === 'string',
  JSON.stringify(callJson('orc_history_status', [], [])));
const branchForStale = callJson('orc_history_jump', ['string', 'string'], [jumpFirstId, 'undo']);
historyCheck('prepare branch point for stale jump', branchForStale.ok === true, JSON.stringify(branchForStale));
const staleTransaction = beginHistory('Jump Replacement');
const staleAdded = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Jump replacement']);
historyCheck('stale replacement edit applies', staleAdded.ok === true, JSON.stringify(staleAdded));
const staleCommit = commitHistory('Jump Replacement', staleTransaction);
historyCheck('evicted branch jump is rejected',
  typeof callJson('orc_history_jump', ['string', 'string'], [jumpSecondId, 'redo']).error === 'string',
  JSON.stringify(staleCommit));
historyCheck('restore directional fixture baseline',
  callJson('orc_clear_model', [], []).ok === true &&
  callJson('orc_history_reset', ['string'], [JSON.stringify(context)]).canUndo === false);

const plateJumpIds = [];
for (const ordinal of ['Second', 'Third', 'Fourth']) {
  const transaction = beginHistory(`Add ${ordinal} Plate`);
  const added = callJson('orc_add_plate', [], []);
  historyCheck(`direct menu fixture adds ${ordinal.toLowerCase()} plate`, added.ok === true,
    JSON.stringify(added));
  const committedPlate = commitHistory(`Add ${ordinal} Plate`, transaction);
  plateJumpIds.push(committedPlate.undoEntries[0]?.id);
}
historyCheck('multiple Add Plate entries expose stable menu IDs',
  plateJumpIds.every((id) => typeof id === 'string') &&
  callJson('orc_get_plate_session_snapshot', [], []).plates.length === 4,
  JSON.stringify(plateJumpIds));
const plateJumpUndo = callJson('orc_history_jump', ['string', 'string'], [plateJumpIds[0], 'undo']);
historyCheck('multi-entry Add Plate Undo menu loads selected predecessor directly',
  plateJumpUndo.ok === true && callJson('orc_get_plate_session_snapshot', [], []).plates.length === 1,
  JSON.stringify(plateJumpUndo));
const plateJumpRedo = callJson('orc_history_jump', ['string', 'string'], [plateJumpIds[2], 'redo']);
historyCheck('multi-entry Add Plate Redo menu loads selected after timestamp directly',
  plateJumpRedo.ok === true && callJson('orc_get_plate_session_snapshot', [], []).plates.length === 4,
  JSON.stringify(plateJumpRedo));
historyCheck('restore multi-plate menu fixture baseline',
  callJson('orc_clear_model', [], []).ok === true &&
  callJson('orc_history_reset', ['string'], [JSON.stringify(context)]).canUndo === false);

// An Add Plate timestamp can precede the first model edit. Undoing that
// edit must restore the empty two-plate predecessor, whose complete
// plate session legitimately has no model instances.
const emptyPlateTransaction = beginHistory('Add Plate');
const emptyPlateAdded = callJson('orc_add_plate', [], []);
historyCheck('empty-scene Add Plate applies',
  emptyPlateAdded.ok === true && emptyPlateAdded.plates.length === 2,
  JSON.stringify(emptyPlateAdded));
commitHistory('empty-scene Add Plate', emptyPlateTransaction);
const firstCubeAfterPlateTransaction = beginHistory('Add Cube');
const firstCubeAfterPlate = callJson('orc_add_shape', ['string', 'string'],
  ['Cube', 'First cube after plate']);
historyCheck('first Cube after empty-scene Add Plate applies',
  firstCubeAfterPlate.ok === true, JSON.stringify(firstCubeAfterPlate));
commitHistory('first Cube after empty-scene Add Plate', firstCubeAfterPlateTransaction);
const firstCubeAfterPlateUndo = callJson('orc_history_undo', [], []);
const emptyPlateUndoStructure = callJson('orc_get_model_structure', [], []);
const emptyPlateUndoSession = callJson('orc_get_plate_session_snapshot', [], []);
historyCheck('Undo first Cube restores empty two-plate predecessor',
  firstCubeAfterPlateUndo.ok === true && emptyPlateUndoStructure.objects.length === 0 &&
  emptyPlateUndoSession.plates.length === 2 && emptyPlateUndoSession.instances.length === 0,
  JSON.stringify({ firstCubeAfterPlateUndo, emptyPlateUndoStructure, emptyPlateUndoSession }));
historyCheck('restore empty-plate fixture baseline',
  callJson('orc_clear_model', [], []).ok === true &&
  callJson('orc_history_reset', ['string'], [JSON.stringify(context)]).canUndo === false);

// A menu jump is one direct timestamp restore when its target crosses Move
// and Add Plate entries. This ensures a retained target never becomes stale
// merely because other entries were crossed.
const mixedFirstTransaction = beginHistory('Add Cube');
const mixedFirstAdded = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Mixed first']);
historyCheck('mixed jump first Add Cube applies', mixedFirstAdded.ok === true, JSON.stringify(mixedFirstAdded));
const mixedFirstCommit = commitHistory('mixed jump first Add Cube', mixedFirstTransaction);
const mixedFirstId = mixedFirstCommit.undoEntries[0]?.id;
historyCheck('capture mixed jump first ID', typeof mixedFirstId === 'string', JSON.stringify(mixedFirstCommit));

const mixedBeforeMove = callJson('orc_get_model_mesh', [], []);
const mixedBody = mixedBeforeMove.objects?.[0];
if (!mixedBody) throw new Error(`mixed jump Cube mesh unavailable: ${JSON.stringify(mixedBeforeMove)}`);
const mixedMoveTransform = cloneTransform(mixedBody.instance_transform);
mixedMoveTransform.offset[0] += 10;
delete mixedMoveTransform.matrix;
const mixedMoveTransaction = beginHistory('Move');
const mixedMove = callJson('orc_set_model_transforms', ['string', 'string'], [mixedMoveTransaction,
  JSON.stringify([{ objectIdx: mixedBody.object_idx, volumeIdx: mixedBody.volume_idx,
    instanceIdx: mixedBody.instance_idx, instanceTransform: mixedMoveTransform,
    volumeTransform: mixedBody.volume_transform }])]);
historyCheck('mixed jump Move applies', mixedMove.ok === true, JSON.stringify(mixedMove));
commitHistory('mixed jump Move', mixedMoveTransaction);

const mixedPlateTransaction = beginHistory('Add Plate');
const mixedPlate = callJson('orc_add_plate', [], []);
historyCheck('mixed jump Add Plate applies', mixedPlate.ok === true && mixedPlate.plates.length === 2,
  JSON.stringify(mixedPlate));
commitHistory('mixed jump Add Plate', mixedPlateTransaction);

const mixedSecondTransaction = beginHistory('Add Cube');
const mixedSecondAdded = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Mixed second']);
historyCheck('mixed jump second Add Cube applies', mixedSecondAdded.ok === true, JSON.stringify(mixedSecondAdded));
const mixedSecondCommit = commitHistory('mixed jump second Add Cube', mixedSecondTransaction);
const mixedSecondId = mixedSecondCommit.undoEntries[0]?.id;
historyCheck('capture mixed jump second ID', typeof mixedSecondId === 'string', JSON.stringify(mixedSecondCommit));
const mixedFinalStructure = callJson('orc_get_model_structure', [], []);
const mixedFinalIdentity = modelIdentity(mixedFinalStructure);
const mixedFinalPlateIds = callJson('orc_get_plate_session_snapshot', [], []).plates
  .map((plate) => plate.plate_id);
const mixedFinalTransforms = modelTransformState(callJson('orc_get_model_mesh', [], []));
const mixedRevisionBeforeUndo = mixedSecondCommit.revision;

const mixedUndoJump = callJson('orc_history_jump', ['string', 'string'], [mixedFirstId, 'undo']);
const mixedUndoStructure = callJson('orc_get_model_structure', [], []);
const mixedUndoPlates = callJson('orc_get_plate_session_snapshot', [], []);
historyCheck('one Undo jump crosses Add Cube, Move, and Add Plate entries',
  mixedUndoJump.ok === true && mixedUndoJump.impact?.model === 'delta' &&
  mixedUndoJump.status.revision === mixedRevisionBeforeUndo + 1 &&
  mixedUndoStructure.objects.length === 0 && mixedUndoPlates.plates.length === 1,
  JSON.stringify({ mixedUndoJump, mixedUndoStructure, mixedUndoPlates }));
assertSceneDelta('one Undo jump unions every crossed stable-ID and plate change once', mixedUndoJump,
  mixedFinalIdentity, mixedFinalPlateIds, []);

const mixedRedoJump = callJson('orc_history_jump', ['string', 'string'], [mixedSecondId, 'redo']);
const mixedRedoStructure = callJson('orc_get_model_structure', [], []);
const mixedRedoPlates = callJson('orc_get_plate_session_snapshot', [], []);
const mixedRedoTransforms = modelTransformState(callJson('orc_get_model_mesh', [], []));
historyCheck('one Redo jump restores the complete mixed after-state',
  mixedRedoJump.ok === true && mixedRedoJump.impact?.model === 'delta' &&
  mixedRedoStructure.objects.length === 2 && mixedRedoPlates.plates.length === 2 &&
  JSON.stringify(mixedRedoTransforms) === JSON.stringify(mixedFinalTransforms),
  JSON.stringify({ mixedRedoJump, mixedRedoStructure, mixedRedoPlates,
    expected: mixedFinalTransforms, actual: mixedRedoTransforms }));
assertSceneDelta('one Redo jump unions every crossed stable-ID and plate change once', mixedRedoJump,
  mixedFinalIdentity, mixedFinalPlateIds, mixedFinalIdentity.map((object) => object.object_id));
historyCheck('restore mixed directional fixture baseline',
  callJson('orc_clear_model', [], []).ok === true &&
  callJson('orc_history_reset', ['string'], [JSON.stringify(context)]).canUndo === false);

// Repair 6 real-bridge accounting diagnostic. A genuine project mutation with
// a long context and label must increase the retained-resource status used by
// restore. Native fixture tests cover budget eviction deterministically.
const accountingTransaction = beginHistory('Accounting restore');
const accountingAdded = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Accounting restore']);
historyCheck('accounting restore fixture edit applies', accountingAdded.ok === true,
  JSON.stringify(accountingAdded));
commitHistory('Accounting restore', accountingTransaction);
const accountingBaseline = callJson('orc_history_status', [], []);
const accountingLabel = 'Accounting long label '.repeat(16);
const accountingContext = { ...context,
  selection: { ...context.selection,
    objectIds: Array.from({ length: 512 }, (_, index) => index) } };
const accountingContextJson = JSON.stringify(accountingContext);
const accountingLongBegin = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  [accountingLabel, 'project', accountingContextJson, '']);
const accountingLongAdded = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Accounting long']);
const accountingLong = callJson('orc_history_commit', ['string', 'string'],
  [accountingLongBegin.transactionId, accountingContextJson]);
historyCheck('history accounting exposes deterministic bridge diagnostics',
  Number.isSafeInteger(accountingBaseline.bytesUsed) &&
  accountingLongBegin.ok === true && accountingLongAdded.ok === true &&
  Number.isSafeInteger(accountingLong.bytesUsed),
  JSON.stringify({ accountingBaseline, accountingLongBegin, accountingLongAdded, accountingLong }));
const accountingDelta = accountingLong.bytesUsed - accountingBaseline.bytesUsed;
historyCheck('long project label/context growth is retained',
  accountingDelta > accountingContextJson.length && accountingLong.bytesUsed > accountingBaseline.bytesUsed,
  JSON.stringify({ accountingDelta, contextBytes: accountingContextJson.length,
    labelBytes: accountingLabel.length, accountingBaseline, accountingLong }));
const accountingUndo = callJson('orc_history_undo', [], []);
const accountingUndoModel = callJson('orc_get_model_structure', [], []);
historyCheck('accounting status remains valid through retained restore',
  accountingUndo.ok === true && accountingUndo.status?.bytesUsed >= accountingLong.bytesUsed &&
  accountingUndoModel.ok === true && accountingUndoModel.objects.length === 1,
  JSON.stringify({ accountingUndo, accountingUndoModel }));
const accountingRedo = callJson('orc_history_redo', [], []);
historyCheck('accounting diagnostic restore redoes successfully',
  accountingRedo.ok === true && accountingRedo.status?.bytesUsed === accountingUndo.status?.bytesUsed &&
  callJson('orc_get_model_structure', [], []).objects.length === 2,
  JSON.stringify({ accountingRedo, model: callJson('orc_get_model_structure', [], []) }));
// Existing used-slot summaries must survive only semantically irrelevant
// history changes. This adds no summary, retained data, key, or lifetime.
const usageObjectId = callJson('orc_get_model_structure', [], []).objects[0].id;
for (const [key, value, preservesUsage] of [
  ['layer_height', '0.27', true],
  ['enable_support', '1', false],
  ['transform', '', true],
]) {
  const usageTransaction = beginHistory(`Usage invalidation ${key}`);
  if (key === 'transform') {
    const body = callJson('orc_get_model_mesh', [], []).objects[0];
    const transform = { ...body.instance_transform,
      offset: [body.instance_transform.offset[0] + 2, body.instance_transform.offset[1], body.instance_transform.offset[2]] };
    delete transform.matrix;
    historyCheck('usage fixture moves instance', callJson('orc_set_model_transforms', ['string', 'string'],
      [usageTransaction, JSON.stringify([{ objectIdx: body.object_idx, volumeIdx: body.volume_idx,
        instanceIdx: body.instance_idx, instanceTransform: transform, volumeTransform: body.volume_transform }])]).ok === true);
  } else {
    historyCheck(`usage fixture sets ${key}`, setNativeScopedConfig(callJson,
      'object', usageObjectId, key, value).ok === true);
  }
  commitHistory(`Usage invalidation ${key}`, usageTransaction);
  callJson('orc_get_prime_tower_projection', [], []);
  for (const direction of ['undo', 'redo']) {
    callJson('orc_take_performance_profile', [], []);
    historyCheck(`usage fixture ${direction} ${key}`,
      callJson(`orc_history_${direction}`, [], []).ok === true);
    callJson('orc_get_prime_tower_projection', [], []);
    const usageProfile = callJson('orc_take_performance_profile', [], []);
    const projection = usageProfile.samples.find((sample) => sample.operation === 'prime_tower_projection');
    const fallback = projection?.stages_ms?.used_slot_full_scan_fallback;
    historyCheck(`${direction} ${key} ${preservesUsage ? 'preserves' : 'invalidates'} existing usage summary`,
      preservesUsage ? fallback === 0 : fallback > 0, JSON.stringify(usageProfile));
  }
}
for (const [operation, payload] of [
  ['orc_set_filament_slot_colour', { slot: 1, colour: '#123456' }],
  ['orc_set_filament_routing', { selector: 'support-base', slot: 1, targets: [{ kind: 'project', id: 0 }] }],
  ['orc_set_filament_routing', { selector: 'support-interface', slot: 1, targets: [{ kind: 'object', id: usageObjectId }] }],
]) {
  const filamentSnapshot = callJson('orc_get_filament_session_snapshot', [], []);
  const changed = callJson(operation, ['string'], [JSON.stringify({
    version: 1, revision: filamentSnapshot.revisions.session, ...payload,
  })]);
  historyCheck(`filament projection fixture ${operation} ${payload.selector ?? 'colour'}`,
    changed.ok === true, JSON.stringify(changed));
  for (const direction of ['undo', 'redo']) {
    const restored = callJson(`orc_history_${direction}`, [], []);
    historyCheck(`${direction} refreshes filament projection for ${payload.selector ?? 'colour'}`,
      restored.ok === true && restored.impact.filamentRack === true, JSON.stringify(restored));
  }
}
console.log(`history smoke passed (${moduleArg})`);
