// Real serial-WASM Step 2 command/rollback smoke.
// node harness/multi-filament-command-smoke.mjs --module out/serial/orca_slice.js
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { metadataEntry } from './native-3mf-parser.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let index = 2; index < argv.length; index += 2) opts[argv[index]?.replace(/^--/, '')] = argv[index + 1];
if (!opts.module) { console.error('usage: node multi-filament-command-smoke.mjs --module out/serial/orca_slice.js'); process.exit(2); }
const repoRoot = resolve(import.meta.dirname, '../../..');
const profileRoot = resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`);
const factory = await loadModuleFactory(resolve(opts.module));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));
const startedAt = performance.now();
const stageTimes = [];
let flexibleFilamentNames = [];
const historyLatencies = [];
// Warmed slot history is a large multi-colour regression guard. Keep this
// deliberately local to the real bridge smoke rather than relying on logs.
const FILAMENT_HISTORY_LATENCY_BUDGET_MS = 100;
function markStage(name) {
  const stage = { name, elapsedMs: Math.round(performance.now() - startedAt) };
  stageTimes.push(stage);
  console.error(`multi-filament-command-smoke stage ${stage.name}: ${stage.elapsedMs}ms`);
}
function callJson(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  const result = JSON.parse(Module.UTF8ToString(pointer)); Module._free(pointer); return result;
}
const historyMutationCommands = new Set([
  'orc_select_filament_slot_preset', 'orc_set_filament_slot_colour',
  'orc_add_filament_slot', 'orc_delete_filament_slot', 'orc_merge_filament_slots',
  'orc_assign_filament', 'orc_set_filament_routing',
]);
function request(name, body) {
  const result = callJson(name, ['string'], [JSON.stringify(body)]);
  if (result.ok && historyMutationCommands.has(name)) {
    const receipt = result.result?.history_status;
    assert.ok(receipt, `${name} must return post-commit history status in its mutation receipt`);
    assert.equal(receipt.revision, result.result.mutation.revision_after, JSON.stringify(result));
    assert.equal(receipt.dirty, result.result.mutation.dirty, JSON.stringify(result));
    // The receipt is the UI source of truth. The direct native read is used
    // here only to prove it was captured after the same commit, not as a
    // renderer fallback.
    assert.deepEqual(receipt, callJson('orc_history_status'), JSON.stringify(result));
  }
  return result;
}
function readBytes(pointer, length) {
  const bytes = Module.HEAPU8.slice(Number(pointer), Number(pointer) + Number(length));
  Module._free(Number(pointer));
  return bytes;
}
function initFlexible() {
  const init = callJson('orc_init', ['string'], ['']); assert.equal(init.ok, true, JSON.stringify(init));
  const presets = callJson('orc_get_preset_snapshot');
  const printer = presets.printers.find((entry) => /Bambu Lab P1P 0\.4 nozzle/.test(entry.name)) ?? presets.printers.find((entry) => /Bambu Lab/.test(entry.name));
  assert.ok(printer, 'profile set must expose a Bambu flexible printer');
  const selected = callJson('orc_select_preset', ['string', 'string'], ['printer', printer.name]);
  assert.equal(selected.ok, true, JSON.stringify(selected));
  const snapshot = callJson('orc_get_filament_session_snapshot'); assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.equal(snapshot.capabilities.flexible, true, JSON.stringify(snapshot));
  // Build the compatible alternate-preset inventory once. Fetching the full
  // profile catalogue is intentionally expensive; the command checks below
  // use this immutable list rather than repeatedly serialising it.
  flexibleFilamentNames = callJson('orc_get_preset_snapshot').filament_catalog.map((entry) => entry.name);
  assert.ok(flexibleFilamentNames.some((name) => name !== snapshot.slots[0].preset.name),
    'profile set must expose a distinct compatible filament');
  return snapshot;
}
function alternateFilament(currentName) {
  const candidate = flexibleFilamentNames.find((name) => name !== currentName);
  assert.ok(candidate, 'select-preset requires a distinct compatible filament');
  return candidate;
}
function stableState(value) {
  if (Array.isArray(value)) return value.map(stableState);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      // Revision tokens are deliberately monotonic, including when an undo
      // restores the complete session. They are concurrency guards, not
      // project state, and therefore cannot be compared to a baseline.
      .filter(([key]) => key !== 'revision' && key !== 'revisions' && key !== 'history_revision')
      .map(([key, entry]) => [stableState(key), stableState(entry)]));
  }
  if (typeof value === 'string')
    return value.replace(/plate-session-\d+-plate-\d+/g, 'plate-session-<fresh>-plate-<fresh>');
  return value;
}
function scenarioState() {
  return stableState({
    session: callJson('orc_get_filament_session_snapshot'),
    plates: callJson('orc_get_plate_session_snapshot'),
    nativeScopedConfig: callJson('orc_get_native_scoped_config'),
    model: callJson('orc_get_model_structure'),
  });
}
let baselineState = null;
let baselineProject = null;
function loadProject(bytes, displayName) {
  const pointer = Number(Module._malloc(bytes.byteLength));
  Module.HEAPU8.set(bytes, pointer);
  const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [pointer, bytes.byteLength, 0, displayName]);
  Module._free(pointer);
  return loaded;
}
function establishFlexibleBaseline() {
  initFlexible();
  const exported = callJson('orc_export_project');
  assert.equal(exported.ok, true, JSON.stringify(exported));
  baselineProject = readBytes(exported.bytes_ptr, exported.bytes_length);
  // Export/import is the authoritative project boundary. Native plate
  // coordinate arrays are normalized to the current plate count there, so
  // establish the comparison state after that boundary rather than retaining
  // the pre-export in-memory representation.
  const loaded = loadProject(baselineProject, 'command-smoke-baseline.3mf');
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  baselineState = scenarioState();
  return callJson('orc_get_filament_session_snapshot');
}
function resetFlexibleScenario() {
  // orc_init rebuilds the complete profile bundle (~10 s on this machine).
  // Reloading this independently exported empty project is the real project
  // reader/writer path, restores every project-owned state surface, and is
  // about six times faster. This is deliberately not a mock/reset seam.
  const loaded = loadProject(baselineProject, 'command-smoke-baseline.3mf');
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.deepEqual(scenarioState(), baselineState,
    'scenario reset must restore every non-revision session, plate, preset, native scoped config, and model value');
  return callJson('orc_get_filament_session_snapshot');
}
function add(snapshot) {
  const result = request('orc_add_filament_slot', { version: 1, revision: snapshot.revisions.session });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.result.snapshot;
}
function withSlots(count) {
  let current = callJson('orc_get_filament_session_snapshot');
  while (current.slots.length > count) {
    const removed = request('orc_delete_filament_slot', {
      version: 1, revision: current.revisions.session, slot: current.slots.length,
    });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    current = removed.result.snapshot;
  }
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
let snapshot = establishFlexibleBaseline();
const noOverrideBefore = snapshot;
const noOverride = request('orc_select_filament_slot_preset', {
  version: 1, revision: snapshot.revisions.session, slot: 1,
  preset: alternateFilament(noOverrideBefore.slots[0].preset.name),
});
assert.equal(noOverride.ok, true, JSON.stringify(noOverride));
assert.equal(noOverride.result.snapshot.slots[0].colour.provenance, 'preset');
snapshot = noOverride.result.snapshot;

function assertCapacityRoundTrip() {
  let capacitySnapshot = callJson('orc_get_filament_session_snapshot');
  while (capacitySnapshot.slots.length < 64) {
    capacitySnapshot = add(capacitySnapshot);
    const colourIndex = capacitySnapshot.slots.length - 2;
    if (colourIndex < nativeAddColours.length) {
      assert.equal(capacitySnapshot.slots.at(-1).colour.effective, nativeAddColours[colourIndex],
        `native add colour sequence at slot ${capacitySnapshot.slots.length}`);
    }
  }
assert.equal(capacitySnapshot.slots.length, 64, JSON.stringify(capacitySnapshot));
const at64 = request('orc_add_filament_slot', { version: 1, revision: capacitySnapshot.revisions.session });
assert.equal(at64.ok, false); assert.equal(at64.error_code, 'capability_rejected');
assert.deepEqual(callJson('orc_get_filament_session_snapshot'), capacitySnapshot);

// Capacity is also a persistence boundary: the complete 64-slot session and
// its 64x64 native matrix must survive the real BBS 3MF writer and reader,
// rather than only living in the in-memory command state.
const exported64 = callJson('orc_export_project');
assert.equal(exported64.ok, true, JSON.stringify(exported64));
const project64 = readBytes(exported64.bytes_ptr, exported64.bytes_length);
const sidecar64 = metadataEntry(project64, 'Metadata/orca_neo_filament_state_v1.json');
assert.ok(sidecar64?.state?.filament_presets, '64-slot project must carry the Neo filament sidecar');
assert.equal(Object.hasOwn(sidecar64.state, 'project_config'), false,
  'filament sidecar must not mirror native Project config');
assert.equal(Object.hasOwn(sidecar64.state, 'selected_filament_preset'), false,
  'multi-filament sidecar must not serialize a single selected filament');
const reloaded64 = loadProject(project64, 'capacity-64-roundtrip.3mf');
assert.equal(reloaded64.ok, true, JSON.stringify(reloaded64));
const session64 = callJson('orc_get_filament_session_snapshot');
assert.equal(session64.slots.length, 64, JSON.stringify(session64));
assert.equal(session64.flushing.matrix.length, 4096, JSON.stringify(session64.flushing));
assert.equal(session64.flushing.plane_count, session64.capabilities.nozzle_count);
assert.deepEqual(session64.slots.map((entry) => entry.slot), Array.from({ length: 64 }, (_, index) => index + 1));
}

assertCapacityRoundTrip();
markStage('capacity-and-add-colour-sequence');
snapshot = resetFlexibleScenario();
snapshot = withSlots(4);
const fourSlotFingerprint = (value) => JSON.stringify({ slots: value.slots, mappings: value.mappings,
  flushing: value.flushing, assignments: value.assignments });
const fourSlotBaseline = snapshot;
for (const slot of [1, 2, 4]) {
  const deleted = request('orc_delete_filament_slot', { version: 1, revision: snapshot.revisions.session, slot });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(deleted.result.snapshot.slots.length, 3);
  const undo = callJson('orc_history_undo');
  assert.equal(undo.ok, true, JSON.stringify(undo));
  snapshot = callJson('orc_get_filament_session_snapshot');
  assert.equal(fourSlotFingerprint(snapshot), fourSlotFingerprint(fourSlotBaseline), `delete ${slot} undo must restore the shared four-slot baseline`);
}
for (const [source, destination] of [[1, 2], [2, 1], [4, 1]]) {
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
  assert.equal(callJson('orc_history_undo').ok, true, `merge ${source}->${destination} undo`);
  snapshot = callJson('orc_get_filament_session_snapshot');
  assert.equal(fourSlotFingerprint(snapshot), fourSlotFingerprint(sourceColour.result.snapshot),
    `merge ${source}->${destination} undo must preserve the staged source colour`);
  assert.equal(callJson('orc_history_undo').ok, true, `source colour ${source} undo`);
  snapshot = callJson('orc_get_filament_session_snapshot');
  assert.equal(fourSlotFingerprint(snapshot), fourSlotFingerprint(destinationColour.result.snapshot),
    `source colour ${source} undo must preserve destination colour`);
  assert.equal(callJson('orc_history_undo').ok, true, `destination colour ${destination} undo`);
  snapshot = callJson('orc_get_filament_session_snapshot');
  assert.equal(fourSlotFingerprint(snapshot), fourSlotFingerprint(fourSlotBaseline),
    `merge ${source}->${destination} cleanup must restore four-slot baseline`);
}
markStage('delete-merge-remap');

snapshot = withSlots(3);
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
const historyDiagnosticsBeforeUndoRedo = callJson('orc_history_restore_diagnostics');
async function assertUndoRedo(label, mutate, prepare = (snapshot) => snapshot) {
  const before = prepare(callJson('orc_get_filament_session_snapshot'));
  const result = await mutate(before);
  assert.equal(result.ok, true, `${label} mutation: ${JSON.stringify(result)}`);
  const after = result.result.snapshot;
  const undoStarted = performance.now();
  const undo = callJson('orc_history_undo');
  historyLatencies.push({ label, operation: 'undo', durationMs: performance.now() - undoStarted });
  assert.equal(undo.ok, true, `${label} undo: ${JSON.stringify(undo)}`);
  assert.equal(semantic(callJson('orc_get_filament_session_snapshot')), semantic(before), `${label} undo state`);
  const redoStarted = performance.now();
  const redo = callJson('orc_history_redo');
  historyLatencies.push({ label, operation: 'redo', durationMs: performance.now() - redoStarted });
  assert.equal(redo.ok, true, `${label} redo: ${JSON.stringify(redo)}`);
  assert.equal(semantic(callJson('orc_get_filament_session_snapshot')), semantic(after), `${label} redo state`);
}
await assertUndoRedo('select-preset', (before) => {
  return Promise.resolve(request('orc_select_filament_slot_preset', {
    version: 1, revision: before.revisions.session, slot: 1, preset: alternateFilament(before.slots[0].preset.name),
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
const slotHistoryLatencies = historyLatencies.filter((sample) => sample.label === 'add' || sample.label === 'delete');
assert.equal(slotHistoryLatencies.length, 4, JSON.stringify(historyLatencies));
for (const sample of slotHistoryLatencies) {
  assert.ok(sample.durationMs < FILAMENT_HISTORY_LATENCY_BUDGET_MS,
    `warmed ${sample.label} ${sample.operation} must finish below ${FILAMENT_HISTORY_LATENCY_BUDGET_MS}ms, got ${sample.durationMs.toFixed(1)}ms`);
}
const minimalHistoryDiagnostics = callJson('orc_history_restore_diagnostics');
assert.equal(minimalHistoryDiagnostics.fullPresetBundleCopyCount,
  historyDiagnosticsBeforeUndoRedo.fullPresetBundleCopyCount,
  `history undo/redo must not copy PresetBundle: ${JSON.stringify(minimalHistoryDiagnostics)}`);
assert.ok(minimalHistoryDiagnostics.minimalMutableRestoreCount -
    historyDiagnosticsBeforeUndoRedo.minimalMutableRestoreCount >= slotHistoryLatencies.length,
  `each warmed slot Undo/Redo must use the minimal mutable restore path: ${JSON.stringify(minimalHistoryDiagnostics)}`);
markStage('rollback-and-history');

snapshot = withSlots(2);
const lateBefore = JSON.stringify(callJson('orc_get_filament_session_snapshot'));
const latePlatesBefore = JSON.stringify(callJson('orc_get_plate_session_snapshot'));
const lateHistoryBefore = JSON.stringify(callJson('orc_history_status'));
const latePresetBefore = JSON.stringify(callJson('orc_get_preset_snapshot'));
const lateSnapshotBefore = JSON.stringify(callJson('orc_get_native_scoped_config'));
const late = request('orc_delete_filament_slot', {
  version: 1, revision: snapshot.revisions.session, slot: 1, inject_failure_stage: 'before-history',
});
assert.equal(late.ok, false); assert.equal(late.error_code, 'native_validation_failure');
assert.equal(JSON.stringify(callJson('orc_get_filament_session_snapshot')), lateBefore);
assert.equal(JSON.stringify(callJson('orc_get_plate_session_snapshot')), latePlatesBefore);
assert.equal(JSON.stringify(callJson('orc_history_status')), lateHistoryBefore);
assert.equal(JSON.stringify(callJson('orc_get_preset_snapshot')), latePresetBefore);
assert.equal(JSON.stringify(callJson('orc_get_native_scoped_config')), lateSnapshotBefore);

// The failure seam immediately before the real history commit must preserve
// the same complete boundary, including the history cursor/status.  This is
// intentionally distinct from the earlier validation seam.
snapshot = withSlots(2);
const duringHistoryBefore = JSON.stringify(callJson('orc_get_filament_session_snapshot'));
const duringHistoryPlatesBefore = JSON.stringify(callJson('orc_get_plate_session_snapshot'));
const duringHistoryStatusBefore = JSON.stringify(callJson('orc_history_status'));
const duringHistoryPresetBefore = JSON.stringify(callJson('orc_get_preset_snapshot'));
const duringHistorySnapshotBefore = JSON.stringify(callJson('orc_get_native_scoped_config'));
const duringHistory = request('orc_delete_filament_slot', {
  version: 1, revision: snapshot.revisions.session, slot: 1, inject_failure_stage: 'during-history',
});
assert.equal(duringHistory.ok, false); assert.equal(duringHistory.error_code, 'native_validation_failure');
assert.equal(JSON.stringify(callJson('orc_get_filament_session_snapshot')), duringHistoryBefore);
assert.equal(JSON.stringify(callJson('orc_get_plate_session_snapshot')), duringHistoryPlatesBefore);
assert.equal(JSON.stringify(callJson('orc_history_status')), duringHistoryStatusBefore);
assert.equal(JSON.stringify(callJson('orc_get_preset_snapshot')), duringHistoryPresetBefore);
assert.equal(JSON.stringify(callJson('orc_get_native_scoped_config')), duringHistorySnapshotBefore);

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
markStage('plate-fixtures');

// The 64-slot round trip above already proves a real project reader/writer
// reset.  This later fixture only needs a fresh history boundary, so reset it
// through the production history protocol instead of re-parsing the same
// immutable empty project a second time.
assert.equal(callJson('orc_clear_model').ok, true);
const retentionContext = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
assert.equal(callJson('orc_history_reset', ['string'], [JSON.stringify(retentionContext)]).canUndo, false);
snapshot = withSlots(1);
const userColour = request('orc_set_filament_slot_colour', { version: 1, revision: snapshot.revisions.session, slot: 1, colour: '#DDAA11' });
assert.equal(userColour.ok, true, JSON.stringify(userColour));
const userPresetSnapshot = userColour.result.snapshot;
const retained = request('orc_select_filament_slot_preset', { version: 1, revision: userPresetSnapshot.revisions.session, slot: 1, preset: alternateFilament(userPresetSnapshot.slots[0].preset.name) });
assert.equal(retained.ok, true, JSON.stringify(retained));
assert.equal(retained.result.snapshot.slots[0].colour.effective, '#DDAA11');

// A normal model history entry must carry the same filament state as a
// filament entry.  Undo/redo across both directions therefore restores the
// complete preset/colour/matrix state even when the ordinary entry was made
// from renderer context that omitted filamentState.
snapshot = retained.result.snapshot;
const historyContext = retentionContext;
const ordinaryBegin = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['ordinary model mutation', 'project', JSON.stringify(historyContext), '']);
assert.equal(ordinaryBegin.ok, true, JSON.stringify(ordinaryBegin));
assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', 'ordinary']).ok, true);
const ordinaryCommit = callJson('orc_history_commit', ['string', 'string'],
  [ordinaryBegin.transactionId, JSON.stringify(historyContext)]);
assert.equal(ordinaryCommit.canUndo, true, JSON.stringify(ordinaryCommit));
// An ordinary model commit deliberately carries no direct filament frame.
// Its undo/redo exercises the serialized/direct-missing fallback; the bridge
// diagnostic must prove this path still never copies PresetBundle.
const fallbackDiagnosticsBefore = callJson('orc_history_restore_diagnostics');
const fallbackUndo = callJson('orc_history_undo');
assert.equal(fallbackUndo.ok, true, 'direct-missing fallback undo');
assert.equal(fallbackUndo.impact?.model, 'delta', JSON.stringify(fallbackUndo));
const fallbackRedo = callJson('orc_history_redo');
assert.equal(fallbackRedo.ok, true, 'direct-missing fallback redo');
assert.equal(fallbackRedo.impact?.filamentRack, true, JSON.stringify(fallbackRedo));
const fallbackDiagnosticsAfter = callJson('orc_history_restore_diagnostics');
assert.equal(fallbackDiagnosticsAfter.fullPresetBundleCopyCount,
  fallbackDiagnosticsBefore.fullPresetBundleCopyCount,
  `direct-missing history fallback must not copy PresetBundle: ${JSON.stringify(fallbackDiagnosticsAfter)}`);
const ordinaryBeforeFilament = semantic(callJson('orc_get_filament_session_snapshot'));
const ordinaryMutation = request('orc_set_filament_slot_colour', {
  version: 1, revision: callJson('orc_get_filament_session_snapshot').revisions.session, slot: 1, colour: '#123456',
});
assert.equal(ordinaryMutation.ok, true, JSON.stringify(ordinaryMutation));
const filamentUndo = callJson('orc_history_undo');
assert.equal(filamentUndo.ok, true);
assert.equal(filamentUndo.impact?.model, 'delta', JSON.stringify(filamentUndo));
assert.equal(filamentUndo.impact?.filamentRack, true, JSON.stringify(filamentUndo));
assert.equal(semantic(callJson('orc_get_filament_session_snapshot')), ordinaryBeforeFilament);
const filamentRedo = callJson('orc_history_redo');
assert.equal(filamentRedo.ok, true);
assert.equal(filamentRedo.impact?.model, 'delta', JSON.stringify(filamentRedo));
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
const assignedObject = setNativeScopedConfig(callJson, 'object', String(objectId), 'extruder', '2');
assert.equal(assignedObject.ok, true, JSON.stringify(assignedObject));
const unrelated = setNativeScopedConfig(callJson, 'project', undefined, 'filament_flush_temp', '200,210');
assert.equal(unrelated.ok, true, JSON.stringify(unrelated));
const unrelatedBefore = JSON.stringify(unrelated.native_scoped_config.project.filament_flush_temp);
const remapped = request('orc_delete_filament_slot', { version: 1, revision: snapshot.revisions.session, slot: 1 });
assert.equal(remapped.ok, true, JSON.stringify(remapped));
assert.equal(remapped.result.snapshot.assignments.objects[0].explicit_slot, 1,
  JSON.stringify(remapped.result.snapshot.assignments));
const unrelatedAfter = callJson('orc_get_native_scoped_config');
assert.equal(JSON.stringify(unrelatedAfter.native_scoped_config.project.filament_flush_temp), unrelatedBefore,
  JSON.stringify(unrelatedAfter));
markStage('preset-and-reference-retention');

// This bundled fixture is deliberately named rather than discovered by
// repeatedly selecting hundreds of printers. Discovery serialized the whole
// compatibility graph per candidate and dominated the command regression
// loop without adding coverage: the explicit assertion below still proves
// this is a fixed multi-nozzle profile at runtime.
const fixedPrinterName = 'MyToolChanger 0.4 nozzle';
const fixedSelected = callJson('orc_select_preset', ['string', 'string'], ['printer', fixedPrinterName]);
assert.equal(fixedSelected.ok, true, JSON.stringify(fixedSelected));
const fixedSnapshot = callJson('orc_get_filament_session_snapshot');
assert.ok(fixedSnapshot, 'profile set must expose a fixed multi-extruder printer');
assert.equal(fixedSnapshot.capabilities.flexible, false, JSON.stringify(fixedSnapshot));
assert.ok(fixedSnapshot.capabilities.nozzle_count > 1, JSON.stringify(fixedSnapshot));
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
markStage('fixed-nozzle-flush');

// Renderer selection stays outside history and cannot advance the native model
// or filament session revision. Add a Cube inside a project transaction, then
// assign Slot 2 against the resulting authoritative filament revision.
function contextForRevisionFence() {
  return {
    selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
    activePlateId: null,
    gizmo: null,
    nativeScopedConfig: {},
  };
}
snapshot = resetFlexibleScenario();
snapshot = withSlots(2);
const fenceContext = JSON.stringify(contextForRevisionFence());
const fenceBegin = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Add Cube', 'project', fenceContext, '']);
assert.equal(fenceBegin.ok, true, JSON.stringify(fenceBegin));
const fenceShape = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Cube']);
assert.equal(fenceShape.ok, true, JSON.stringify(fenceShape));
const fenceCommit = callJson('orc_history_commit', ['string', 'string'],
  [fenceBegin.transactionId, fenceContext]);
assert.equal(fenceCommit.revision, snapshot.revisions.session + 1, JSON.stringify(fenceCommit));
const fenceBeforeContext = callJson('orc_get_filament_session_snapshot');
assert.equal(fenceBeforeContext.assignments.objects.length, 1, JSON.stringify(fenceBeforeContext));
const fenceAfterContext = callJson('orc_get_filament_session_snapshot');
assert.equal(fenceAfterContext.revisions.session, fenceBeforeContext.revisions.session);
const fenceAssignment = request('orc_assign_filament', {
  version: 1, revision: fenceAfterContext.revisions.session, slot: 2,
  targets: [{ kind: 'object', id: fenceBeforeContext.assignments.objects[0].id }],
});
assert.equal(fenceAssignment.ok, true, JSON.stringify(fenceAssignment));
markStage('history-revision-fence');
console.log(JSON.stringify({ commandSmokeDurationMs: Math.round(performance.now() - startedAt), stageTimes,
  slotHistoryLatencies,
  filamentHistoryLatencyBudgetMs: FILAMENT_HISTORY_LATENCY_BUDGET_MS,
  fullPresetBundleCopyCountBeforeHistory: historyDiagnosticsBeforeUndoRedo.fullPresetBundleCopyCount,
  fullPresetBundleCopyCountAfterHistory: minimalHistoryDiagnostics.fullPresetBundleCopyCount,
  fullPresetBundleCopyCountBeforeFallback: fallbackDiagnosticsBefore.fullPresetBundleCopyCount,
  fullPresetBundleCopyCountAfterFallback: fallbackDiagnosticsAfter.fullPresetBundleCopyCount }));
console.log('multi-filament atomic command smoke passed (capacity, remap, rollback, flush, retention, fixed capability, and all five undo/redo command families)');
