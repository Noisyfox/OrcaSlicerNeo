// Native arrangement publication, partial-success, rollback and single-step history.
import { resolve } from 'node:path';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { awaitAsyncTask } from './async-task-mailbox.mjs';
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
const before = observe();
const beforeHistory = history();
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
