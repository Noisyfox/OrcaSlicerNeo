// Real serial-WASM Step 5 smoke.
// node multi-filament-flushing-prime-tower-smoke.mjs --module out/serial/orca_slice.js
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let i = 2; i < argv.length; i += 2) opts[argv[i]?.replace(/^--/, '')] = argv[i + 1];
if (!opts.module) throw new Error('usage: node multi-filament-flushing-prime-tower-smoke.mjs --module out/serial/orca_slice.js');
const repoRoot = resolve(import.meta.dirname, '../../..');
const factory = await loadModuleFactory(resolve(opts.module));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`)));
const startedAt = performance.now();
const stageTimes = [];
function markStage(name) {
  const elapsedMs = Math.round(performance.now() - startedAt);
  stageTimes.push({ name, elapsedMs });
  if (process.env.ORCA_HARNESS_TIMING === '1') console.error(`flushing smoke ${name}: ${elapsedMs}ms`);
}
function callJson(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const result = JSON.parse(Module.UTF8ToString(ptr)); Module._free(ptr); return result;
}
function request(name, body) { return callJson(name, ['string'], [JSON.stringify(body)]); }
function writeBytes(bytes) {
  const ptr = Module._malloc(bytes.length); Module.HEAPU8.set(bytes, ptr); return ptr;
}
function readBytes(ptr, length) {
  const bytes = Module.HEAPU8.slice(ptr, ptr + length); Module._free(ptr); return bytes;
}
function importedMatrix(count, base) {
  return Array.from({ length: count * count }, (_, index) => index % (count + 1) === 0 ? 0 : base + index);
}
function installImportedMatrix(count, base) {
  const matrix = importedMatrix(count, base);
  const fixture = callJson('orc_test_set_filament_flush_fixture', ['string'], [JSON.stringify({ imported_matrix: matrix })]);
  assert.equal(fixture.ok, true, JSON.stringify(fixture));
  assert.equal(fixture.snapshot.flushing.source, 'native');
  assert.deepEqual(fixture.snapshot.flushing.matrix, matrix);
  return fixture.snapshot;
}
function assertReplaced(beforeMatrix, afterSnapshot, expectedCount) {
  assert.notDeepEqual(afterSnapshot.flushing.matrix, beforeMatrix, 'accepted flushing edit replaces the imported matrix');
  assert.equal(afterSnapshot.flushing.matrix.length, expectedCount ** 2 * afterSnapshot.flushing.plane_count);
}
const init = callJson('orc_init', ['string'], ['']); assert.equal(init.ok, true, JSON.stringify(init));
const presets = callJson('orc_get_preset_snapshot');
const printer = presets.printers.find((p) => /Bambu Lab P1P 0\.4 nozzle/.test(p.name)) ?? presets.printers.find((p) => /Bambu Lab/.test(p.name));
assert.ok(printer, 'flexible printer profile is required');
assert.equal(callJson('orc_select_preset', ['string', 'string'], ['printer', printer.name]).ok, true);
let snapshot = callJson('orc_get_filament_session_snapshot');
let add = request('orc_add_filament_slot', { version: 1, revision: snapshot.revisions.session });
assert.equal(add.ok, true, JSON.stringify(add)); snapshot = add.result.snapshot;
const importedSnapshot = installImportedMatrix(2, 110);

// Prove the production project-load path, rather than only the test fixture:
// export the native matrix into a BBS 3MF, clear the session, and reload it.
assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', 'flush roundtrip']).ok, true);
const exported = callJson('orc_export_project');
assert.equal(exported.ok, true, JSON.stringify(exported));
const exportedBytes = readBytes(exported.bytes_ptr, exported.bytes_length);
assert.equal(callJson('orc_clear_model').ok, true);
const loadPtr = writeBytes(exportedBytes);
const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'], [loadPtr, exportedBytes.length, 0, 'flush-roundtrip.3mf']);
Module._free(loadPtr);
assert.equal(loaded.ok, true, JSON.stringify(loaded));
snapshot = callJson('orc_get_filament_session_snapshot');
assert.deepEqual(snapshot.flushing.matrix, importedSnapshot.flushing.matrix, 'production project load preserves imported matrix exactly');
assert.equal(snapshot.flushing.source, 'native');
markStage('profile-init-and-project-roundtrip');

// Every accepted flushing-input class must replace a complete imported matrix.
const alternatePreset = callJson('orc_get_preset_snapshot').filament_catalog.find((entry) => entry.name !== snapshot.slots[0].preset.name);
assert.ok(alternatePreset, 'a second compatible filament preset is required');
let before = installImportedMatrix(2, 210);
let changed = request('orc_select_filament_slot_preset', { version: 1, revision: before.revisions.session, slot: 1, preset: alternatePreset.name });
assert.equal(changed.ok, true, JSON.stringify(changed)); assertReplaced(before.flushing.matrix, changed.result.snapshot, 2); snapshot = changed.result.snapshot;
before = installImportedMatrix(2, 310);
changed = request('orc_set_filament_slot_colour', { version: 1, revision: before.revisions.session, slot: 2, colour: '#123456' });
assert.equal(changed.ok, true, JSON.stringify(changed)); assertReplaced(before.flushing.matrix, changed.result.snapshot, 2); snapshot = changed.result.snapshot;
before = installImportedMatrix(2, 410);
changed = request('orc_add_filament_slot', { version: 1, revision: before.revisions.session });
assert.equal(changed.ok, true, JSON.stringify(changed)); assertReplaced(before.flushing.matrix, changed.result.snapshot, 3); snapshot = changed.result.snapshot;
before = installImportedMatrix(3, 510);
changed = request('orc_delete_filament_slot', { version: 1, revision: before.revisions.session, slot: 2 });
assert.equal(changed.ok, true, JSON.stringify(changed)); assertReplaced(before.flushing.matrix, changed.result.snapshot, 2); snapshot = changed.result.snapshot;
before = installImportedMatrix(2, 610);
changed = request('orc_add_filament_slot', { version: 1, revision: before.revisions.session });
assert.equal(changed.ok, true, JSON.stringify(changed)); snapshot = changed.result.snapshot;
before = installImportedMatrix(3, 710);
changed = request('orc_merge_filament_slots', { version: 1, revision: before.revisions.session, source: 3, destination: 1 });
assert.equal(changed.ok, true, JSON.stringify(changed)); assertReplaced(before.flushing.matrix, changed.result.snapshot, 2); snapshot = changed.result.snapshot;

// Support routing is a flushing input.  It must publish a complete native
// matrix in the same atomic response, replacing the imported matrix.
before = installImportedMatrix(2, 810);
const support = request('orc_set_filament_routing', {
  version: 1, revision: before.revisions.session, selector: 'support-base', slot: 2,
  targets: [{ kind: 'project', id: 0 }],
});
assert.equal(support.ok, true, JSON.stringify(support));
assertReplaced(before.flushing.matrix, support.result.snapshot, 2);
assert.equal(support.result.snapshot.routing.find((r) => r.target === 'project' && r.selector === 'support-base').explicit_slot, 2);
snapshot = support.result.snapshot;

before = installImportedMatrix(2, 810);
const interfaceRoute = request('orc_set_filament_routing', {
  version: 1, revision: before.revisions.session, selector: 'support-interface', slot: 2,
  targets: [{ kind: 'project', id: 0 }],
});
assert.equal(interfaceRoute.ok, true, JSON.stringify(interfaceRoute));
assertReplaced(before.flushing.matrix, interfaceRoute.result.snapshot, 2);
snapshot = interfaceRoute.result.snapshot;
markStage('native-flush-input-recalculation');

// An injected native rejection must preserve the complete matrix and session.
const rejectedBefore = installImportedMatrix(2, 910);
const rejected = request('orc_set_filament_slot_colour', { version: 1, revision: rejectedBefore.revisions.session,
  slot: 1, colour: '#ABCDEF', inject_failure: true });
assert.equal(rejected.ok, false, JSON.stringify(rejected));
assert.deepEqual(callJson('orc_get_filament_session_snapshot').flushing.matrix, rejectedBefore.flushing.matrix);

// Prime-tower enable/width are shared process settings and invalidate every
// plate; they never become implicitly enabled because slot count is two.
let plates = callJson('orc_get_plate_session_snapshot');
const addPlate = callJson('orc_add_plate'); assert.equal(addPlate.ok, true, JSON.stringify(addPlate));
plates = callJson('orc_get_plate_session_snapshot');
const plateIds = plates.plates.map((p) => p.plate_id);
let result = callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'],
  ['project', '', 'enable_prime_tower', '0']);
assert.equal(result.ok, true, JSON.stringify(result));
assert.deepEqual(result.plate_session.affected_plate_ids, plateIds);
assert.equal(result.configuration_status.state, 'ready');
assert.equal(result.overlay.project.enable_prime_tower, '0');
result = callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'],
  ['project', '', 'prime_tower_width', '25']);
assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.configuration_status.state, 'ready');

// X/Y are per-plate and revise only the selected plate.  The native parser's
// status is returned through the same configuration command response.
const beforePlate = callJson('orc_get_plate_session_snapshot');
const targetPlate = plateIds[1];
result = callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'],
  ['plate', targetPlate, 'wipe_tower_x', '10']);
assert.equal(result.ok, true, JSON.stringify(result));
assert.deepEqual(result.plate_session.affected_plate_ids, [targetPlate]);
assert.equal(result.plate_session.input_revisions[plateIds[0]], beforePlate.input_revisions[plateIds[0]]);
assert.equal(result.plate_session.input_revisions[targetPlate], beforePlate.input_revisions[targetPlate] + 1);
result = callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'],
  ['plate', targetPlate, 'wipe_tower_y', '12']);
assert.equal(result.ok, true, JSON.stringify(result));
assert.deepEqual(result.plate_session.affected_plate_ids, [targetPlate]);
const corrected = callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'],
  ['plate', targetPlate, 'wipe_tower_x', 'not-a-number']);
assert.equal(corrected.ok, true, JSON.stringify(corrected));
assert.equal(corrected.configuration_status.state, 'ready');
assert.deepEqual(corrected.configuration_status.corrections, [
  { key: 'wipe_tower_x', requested: 'not-a-number', effective: '0' },
]);
const rejectedConfigBefore = callJson('orc_get_project_config_overlay');
const rejectedPlateBefore = callJson('orc_get_plate_session_snapshot');
const rejectedHistoryBefore = callJson('orc_history_status');
const rejectedConfig = callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'],
  ['plate', targetPlate, 'enable_prime_tower', '1']);
assert.equal(rejectedConfig.ok, false, JSON.stringify(rejectedConfig));
assert.deepEqual(callJson('orc_get_project_config_overlay'), rejectedConfigBefore, 'rejected native scope leaves overlay unchanged');
assert.deepEqual(callJson('orc_get_plate_session_snapshot').input_revisions, rejectedPlateBefore.input_revisions,
  'rejected native scope leaves plate revisions unchanged');
assert.deepEqual(callJson('orc_history_status'), rejectedHistoryBefore, 'rejected native scope leaves history unchanged');
markStage('prime-tower-config-and-history');

// Delete without a merge destination maps an explicit support reference to
// Default; other references above the deleted slot decrement exactly once.
snapshot = callJson('orc_get_filament_session_snapshot');
const threeSlot = request('orc_add_filament_slot', { version: 1, revision: snapshot.revisions.session });
assert.equal(threeSlot.ok, true, JSON.stringify(threeSlot)); snapshot = threeSlot.result.snapshot;
let projectSupport = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session,
  selector: 'support-base', slot: 2, targets: [{ kind: 'project', id: 0 }] });
assert.equal(projectSupport.ok, true, JSON.stringify(projectSupport)); snapshot = projectSupport.result.snapshot;
let projectInterface = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session,
  selector: 'support-interface', slot: 3, targets: [{ kind: 'project', id: 0 }] });
assert.equal(projectInterface.ok, true, JSON.stringify(projectInterface)); snapshot = projectInterface.result.snapshot;
const structure = callJson('orc_get_model_structure');
const objectId = structure.objects?.[0]?.id;
assert.ok(objectId, 'round-trip object is required for object-scoped routing');
const allFeatureSelectors = ['outer-wall', 'inner-wall', 'sparse-infill', 'internal-solid-infill', 'top-surface', 'bottom-surface'];
for (const selector of allFeatureSelectors) {
  const route = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session, selector, slot: 3,
    targets: [{ kind: 'object', id: objectId }] });
  assert.equal(route.ok, true, JSON.stringify(route)); snapshot = route.result.snapshot;
}
const objectSupport = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session,
  selector: 'support-base', slot: 2, targets: [{ kind: 'object', id: objectId }] });
assert.equal(objectSupport.ok, true, JSON.stringify(objectSupport)); snapshot = objectSupport.result.snapshot;
const deleted = request('orc_delete_filament_slot', { version: 1, revision: snapshot.revisions.session, slot: 2 });
assert.equal(deleted.ok, true, JSON.stringify(deleted));
const deletedRoute = deleted.result.snapshot.routing.find((r) => r.target === 'project' && r.selector === 'support-base');
assert.equal(deletedRoute.explicit_slot, 0, 'delete maps support route to Default');
const deletedInterface = deleted.result.snapshot.routing.find((r) => r.target === 'project' && r.selector === 'support-interface');
assert.equal(deletedInterface.explicit_slot, 2, 'delete decrements project route above source exactly once');
for (const selector of allFeatureSelectors) {
  const route = deleted.result.snapshot.routing.find((r) => r.target === 'object' && r.id === objectId && r.selector === selector);
  assert.equal(route?.explicit_slot, 2, `${selector} decrements exactly once`);
}
const deletedObjectSupport = deleted.result.snapshot.routing.find((r) => r.target === 'object' && r.id === objectId && r.selector === 'support-base');
assert.equal(deletedObjectSupport?.explicit_slot, 0, 'delete maps object support route to Default');
snapshot = deleted.result.snapshot;
const addedAgain = request('orc_add_filament_slot', { version: 1, revision: snapshot.revisions.session });
assert.equal(addedAgain.ok, true, JSON.stringify(addedAgain)); snapshot = addedAgain.result.snapshot;
const routeAgain = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session,
  selector: 'support-base', slot: 3, targets: [{ kind: 'project', id: 0 }] });
assert.equal(routeAgain.ok, true, JSON.stringify(routeAgain)); snapshot = routeAgain.result.snapshot;
for (const selector of allFeatureSelectors) {
  const route = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session, selector, slot: 3,
    targets: [{ kind: 'object', id: objectId }] });
  assert.equal(route.ok, true, JSON.stringify(route)); snapshot = route.result.snapshot;
}
const merged = request('orc_merge_filament_slots', { version: 1, revision: snapshot.revisions.session, source: 3, destination: 1 });
assert.equal(merged.ok, true, JSON.stringify(merged));
const mergedRoute = merged.result.snapshot.routing.find((r) => r.target === 'project' && r.selector === 'support-base');
assert.equal(mergedRoute.explicit_slot, 1, 'merge remaps support route to selected survivor');
for (const selector of allFeatureSelectors) {
  const route = merged.result.snapshot.routing.find((r) => r.target === 'object' && r.id === objectId && r.selector === selector);
  assert.equal(route?.explicit_slot, 1, `${selector} merge maps to selected survivor`);
}
markStage('routing-remap');

if (process.env.ORCA_HARNESS_TIMING === '1') console.error(JSON.stringify({ flushingSmokeDurationMs: Math.round(performance.now() - startedAt), stageTimes }));
console.log('multi-filament flushing/prime-tower smoke passed (import preservation, native recalc, support Default/remap, prime tower status and plate-local invalidation)');
