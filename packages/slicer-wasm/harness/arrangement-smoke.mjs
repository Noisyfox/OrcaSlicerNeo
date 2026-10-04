// Native arrangement publication, partial-success, rollback and single-step history.
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { awaitAsyncTask, getSliceResult } from './async-task-mailbox.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
const repo = resolve(import.meta.dirname, '../../..');
const testInjection = process.argv[3] === '--test-injection';
if (!process.argv[2] || (process.argv[3] && !testInjection) || process.argv.length > 4)
  throw new Error('Usage: arrangement-smoke.mjs <orca_slice.js> [--test-injection]');
const failureSentinel = 'Injected arrangement apply failure';
const wasm = await readFile(resolve(process.argv[2]).replace(/\.(?:c|m)?js$/, '.wasm'));
check(testInjection ? 'test artifact contains arrangement fault injection' : 'production artifact excludes arrangement fault injection',
  wasm.includes(Buffer.from(failureSentinel)) === testInjection);
if (!testInjection) console.log('arrange SKIP injected rollback checks: production build (use --test-injection with NEO_ARRANGEMENT_TEST=ON)');
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
// Packing scenarios below require a fixed 20 mm cube. UI primitives scale
// with the printer bed and therefore cannot define these fixture dimensions.
const cubeBytes = await readFile(resolve(repo, 'packages/slicer-wasm/fixtures/cube.stl'));
function addFixtureCube(name) {
  const pointer = Number(module._malloc(cubeBytes.length));
  try {
    module.HEAPU8.set(cubeBytes, pointer);
    return call('orc_add_model', ['pointer', 'number', 'string', 'string'], [pointer, cubeBytes.length, 'stl', name]);
  } finally { module._free(pointer); }
}
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
const arrangementRequest = (options = {}) => ({ scope: 'all', distance: 0, rotate: false, align_y: false,
  multiple_materials: true, avoid_calibration: true, context, ...options });
function startArrangement(options = {}) {
  return call('orc_arrange', ['string'], [JSON.stringify(arrangementRequest(options))]);
}
async function arrange(options = {}) {
  const accepted = startArrangement(options);
  return accepted.accepted === true ? await awaitAsyncTask(call, accepted) : accepted;
}
ok('initialize', call('orc_init', ['string'], ['{"log_level":"error"}']));
ok('clear model', call('orc_clear_model'));
for (let i = 0; i < 2; ++i) ok('create cube', addFixtureCube(`Cube ${i + 1}`));
call('orc_history_reset', ['string'], [JSON.stringify(context)]);
let before = observe();
let beforeHistory = history();
for (const field of Object.keys(arrangementRequest())) {
  const request = arrangementRequest();
  delete request[field];
  check(`reject missing arrangement ${field}`, call('orc_arrange', ['string'], [JSON.stringify(request)]).ok === false);
}
for (const [field, value] of [['scope', null], ['distance', '0'], ['rotate', 0], ['align_y', null],
  ['multiple_materials', 'true'], ['avoid_calibration', 1], ['context', null], ['context', {}]]) {
  check(`reject malformed arrangement ${field}`, startArrangement({ [field]: value }).ok === false);
}
check('invalid requests preserve project and history', JSON.stringify(observe()) === JSON.stringify(before) &&
  history().undoEntries.length === beforeHistory.undoEntries.length);
