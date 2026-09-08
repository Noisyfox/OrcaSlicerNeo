// Real serial-WASM Step 2 command/rollback smoke.
// node harness/multi-filament-command-smoke.mjs --module out/serial/orca_slice.js
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let index = 2; index < argv.length; index += 2) opts[argv[index]?.replace(/^--/, '')] = argv[index + 1];
if (!opts.module) { console.error('usage: node multi-filament-command-smoke.mjs --module out/serial/orca_slice.js'); process.exit(2); }
const repoRoot = resolve(import.meta.dirname, '../../..');
const profileRoot = resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`);
const factory = await loadModuleFactory(resolve(opts.module));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));
function callJson(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  const result = JSON.parse(Module.UTF8ToString(pointer)); Module._free(pointer); return result;
}
function request(name, body) { return callJson(name, ['string'], [JSON.stringify(body)]); }
function initFlexible() {
  const init = callJson('orc_init', ['string'], ['']); assert.equal(init.ok, true, JSON.stringify(init));
  const presets = callJson('orc_get_preset_snapshot');
  const printer = presets.printers.find((entry) => /Bambu Lab P1P 0\.4 nozzle/.test(entry.name)) ?? presets.printers.find((entry) => /Bambu Lab/.test(entry.name));
  assert.ok(printer, 'profile set must expose a Bambu flexible printer');
  const selected = callJson('orc_select_preset', ['string', 'string'], ['printer', printer.name]);
  assert.equal(selected.ok, true, JSON.stringify(selected));
  const snapshot = callJson('orc_get_filament_session_snapshot'); assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.equal(snapshot.capabilities.flexible, true, JSON.stringify(snapshot));
  return snapshot;
}
function add(snapshot) {
  const result = request('orc_add_filament_slot', { version: 1, revision: snapshot.revisions.session });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.result.snapshot;
}
function withSlots(count) {
  let current = initFlexible();
  while (current.slots.length < count) current = add(current);
  return current;
}

// Add uses Orca's deterministic sixteen-colour session sequence, independent
// of the copied preset colour.  Exercise the complete sequence before the
// capacity loop so a preset whose colour differs cannot mask this contract.
const nativeAddColours = [
  '#00C1AE', '#F4E2C1', '#ED1C24', '#00FF7F', '#F26722', '#FFEB31',
  '#7841CE', '#115877', '#ED1E79', '#2EBDEF', '#345B2F', '#800080',
  '#FA8173', '#800000', '#F7B763', '#A4C41E',
];
let snapshot = initFlexible();
for (const expectedColour of nativeAddColours) {
  snapshot = add(snapshot);
  assert.equal(snapshot.slots.at(-1).colour.effective, expectedColour,
    `native add colour sequence at slot ${snapshot.slots.length}`);
}

snapshot = initFlexible();
for (let count = 1; count < 64; count++) snapshot = add(snapshot);
assert.equal(snapshot.slots.length, 64, JSON.stringify(snapshot));
const at64 = request('orc_add_filament_slot', { version: 1, revision: snapshot.revisions.session });
assert.equal(at64.ok, false); assert.equal(at64.error_code, 'capability_rejected');
assert.deepEqual(callJson('orc_get_filament_session_snapshot'), snapshot);

for (const slot of [1, 2, 4]) {
  snapshot = withSlots(4);
  const deleted = request('orc_delete_filament_slot', { version: 1, revision: snapshot.revisions.session, slot });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(deleted.result.snapshot.slots.length, 3);
}
for (const [source, destination] of [[1, 2], [2, 1], [4, 1]]) {
  snapshot = withSlots(4);
  const destinationColour = request('orc_set_filament_slot_colour', {
    version: 1, revision: snapshot.revisions.session, slot: destination, colour: '#AABBCC',
  });
  assert.equal(destinationColour.ok, true, JSON.stringify(destinationColour)); snapshot = destinationColour.result.snapshot;
  const sourceColour = request('orc_set_filament_slot_colour', {
    version: 1, revision: snapshot.revisions.session, slot: source, colour: '#112233',
  });
  assert.equal(sourceColour.ok, true, JSON.stringify(sourceColour)); snapshot = sourceColour.result.snapshot;
  const merge = request('orc_merge_filament_slots', { version: 1, revision: snapshot.revisions.session, source, destination });
  assert.equal(merge.ok, true, JSON.stringify(merge));
  assert.equal(merge.result.snapshot.slots.length, 3);
  const retained = merge.result.snapshot.slots.find((entry) => entry.colour.effective === '#AABBCC');
  assert.ok(retained, `destination colour must survive merge ${source}->${destination}`);
}

snapshot = initFlexible(); snapshot = add(snapshot); snapshot = add(snapshot);
const beforeInjected = JSON.stringify(snapshot);
const injected = request('orc_delete_filament_slot', { version: 1, revision: snapshot.revisions.session, slot: 1, inject_failure: true });
assert.equal(injected.ok, false); assert.equal(injected.error_code, 'native_validation_failure');
assert.equal(JSON.stringify(callJson('orc_get_filament_session_snapshot')), beforeInjected);
const stale = request('orc_delete_filament_slot', { version: 1, revision: snapshot.revisions.session - 1, slot: 1 });
assert.equal(stale.ok, false); assert.equal(stale.error_code, 'stale_revision');
assert.equal(JSON.stringify(callJson('orc_get_filament_session_snapshot')), beforeInjected);

function semantic(snapshot) {
  return JSON.stringify({ slots: snapshot.slots, mappings: snapshot.mappings,
    flushing: snapshot.flushing, assignments: snapshot.assignments });
}
async function assertUndoRedo(label, mutate, prepare = (snapshot) => snapshot) {
  const before = prepare(initFlexible());
  const result = await mutate(before);
  assert.equal(result.ok, true, `${label} mutation: ${JSON.stringify(result)}`);
  const after = result.result.snapshot;
  const undo = callJson('orc_history_undo');
  assert.equal(undo.ok, true, `${label} undo: ${JSON.stringify(undo)}`);
  assert.equal(semantic(callJson('orc_get_filament_session_snapshot')), semantic(before), `${label} undo state`);
  const redo = callJson('orc_history_redo');
  assert.equal(redo.ok, true, `${label} redo: ${JSON.stringify(redo)}`);
  assert.equal(semantic(callJson('orc_get_filament_session_snapshot')), semantic(after), `${label} redo state`);
}
await assertUndoRedo('select-preset', (before) => {
  const presets = callJson('orc_get_preset_snapshot');
  const candidate = presets.filaments.find((entry) => entry.name !== before.slots[0].preset.name);
  assert.ok(candidate, 'select-preset requires a distinct compatible filament');
  return Promise.resolve(request('orc_select_filament_slot_preset', {
    version: 1, revision: before.revisions.session, slot: 1, preset: candidate.name,
  }));
});
await assertUndoRedo('set-colour', (before) => Promise.resolve(request('orc_set_filament_slot_colour', {
  version: 1, revision: before.revisions.session, slot: 1, colour: '#A1B2C3',
})));
await assertUndoRedo('add', (before) => Promise.resolve(request('orc_add_filament_slot', {
  version: 1, revision: before.revisions.session,
})));
await assertUndoRedo('delete', (before) => Promise.resolve(request('orc_delete_filament_slot', {
  version: 1, revision: before.revisions.session, slot: 1,
})), (before) => add(before));
await assertUndoRedo('merge', (before) => Promise.resolve(request('orc_merge_filament_slots', {
  version: 1, revision: before.revisions.session, source: 2, destination: 1,
})), (before) => add(add(before)));

snapshot = withSlots(2);
const lateBefore = JSON.stringify(callJson('orc_get_filament_session_snapshot'));
const latePlatesBefore = JSON.stringify(callJson('orc_get_plate_session_snapshot'));
const lateHistoryBefore = JSON.stringify(callJson('orc_history_status'));
const latePresetBefore = JSON.stringify(callJson('orc_get_preset_snapshot'));
const lateOverlayBefore = JSON.stringify(callJson('orc_get_project_config_overlay'));
const late = request('orc_delete_filament_slot', {
  version: 1, revision: snapshot.revisions.session, slot: 1, inject_failure_stage: 'before-history',
});
assert.equal(late.ok, false); assert.equal(late.error_code, 'native_validation_failure');
assert.equal(JSON.stringify(callJson('orc_get_filament_session_snapshot')), lateBefore);
assert.equal(JSON.stringify(callJson('orc_get_plate_session_snapshot')), latePlatesBefore);
assert.equal(JSON.stringify(callJson('orc_history_status')), lateHistoryBefore);
assert.equal(JSON.stringify(callJson('orc_get_preset_snapshot')), latePresetBefore);
assert.equal(JSON.stringify(callJson('orc_get_project_config_overlay')), lateOverlayBefore);

// The failure seam immediately before the real history commit must preserve
// the same complete boundary, including the history cursor/status.  This is
// intentionally distinct from the earlier validation seam.
snapshot = withSlots(2);
const duringHistoryBefore = JSON.stringify(callJson('orc_get_filament_session_snapshot'));
const duringHistoryPlatesBefore = JSON.stringify(callJson('orc_get_plate_session_snapshot'));
const duringHistoryStatusBefore = JSON.stringify(callJson('orc_history_status'));
const duringHistoryPresetBefore = JSON.stringify(callJson('orc_get_preset_snapshot'));
const duringHistoryOverlayBefore = JSON.stringify(callJson('orc_get_project_config_overlay'));
const duringHistory = request('orc_delete_filament_slot', {
  version: 1, revision: snapshot.revisions.session, slot: 1, inject_failure_stage: 'during-history',
});
assert.equal(duringHistory.ok, false); assert.equal(duringHistory.error_code, 'native_validation_failure');
assert.equal(JSON.stringify(callJson('orc_get_filament_session_snapshot')), duringHistoryBefore);
assert.equal(JSON.stringify(callJson('orc_get_plate_session_snapshot')), duringHistoryPlatesBefore);
assert.equal(JSON.stringify(callJson('orc_history_status')), duringHistoryStatusBefore);
assert.equal(JSON.stringify(callJson('orc_get_preset_snapshot')), duringHistoryPresetBefore);
assert.equal(JSON.stringify(callJson('orc_get_project_config_overlay')), duringHistoryOverlayBefore);

const unsupported = request('orc_delete_filament_slot', {
  version: 1, revision: snapshot.revisions.session, slot: 99,
});
assert.equal(unsupported.ok, false); assert.equal(unsupported.error_code, 'unsupported_reference');

const recalculated = request('orc_add_filament_slot', { version: 1, revision: snapshot.revisions.session });
assert.equal(recalculated.ok, true, JSON.stringify(recalculated));
assert.ok(recalculated.result.snapshot.flushing.matrix.some((value) => value > 0), 'native flush recalculation must produce non-zero off-diagonal values');

// Imported per-plate state follows the native PartPlate add/delete rules:
// per-slot maps resize, first-layer and flattened other-layer sequences
// remove/reindex one-based slots, and custom tool-change events are remapped.
snapshot = withSlots(4);
const fixturePlate = callJson('orc_get_plate_session_snapshot').plates[0].plate_id;
const fixture = callJson('orc_test_set_filament_reference_fixture', ['string'], [JSON.stringify({
  plate_settings: { [fixturePlate]: {
    filament_map: '1,1,1,1', filament_nozzle_map: '0,0,0,0', filament_volume_map: '0,0,0,0',
    first_layer_print_sequence: '1,2,3,4', other_layers_print_sequence: '0,1,1,2,3,4',
    other_layers_print_sequence_nums: '1',
  } },
  custom_gcodes: [{ plate: 0, mode: 'MultiExtruder', items: [{ print_z: 1, extruder: 4 }] }],
})]);
assert.equal(fixture.ok, true, JSON.stringify(fixture));
const plateDelete = request('orc_delete_filament_slot', { version: 1, revision: snapshot.revisions.session, slot: 2 });
assert.equal(plateDelete.ok, true, JSON.stringify(plateDelete));
const afterPlateDelete = callJson('orc_get_plate_session_snapshot');
const deletedSettings = afterPlateDelete.plates[0].settings;
assert.equal(deletedSettings.filament_map, '1,1,1', JSON.stringify(deletedSettings));
assert.equal(deletedSettings.filament_nozzle_map, '0,0,0', JSON.stringify(deletedSettings));
assert.equal(deletedSettings.first_layer_print_sequence, '1,2,3', JSON.stringify(deletedSettings));
assert.equal(deletedSettings.other_layers_print_sequence, '0,1,1,1,2,3', JSON.stringify(deletedSettings));
const customAfterDelete = callJson('orc_test_set_filament_reference_fixture', ['string'], [JSON.stringify({})]);
assert.equal(customAfterDelete.ok, true, JSON.stringify(customAfterDelete));
assert.equal(customAfterDelete.custom_gcodes[0].extruder, 3, JSON.stringify(customAfterDelete));

snapshot = withSlots(4);
const malformedPlate = callJson('orc_get_plate_session_snapshot').plates[0].plate_id;
const malformedSetup = callJson('orc_test_set_filament_reference_fixture', ['string'], [JSON.stringify({
  plate_settings: { [malformedPlate]: { other_layers_print_sequence: '0,1,99', other_layers_print_sequence_nums: '1' } },
})]);
assert.equal(malformedSetup.ok, true, JSON.stringify(malformedSetup));
const malformedBefore = JSON.stringify(callJson('orc_get_plate_session_snapshot'));
const malformed = request('orc_delete_filament_slot', { version: 1, revision: snapshot.revisions.session, slot: 2 });
assert.equal(malformed.ok, false); assert.equal(malformed.error_code, 'unsupported_reference');
assert.equal(JSON.stringify(callJson('orc_get_plate_session_snapshot')), malformedBefore);

snapshot = initFlexible();
const userColour = request('orc_set_filament_slot_colour', { version: 1, revision: snapshot.revisions.session, slot: 1, colour: '#DDAA11' });
assert.equal(userColour.ok, true, JSON.stringify(userColour));
const userPresetSnapshot = userColour.result.snapshot;
const presetChoices = callJson('orc_get_preset_snapshot').filaments;
const alternatePreset = presetChoices.find((entry) => entry.name !== userPresetSnapshot.slots[0].preset.name);
assert.ok(alternatePreset, 'preset retention requires a distinct compatible preset');
const retained = request('orc_select_filament_slot_preset', { version: 1, revision: userPresetSnapshot.revisions.session, slot: 1, preset: alternatePreset.name });
assert.equal(retained.ok, true, JSON.stringify(retained));
assert.equal(retained.result.snapshot.slots[0].colour.effective, '#DDAA11');

snapshot = initFlexible();
const noOverrideBefore = snapshot;
const noOverridePreset = callJson('orc_get_preset_snapshot').filaments.find((entry) => entry.name !== noOverrideBefore.slots[0].preset.name);
assert.ok(noOverridePreset, 'preset recalculation requires a distinct compatible preset');
const noOverride = request('orc_select_filament_slot_preset', { version: 1, revision: snapshot.revisions.session, slot: 1, preset: noOverridePreset.name });
assert.equal(noOverride.ok, true, JSON.stringify(noOverride));
assert.equal(noOverride.result.snapshot.slots[0].colour.provenance, 'preset');

// A normal model history entry must carry the same filament state as a
// filament entry.  Undo/redo across both directions therefore restores the
// complete preset/colour/matrix state even when the ordinary entry was made
// from renderer context that omitted filamentState.
snapshot = initFlexible();
const historyContext = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, projectConfigOverlay: {} };
const ordinaryBegin = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['ordinary model mutation', 'project', JSON.stringify(historyContext), '']);
assert.equal(ordinaryBegin.ok, true, JSON.stringify(ordinaryBegin));
assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', 'ordinary']).ok, true);
const ordinaryCommit = callJson('orc_history_commit', ['string', 'string'],
  [ordinaryBegin.transactionId, JSON.stringify(historyContext)]);
assert.equal(ordinaryCommit.canUndo, true, JSON.stringify(ordinaryCommit));
const ordinaryBeforeFilament = semantic(callJson('orc_get_filament_session_snapshot'));
const ordinaryMutation = request('orc_set_filament_slot_colour', {
  version: 1, revision: callJson('orc_get_filament_session_snapshot').revisions.session, slot: 1, colour: '#123456',
});
assert.equal(ordinaryMutation.ok, true, JSON.stringify(ordinaryMutation));
assert.equal(callJson('orc_history_undo').ok, true);
assert.equal(semantic(callJson('orc_get_filament_session_snapshot')), ordinaryBeforeFilament);
assert.equal(callJson('orc_history_redo').ok, true);
assert.equal(semantic(callJson('orc_get_filament_session_snapshot')), semantic(ordinaryMutation.result.snapshot));

// Real object/part and unrelated filament-valued settings are part of the
// command boundary: deleting slot 1 remaps an object explicitly assigned to
// slot 2, while a numeric material property is not a slot reference and must
// remain byte-for-byte unchanged.
snapshot = withSlots(2);
const addedShape = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Filament reference smoke']);
assert.equal(addedShape.ok, true, JSON.stringify(addedShape));
snapshot = callJson('orc_get_filament_session_snapshot');
const structureBeforeReference = callJson('orc_get_model_structure');
const objectId = structureBeforeReference.objects[0]?.id;
assert.ok(objectId, JSON.stringify(structureBeforeReference));
const assignedObject = callJson('orc_set_project_config_override',
  ['string', 'string', 'string', 'string'], ['object', String(objectId), 'extruder', '2']);
assert.equal(assignedObject.ok, true, JSON.stringify(assignedObject));
const unrelated = callJson('orc_set_project_config_override',
  ['string', 'string', 'string', 'string'], ['project', '', 'filament_flush_temp', '200,210']);
assert.equal(unrelated.ok, true, JSON.stringify(unrelated));
const unrelatedBefore = JSON.stringify(unrelated.overlay.project.filament_flush_temp);
const remapped = request('orc_delete_filament_slot', { version: 1, revision: snapshot.revisions.session, slot: 1 });
assert.equal(remapped.ok, true, JSON.stringify(remapped));
assert.equal(remapped.result.snapshot.assignments.objects[0].explicit_slot, 1,
  JSON.stringify(remapped.result.snapshot.assignments));
const unrelatedAfter = callJson('orc_get_project_config_overlay');
assert.equal(JSON.stringify(unrelatedAfter.overlay.project.filament_flush_temp), unrelatedBefore,
  JSON.stringify(unrelatedAfter));

let fixedSnapshot = null;
const printers = callJson('orc_get_preset_snapshot').printers;
for (const printer of printers) {
  const selected = callJson('orc_select_preset', ['string', 'string'], ['printer', printer.name]);
  if (!selected.ok) continue;
  const candidate = callJson('orc_get_filament_session_snapshot');
  if (candidate.ok && !candidate.capabilities.flexible && candidate.capabilities.nozzle_count > 1) {
    fixedSnapshot = candidate; break;
  }
}
assert.ok(fixedSnapshot, 'profile set must expose a fixed multi-extruder printer');
const fixedAdd = request('orc_add_filament_slot', { version: 1, revision: fixedSnapshot.revisions.session });
assert.equal(fixedAdd.ok, false); assert.equal(fixedAdd.error_code, 'capability_rejected');
// The same fixed multi-nozzle profile still exercises valid native flush
// commands. Every physical nozzle plane is recalculated independently.
const fixedBefore = fixedSnapshot.flushing.matrix.slice();
const fixedColour = request('orc_set_filament_slot_colour', {
  version: 1, revision: fixedSnapshot.revisions.session, slot: 1, colour: '#010203',
});
assert.equal(fixedColour.ok, true, JSON.stringify(fixedColour));
assert.equal(fixedColour.result.snapshot.flushing.plane_count, fixedSnapshot.capabilities.nozzle_count);
assert.equal(fixedColour.result.snapshot.flushing.matrix.length,
  fixedSnapshot.slots.length ** 2 * fixedSnapshot.capabilities.nozzle_count);
for (let plane = 0; plane < fixedSnapshot.capabilities.nozzle_count; plane++) {
  const offset = plane * fixedSnapshot.slots.length ** 2;
  assert.ok(fixedColour.result.snapshot.flushing.matrix.slice(offset, offset + fixedSnapshot.slots.length ** 2)
    .some((value, index) => value !== fixedBefore[offset + index]), `nozzle plane ${plane} must recalculate`);
}
const fixedCount = fixedColour.result.snapshot.slots.length;
const fixedNozzles = fixedColour.result.snapshot.capabilities.nozzle_count;
const flushFixture = callJson('orc_test_set_filament_flush_fixture', ['string'], [JSON.stringify({
  nozzle_volume: Array.from({ length: fixedNozzles }, (_, index) => 100 + index * 100),
  enable_long_retraction_when_cut: 2,
  long_retractions_when_cut: Array.from({ length: fixedNozzles }, (_, index) => index === 0),
  retraction_distances_when_cut: Array.from({ length: fixedNozzles }, (_, index) => 9 + index * 2),
  filament_diameter: Array.from({ length: fixedCount }, () => 1.75),
  filament_long_retractions_when_cut: Array.from({ length: fixedCount }, () => true),
  filament_retraction_distances_when_cut: [null, ...Array.from({ length: Math.max(0, fixedCount - 1) }, () => 7)],
  nozzle_flush_dataset: Array.from({ length: fixedNozzles }, () => 1),
  // The multiplier is consumed downstream by the print pipeline; it must not
  // change the base matrix produced by Orca's auto-calculation.
  flush_multiplier: Array.from({ length: fixedNozzles }, () => 2),
})]);
assert.equal(flushFixture.ok, true, JSON.stringify(flushFixture));
const area = Math.PI * 1.75 * 1.75 / 4;
const expectedMinimums = Array.from({ length: fixedNozzles }, (_, nozzle) =>
  Array.from({ length: fixedCount }, (_, filament) => {
    const retract = nozzle === 0 ? (filament === 0 ? 9 : 7) : (filament === 0 ? 9 + 2 * nozzle : 7);
    return Math.trunc(100 + nozzle * 100 - area * retract);
}));
assert.deepEqual(flushFixture.min_flush_volumes, expectedMinimums,
  'native per-nozzle cutter/retraction minimums must match Orca semantics');
assert.equal(expectedMinimums[0][0], 78,
  'fixture must exercise post-subtraction native truncation (100 - area * 9)');
assert.equal(flushFixture.snapshot.flushing.plane_count, fixedNozzles);
assert.equal(flushFixture.snapshot.flushing.matrix.length, fixedNozzles * fixedCount * fixedCount);
for (let plane = 0; plane < fixedNozzles; plane++) {
  const values = flushFixture.snapshot.flushing.matrix.slice(plane * fixedCount * fixedCount,
    (plane + 1) * fixedCount * fixedCount);
  assert.ok(values.some((value, index) => index % (fixedCount + 1) !== 0 && value >= expectedMinimums[plane][0]),
    `fixture flush plane ${plane} must include its exact minimum-volume floor`);
}
const noMultiplierFixture = callJson('orc_test_set_filament_flush_fixture', ['string'], [JSON.stringify({
  nozzle_volume: Array.from({ length: fixedNozzles }, (_, index) => 100 + index * 100),
  enable_long_retraction_when_cut: 2,
  long_retractions_when_cut: Array.from({ length: fixedNozzles }, (_, index) => index === 0),
  retraction_distances_when_cut: Array.from({ length: fixedNozzles }, (_, index) => 9 + index * 2),
  filament_diameter: Array.from({ length: fixedCount }, () => 1.75),
  filament_long_retractions_when_cut: Array.from({ length: fixedCount }, () => true),
  filament_retraction_distances_when_cut: [null, ...Array.from({ length: Math.max(0, fixedCount - 1) }, () => 7)],
  nozzle_flush_dataset: Array.from({ length: fixedNozzles }, () => 1),
  flush_multiplier: Array.from({ length: fixedNozzles }, () => 1),
})]);
assert.equal(noMultiplierFixture.ok, true, JSON.stringify(noMultiplierFixture));
assert.deepEqual(noMultiplierFixture.snapshot.flushing.matrix, flushFixture.snapshot.flushing.matrix,
  'flush multiplier must not alter the recalculated base matrix');
assert.deepEqual(noMultiplierFixture.min_flush_volumes, flushFixture.min_flush_volumes,
  'flush multiplier must not alter native minimum-volume inputs');
console.log('multi-filament atomic command smoke passed (capacity, remap, rollback, flush, retention, fixed capability, and all five undo/redo command families)');
