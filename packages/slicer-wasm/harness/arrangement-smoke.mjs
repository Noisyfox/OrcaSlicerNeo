// Native arrangement publication, partial-success, rollback and single-step history.
import { resolve } from 'node:path';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { awaitAsyncTask, getSliceResult } from './async-task-mailbox.mjs';
const repo = resolve(import.meta.dirname, '../../..');
const module = await (await loadModuleFactory(process.argv[2]))({ noInitialRun: true, printErr: console.error });
await installProfilePackages(module, createNodeProfileSource(resolve(repo, 'packages/profile-resources/dist')));
function call(name, types = [], args = []) {
  const ptr = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(ptr)); } finally { module._free(ptr); }
}
function check(label, condition, detail) {
  if (!condition) throw new Error(`${label}: ${JSON.stringify(detail)}`);
  console.log(`arrange PASS ${label}`);
}
function ok(label, value) { check(label, value.ok === true, value); return value; }
const context = { selection: { mode: 'object', objectIds: [], instanceIds: [], partIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
function history() { return call('orc_history_status'); }
function observe() {
  const mesh = call('orc_get_model_mesh');
  for (const geometry of [...mesh.geometries, ...(mesh.paint_geometries ?? [])]) {
    module._free(BigInt(geometry.vertex_ptr));
    module._free(BigInt(geometry.index_ptr));
  }
  return { model: mesh.renderables, plates: call('orc_get_plate_session_snapshot') };
}
async function arrange(options = {}) {
  const accepted = call('orc_arrange', ['string'], [JSON.stringify(options)]);
  return accepted.task_id ? await awaitAsyncTask(call, accepted) : accepted;
}
ok('initialize', call('orc_init', ['string'], ['{"log_level":"error"}']));
ok('clear model', call('orc_clear_model'));
for (let i = 0; i < 2; ++i) ok('create cube', call('orc_add_shape', ['string', 'string'], ['Cube', `Cube ${i + 1}`]));
call('orc_history_reset', ['string'], [JSON.stringify(context)]);
let before = observe();
let beforeHistory = history();
if (call('orc_get_threading_info').threaded) {
  const task = call('orc_arrange', ['string'], ['{}']);
  check('threaded operation returns acceptance', task.accepted, task);
  check('second arrangement rejected', call('orc_arrange', ['string'], ['{}']).ok === false);
  check('stale cancellation rejected', call('orc_cancel_arrangement', ['string'], ['0']).ok === false);
  ok('cancel correct task', call('orc_cancel_arrangement', ['string'], [task.task_id]));
  const cancelled = await awaitAsyncTask(call, task);
  check('cancelled task has no changes', cancelled.cancelled && !cancelled.changed, cancelled);
  check('cancellation preserves transforms, plates, and undo', JSON.stringify(observe()) === JSON.stringify(before) && history().undoEntries.length === beforeHistory.undoEntries.length);
  const stale = call('orc_arrange', ['string'], ['{}']);
  ok('change input before stale completion', call('orc_add_shape', ['string', 'string'], ['Cube', 'Late instance']));
  const changed = observe();
  const rejected = await awaitAsyncTask(call, stale);
  check('obsolete result rejected', !rejected.ok && rejected.error.includes('input changed'), rejected);
  check('obsolete result cannot overwrite input', JSON.stringify(observe()) === JSON.stringify(changed));
  const structure = call('orc_get_model_structure');
  ok('remove stale fixture', call('orc_delete_objects', ['string'], [JSON.stringify([structure.objects.at(-1).id])]));
  before = observe(); beforeHistory = history();
}
const failed = await arrange({ inject_failure_stage: 'before-publish' });
check('injected application fails', failed.ok === false, failed);
check('failed application preserves project', JSON.stringify(observe()) === JSON.stringify(before));
check('failed application adds no history', history().undoEntries.length === beforeHistory.undoEntries.length);
const completed = ok('arrange all', await arrange());
check('both instances placed', completed.placed === 2 && completed.unplaced.length === 0, completed);
check('one undo step', history().undoEntries.length === beforeHistory.undoEntries.length + 1);
check('receipt has committed history revision', completed.plate_session.native_scoped_config.revision === history().revision);
const after = observe();
check('arrangement changes actual transforms', JSON.stringify(after.model) !== JSON.stringify(before.model));
ok('undo arrangement', call('orc_history_undo'));
check('undo restores model transforms', JSON.stringify(observe().model) === JSON.stringify(before.model));
ok('redo arrangement', call('orc_history_redo'));
check('redo restores model transforms', JSON.stringify(observe().model) === JSON.stringify(after.model));

// Large footprints force distinct bins while preserving height and scale.
for (let i = 0; i < 2; ++i) ok('enlarge footprint', call('orc_set_model_transform',
  ['number', 'number', 'number', 'string', 'string'], [i, 0, 0,
    JSON.stringify({ offset: [100, 100, 10], rotation: [0,0,0], scale: [9,9,1], mirror: [1,1,1] }),
    JSON.stringify({ offset: [0,0,0], rotation: [0,0,0], scale: [1,1,1], mirror: [1,1,1] })]));
ok('recompute membership', call('orc_recompute_plate_membership'));
call('orc_history_reset', ['string'], [JSON.stringify(context)]);
const local = ok('arrange current plate', await arrange({ scope: 'current' }));
check('current operation parks overflow without adding plates', local.placed === 1 && local.unplaced.length === 1 && observe().plates.plates.length === 1, local);
const redistributed = ok('retry parked instance with all plates', await arrange());
check('all operation adds a real plate', redistributed.placed === 2 && observe().plates.plates.length === 2, redistributed);
ok('undo added plate', call('orc_history_undo'));
check('single undo removes added plate and restores parking', observe().plates.plates.length === 1 && observe().plates.instances.filter(i => i.parked).length === 1, observe().plates);
console.log('Arrangement bridge smoke passed');

if (call('orc_get_threading_info').threaded) {
  ok('clear concurrency fixture', call('orc_clear_model'));
  const plateA = observe().plates.current_plate_id;
  ok('add slice A cube', call('orc_add_shape', ['string', 'string'], ['Cube', 'Slice A']));
  ok('add slice B plate', call('orc_add_plate'));
  const plateB = observe().plates.current_plate_id;
  ok('add slice B cube', call('orc_add_shape', ['string', 'string'], ['Cube', 'Slice B']));
  const origins = observe().plates.plates;
  for (const [index, id] of [plateA, plateB].entries()) {
    const origin = origins.find(plate => plate.plate_id === id).origin;
    ok('move concurrency cube off center', call('orc_set_instance_offset', ['number', 'number', 'number', 'number', 'number'],
      [index, 0, origin[0] + 50, origin[1] + 50, 10]));
  }
  ok('recompute concurrency membership', call('orc_recompute_plate_membership'));
  call('orc_history_reset', ['string'], [JSON.stringify(context)]);
  function startSlice(plate) {
    ok('select slice target', call('orc_select_plate', ['string'], [plate]));
    return call('orc_slice_plate', ['string', 'string', 'number'], ['{"layer_height":"0.05"}', plate, observe().plates.input_revisions[plate]]);
  }
  const slicingA = startSlice(plateA);
  check('slice A accepted', slicingA.accepted, slicingA);
  ok('select B while A slices', call('orc_select_plate', ['string'], [plateB]));
  const arrangingB = call('orc_arrange', ['string'], ['{"scope":"current"}']);
  check('arrangement starts while slice active', arrangingB.accepted, arrangingB);
  const rejectedSlice = call('orc_slice_plate', ['string', 'string', 'number'], ['{}', plateB, observe().plates.input_revisions[plateB]]);
  check('new slice blocked while arranging', rejectedSlice.error === 'arrangement_busy', rejectedSlice);
  const resultB = ok('arrange B during slice A', await awaitAsyncTask(call, arrangingB));
  check('only B affected', resultB.plate_session.affected_plate_ids.includes(plateB) && !resultB.plate_session.affected_plate_ids.includes(plateA), resultB);
  ok('unaffected A slice completes', await awaitAsyncTask(call, slicingA));
  // A starts at its original placement, so its first arrangement changes it.
  const affectedSlice = startSlice(plateA);
  check('affected slice accepted', affectedSlice.accepted, affectedSlice);
  const resultA = ok('arrange affected A', await arrange({ scope: 'current' }));
  check('affected A changed', resultA.changed, resultA);
  const obsoleteSlice = await awaitAsyncTask(call, affectedSlice);
  check('affected slice cannot remain authoritative after arrangement commit', obsoleteSlice.ok !== true || !getSliceResult(call, obsoleteSlice.receipt).ok, obsoleteSlice);
  console.log('Arrangement concurrent slicing smoke passed');
}