if (call('orc_get_threading_info').threaded) {
  const task = startArrangement();
  check('threaded operation returns acceptance', task.accepted, task);
  check('second arrangement rejected', startArrangement().ok === false);
  check('stale cancellation rejected', call('orc_cancel_arrangement', ['string'], ['0']).ok === false);
  ok('cancel correct task', call('orc_cancel_arrangement', ['string'], [task.task_id]));
  const cancelled = await awaitAsyncTask(call, task);
  check('cancelled task has no changes', cancelled.cancelled && !cancelled.changed, cancelled);
  check('cancelled task has complete diagnostics', cancelled.placed === 0 && Array.isArray(cancelled.unplaced) &&
    cancelled.unplaced.length === 0 && cancelled.plate_limit_reached === false, cancelled);
  check('cancellation preserves transforms, plates, and undo', JSON.stringify(observe()) === JSON.stringify(before) && history().undoEntries.length === beforeHistory.undoEntries.length);
  const stale = startArrangement();
  ok('change input before stale completion', addFixtureCube('Late instance'));
  const changed = observe();
  const rejected = await awaitAsyncTask(call, stale);
  check('obsolete result rejected', !rejected.ok && rejected.error.includes('input changed'), rejected);
  check('obsolete result cannot overwrite input', JSON.stringify(observe()) === JSON.stringify(changed));
  const structure = call('orc_get_model_structure');
  ok('remove stale fixture', call('orc_delete_objects', ['string'], [JSON.stringify([structure.objects.at(-1).id])]));
  before = observe(); beforeHistory = history();
}
if (testInjection) {
  const failed = await arrange({ inject_failure_stage: 'before-publish' });
  check('injected application fails', failed.ok === false && failed.error === failureSentinel, failed);
  check('failed application preserves project', JSON.stringify(observe()) === JSON.stringify(before));
  check('failed application adds no history', history().undoEntries.length === beforeHistory.undoEntries.length);
}
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
const redistributedState = observe();
ok('undo added plate', call('orc_history_undo'));
check('single undo removes added plate and restores parking', observe().plates.plates.length === 1 && observe().plates.instances.filter(i => i.parked).length === 1, observe().plates);
ok('redo added plate', call('orc_history_redo'));
check('redo restores plates and membership', JSON.stringify(observe().plates.plates) === JSON.stringify(redistributedState.plates.plates) &&
  JSON.stringify(observe().plates.instances) === JSON.stringify(redistributedState.plates.instances), observe().plates);
console.log('Arrangement bridge smoke passed');

if (call('orc_get_threading_info').threaded) {
  ok('clear concurrency fixture', call('orc_clear_model'));
  const plateA = observe().plates.current_plate_id;
  ok('add slice A cube', addFixtureCube('Slice A'));
  ok('add slice B plate', call('orc_add_plate'));
  const plateB = observe().plates.current_plate_id;
  ok('add slice B cube', addFixtureCube('Slice B'));
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
  const arrangingB = startArrangement({ scope: 'current' });
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

// Newly created plates need the exact normalized tower coordinates reserved
// during packing, while the existing tower retains its original position.
ok('clear tower fixture', call('orc_clear_model'));
for (const [key, value] of Object.entries({ enable_prime_tower: '1', timelapse_type: '1',
  prime_tower_width: '25', prime_tower_brim_width: '20', wipe_tower_rotation_angle: '0',
  wipe_tower_wall_type: 'rectangle' }))
  ok(`set tower ${key}`, setNativeScopedConfig(call, 'project', undefined, key, value));
for (let i = 0; i < 2; ++i) {
  ok('add tower fixture cube', addFixtureCube(`Tower ${i}`));
  ok('enlarge tower fixture cube', call('orc_set_model_transform',
    ['number', 'number', 'number', 'string', 'string'], [i, 0, 0,
      JSON.stringify({ offset: [100,100,10], rotation: [0,0,0], scale: [9,9,1], mirror: [1,1,1] }),
      JSON.stringify({ offset: [0,0,0], rotation: [0,0,0], scale: [1,1,1], mirror: [1,1,1] })]));
}
ok('recompute tower fixture membership', call('orc_recompute_plate_membership'));
function towerCoordinates() {
  const project = call('orc_get_native_scoped_config').native_scoped_config.snapshot.project;
  return { x: project.wipe_tower_x, y: project.wipe_tower_y };
}
function towerProjection() { return call('orc_get_prime_tower_projection'); }
const originalTower = towerProjection().plates[0];
check('tower fixture has an existing fixed tower', originalTower.eligible && originalTower.outside_boundary_warning, originalTower);
call('orc_history_reset', ['string'], [JSON.stringify(context)]);
const towerBefore = { state: observe(), coordinates: towerCoordinates(), history: history() };
if (testInjection) {
  const towerFailed = await arrange({ inject_failure_stage: 'before-publish' });
  check('estimated tower failure rolls back project and coordinates', !towerFailed.ok && towerFailed.error === failureSentinel &&
    JSON.stringify(observe()) === JSON.stringify(towerBefore.state) &&
    JSON.stringify(towerCoordinates()) === JSON.stringify(towerBefore.coordinates) &&
    history().undoEntries.length === towerBefore.history.undoEntries.length, towerFailed);
}
const towerArranged = ok('arrange estimated towers', await arrange());
check('tower fixture creates second occupied plate', towerArranged.placed === 2 && observe().plates.plates.length === 2, towerArranged);
const towerAfter = { state: observe(), coordinates: towerCoordinates() };
const towersAfter = towerProjection();
check('existing tower keeps its original position', JSON.stringify(towersAfter.plates[0].position) === JSON.stringify(originalTower.position));
check('new tower coordinates match usable reserved positions', towersAfter.plates[1].eligible &&
  !towersAfter.plates[1].outside_boundary_warning && towersAfter.plates[1].position.x > originalTower.position.x, towersAfter);
ok('undo estimated tower arrangement', call('orc_history_undo'));
check('undo restores tower coordinates and plate collection', JSON.stringify(towerCoordinates()) === JSON.stringify(towerBefore.coordinates) &&
  JSON.stringify(observe().plates.plates) === JSON.stringify(towerBefore.state.plates.plates));
ok('redo estimated tower arrangement', call('orc_history_redo'));
check('redo restores tower coordinates and complete membership', JSON.stringify(towerCoordinates()) === JSON.stringify(towerAfter.coordinates) &&
  JSON.stringify(observe().plates.plates) === JSON.stringify(towerAfter.state.plates.plates) &&
  JSON.stringify(observe().plates.instances) === JSON.stringify(towerAfter.state.plates.instances));
const fixedCoordinates = towerCoordinates();
ok('arrange around existing towers', await arrange());
check('existing tower positions stay fixed', JSON.stringify(towerCoordinates()) === JSON.stringify(fixedCoordinates));
console.log('Arrangement estimated tower and history smoke passed');

// Native packing order must never replace source identity, including when an
// unfit polygon retains an itemid reused by a successfully packed polygon.
ok('clear identity regression fixture', call('orc_clear_model'));
for (const [index, size] of [20, 400, 80].entries()) {
  ok('create identity cube', addFixtureCube(`Identity ${size}`));
  ok('resize identity cube', call('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'],
    [index, 0, 0, JSON.stringify({ offset: [50,50,10], rotation: [0,0,0], scale: [size/20,size/20,1], mirror: [1,1,1] }),
      JSON.stringify({ offset: [0,0,0], rotation: [0,0,0], scale: [1,1,1], mirror: [1,1,1] })]));
}
ok('recompute identity membership', call('orc_recompute_plate_membership'));
call('orc_history_reset', ['string'], [JSON.stringify(context)]);
const identityBefore = observe();
const identityObjects = call('orc_get_model_structure').objects;
const identityResult = ok('arrange differently sized instances with rotation', await arrange({ rotate: true }));
check('only oversized source instance is parked', identityResult.placed === 2 && identityResult.unplaced.length === 1 &&
  identityResult.unplaced[0].instance_id === identityObjects[1].instances[0].id && identityResult.unplaced[0].reason === 'unfit', identityResult);
check('identity regression is one undo step', history().undoEntries.length === 1);
const identityAfter = observe();
ok('undo identity arrangement', call('orc_history_undo'));
check('identity undo restores source transforms and membership', JSON.stringify(observe().model) === JSON.stringify(identityBefore.model) &&
  JSON.stringify(observe().plates.instances) === JSON.stringify(identityBefore.plates.instances));
ok('redo identity arrangement', call('orc_history_redo'));
check('identity redo restores correct source assignments', JSON.stringify(observe().model) === JSON.stringify(identityAfter.model) &&
  JSON.stringify(observe().plates.instances) === JSON.stringify(identityAfter.plates.instances));
console.log('Arrangement source identity regression passed');
