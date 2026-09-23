// Focused real-WASM coverage for bridge-owned Printer/Filament drafts.
// node harness/preset-draft-registry-smoke.mjs --module out/serial/orca_slice.js
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { readZipEntries } from './native-3mf-parser.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let index = 2; index < argv.length; index += 2)
  opts[argv[index]?.replace(/^--/, '')] = argv[index + 1];
if (!opts.module) {
  console.error('usage: node harness/preset-draft-registry-smoke.mjs --module out/serial/orca_slice.js');
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const profileRoot = resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`);
const factory = await loadModuleFactory(resolve(opts.module));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));

function callJson(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  const value = JSON.parse(Module.UTF8ToString(pointer));
  Module._free(pointer);
  return value;
}

function request(name, body) {
  return callJson(name, ['string'], [JSON.stringify(body)]);
}

function historyStatus() {
  return callJson('orc_history_status');
}

function mutateDraft(action, kind, canonicalName, fields = {}) {
  const result = request('orc_mutate_preset_draft', {
    version: 1, action, kind, canonical_name: canonicalName,
    expected_revision: historyStatus().revision, ...fields,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.history_entry_delta, 1, 'each accepted draft command must add one history entry');
  assert.equal(result.all_plate_results_invalidated, true);
  return result;
}

function readBytes(pointer, length) {
  const bytes = Module.HEAPU8.slice(Number(pointer), Number(pointer) + Number(length));
  Module._free(Number(pointer));
  return bytes;
}

const init = callJson('orc_init', ['string'], ['']);
assert.equal(init.ok, true, JSON.stringify(init));
const initial = callJson('orc_get_preset_snapshot');
const printer = initial.printers.find((entry) => /Bambu Lab P1P 0\.4 nozzle/.test(entry.name))
  ?? initial.printers.find((entry) => /Bambu Lab/.test(entry.name));
assert.ok(printer, 'profile packages must provide a flexible Bambu printer');
const selection = callJson('orc_select_preset', ['string', 'string'], ['printer', printer.name]);
assert.equal(selection.ok, true, JSON.stringify(selection));

let session = callJson('orc_get_filament_session_snapshot');
assert.equal(session.ok, true, JSON.stringify(session));
assert.equal(session.capabilities.flexible, true, JSON.stringify(session));
const firstSource = session.slots[0].preset.name;
const alternateSource = callJson('orc_get_preset_snapshot').filament_catalog
  .map((entry) => entry.name).find((name) => name !== firstSource);
assert.ok(alternateSource, 'profile packages must provide a distinct compatible filament');

for (let slotCount = session.slots.length; slotCount < 3; slotCount++) {
  const added = request('orc_add_filament_slot', {
    version: 1, revision: session.revisions.session,
  });
  assert.equal(added.ok, true, JSON.stringify(added));
  session = added.result.snapshot;
}
assert.deepEqual(session.slots.map((slot) => slot.preset.name),
  [firstSource, firstSource, firstSource], 'slot additions start from the active canonical preset');
const selectedAlternate = request('orc_select_filament_slot_preset', {
  version: 1, revision: session.revisions.session, slot: 3, preset: alternateSource,
});
assert.equal(selectedAlternate.ok, true, JSON.stringify(selectedAlternate));
session = selectedAlternate.result.snapshot;
assert.deepEqual(session.slots.map((slot) => slot.preset.name),
  [firstSource, firstSource, alternateSource], 'the fixture must have two shared-source slots and one independent source');

const firstSourceBefore = callJson('orc_get_preset_draft', ['string', 'string'], ['filament', firstSource]);
const alternateSourceBefore = callJson('orc_get_preset_draft', ['string', 'string'], ['filament', alternateSource]);
assert.equal(firstSourceBefore.ok, true, JSON.stringify(firstSourceBefore));
assert.equal(alternateSourceBefore.ok, true, JSON.stringify(alternateSourceBefore));
assert.ok(Object.hasOwn(firstSourceBefore.source_values, 'filament_max_volumetric_speed'));
assert.ok(Object.hasOwn(alternateSourceBefore.source_values, 'filament_max_volumetric_speed'));
assert.ok(Object.hasOwn(alternateSourceBefore.source_values, 'filament_density'));

const emptyFieldReset = mutateDraft('reset-field', 'filament', firstSource,
  { key: 'filament_max_volumetric_speed' });
assert.equal(emptyFieldReset.draft_exists, true,
  'resetting a field without overrides still retains an empty draft child');
assert.equal(emptyFieldReset.modified, false);
assert.deepEqual(emptyFieldReset.overrides, {});

const historyBeforeFirstDraft = historyStatus();
const staleRevision = historyBeforeFirstDraft.revision;
const firstDraft = mutateDraft('set', 'filament', firstSource,
  { key: 'filament_max_volumetric_speed', value: '23' });
assert.equal(historyStatus().undoEntries.length, historyBeforeFirstDraft.undoEntries.length + 1);
assert.equal(firstDraft.modified, true);
assert.equal(firstDraft.source_values.filament_max_volumetric_speed,
  firstSourceBefore.source_values.filament_max_volumetric_speed,
  'draft edits must not mutate the source catalogue preset');

const alternateDraft = mutateDraft('set', 'filament', alternateSource,
  { key: 'filament_max_volumetric_speed', value: '31' });
assert.equal(alternateDraft.source_values.filament_max_volumetric_speed,
  alternateSourceBefore.source_values.filament_max_volumetric_speed,
  'an independent draft must not mutate its source catalogue preset');

const sharedSourceDraft = callJson('orc_get_preset_draft', ['string', 'string'], ['filament', firstSource]);
const independentSourceDraft = callJson('orc_get_preset_draft', ['string', 'string'], ['filament', alternateSource]);
assert.deepEqual(sharedSourceDraft.overrides, { filament_max_volumetric_speed: '23' });
assert.deepEqual(independentSourceDraft.overrides, { filament_max_volumetric_speed: '31' });

const platesBeforeRejected = callJson('orc_get_plate_session_snapshot');
const historyBeforeRejected = historyStatus();
const stale = request('orc_mutate_preset_draft', {
  version: 1, action: 'set', kind: 'filament', canonical_name: firstSource,
  expected_revision: staleRevision, key: 'filament_max_volumetric_speed', value: '99',
});
assert.equal(stale.ok, false);
assert.equal(stale.error_code, 'stale_revision');
const invalid = request('orc_mutate_preset_draft', {
  version: 1, action: 'set', kind: 'filament', canonical_name: firstSource,
  expected_revision: historyStatus().revision, key: 'not_a_preset_option', value: '99',
});
assert.equal(invalid.ok, false);
assert.equal(invalid.error_code, 'unsupported_option');
assert.deepEqual(historyStatus(), historyBeforeRejected, 'rejected commands must not add history or advance revision');
assert.deepEqual(callJson('orc_get_plate_session_snapshot').input_revisions, platesBeforeRejected.input_revisions,
  'rejected commands must not change plate input revisions');

const beforeFieldReset = historyStatus();
const fieldReset = mutateDraft('reset-field', 'filament', alternateSource,
  { key: 'filament_max_volumetric_speed' });
assert.equal(fieldReset.draft_exists, true);
assert.equal(fieldReset.modified, false);
assert.deepEqual(fieldReset.overrides, {});
assert.equal(historyStatus().undoEntries.length, beforeFieldReset.undoEntries.length + 1);
mutateDraft('set', 'filament', alternateSource,
  { key: 'filament_max_volumetric_speed', value: '31' });
const categoryReset = mutateDraft('reset-category', 'filament', alternateSource,
  { keys: ['filament_max_volumetric_speed', 'filament_density'] });
assert.equal(categoryReset.draft_exists, true);
assert.equal(categoryReset.modified, false);
assert.deepEqual(categoryReset.overrides, {});
const wholePresetReset = mutateDraft('reset-preset', 'filament', alternateSource);
assert.equal(wholePresetReset.draft_exists, false);
mutateDraft('set', 'filament', alternateSource,
  { key: 'filament_max_volumetric_speed', value: '31' });

const beforeUndo = callJson('orc_get_plate_session_snapshot').input_revisions;
const undo = callJson('orc_history_undo');
assert.equal(undo.ok, true, JSON.stringify(undo));
assert.equal(undo.impact.presetDrafts, true, JSON.stringify(undo.impact));
const afterUndoDraft = callJson('orc_get_preset_draft', ['string', 'string'], ['filament', alternateSource]);
assert.equal(afterUndoDraft.draft_exists, false, 'history restores the registry before selected slot effective values');
const afterUndo = callJson('orc_get_plate_session_snapshot');
for (const [plateId, revision] of Object.entries(beforeUndo))
  assert.ok(afterUndo.input_revisions[plateId] > revision, `undo must invalidate ${plateId}`);
const redo = callJson('orc_history_redo');
assert.equal(redo.ok, true, JSON.stringify(redo));
assert.equal(redo.impact.presetDrafts, true, JSON.stringify(redo.impact));
assert.deepEqual(callJson('orc_get_preset_draft', ['string', 'string'], ['filament', alternateSource]).overrides,
  { filament_max_volumetric_speed: '31' });
const afterFilamentDrafts = callJson('orc_get_preset_snapshot');
assert.equal(afterFilamentDrafts.project_config.filament_max_volumetric_speed, '23,23,31',
  'the effective slice config must overlay the same canonical draft into both slots and preserve the other preset draft');

const printerBefore = callJson('orc_get_preset_draft', ['string', 'string'], ['printer', printer.name]);
assert.equal(printerBefore.ok, true, JSON.stringify(printerBefore));
assert.ok(Object.hasOwn(printerBefore.source_values, 'nozzle_diameter'));
const printerDraft = mutateDraft('set', 'printer', printer.name,
  { key: 'nozzle_diameter', value: '0.6' });
assert.equal(printerDraft.source_values.nozzle_diameter, printerBefore.source_values.nozzle_diameter,
  'the Printer draft must be isolated from its source preset');
const afterPrinterDraft = callJson('orc_get_preset_snapshot');
assert.equal(afterPrinterDraft.project_config.nozzle_diameter, '0.6',
  'the active Printer draft must reach the complete effective config used to start slicing');

// Save through Orca's ordinary BBS writer: it must flatten effective values
// into project_settings.config without persisting a Neo-private draft object.
const exported = callJson('orc_export_project');
assert.equal(exported.ok, true, JSON.stringify(exported));
const archive = readZipEntries(readBytes(exported.bytes_ptr, exported.bytes_length));
assert.deepEqual(archive.filter(({ name }) => name.startsWith('Metadata/orca_neo_')), [],
  'draft state must not be serialized as Neo-private 3MF metadata');
const projectSettingsEntry = archive.find(({ name }) => name === 'Metadata/project_settings.config');
assert.ok(projectSettingsEntry, 'standard project_settings.config must be present');
const savedProjectConfig = JSON.parse(new TextDecoder().decode(projectSettingsEntry.content));
assert.deepEqual(savedProjectConfig.filament_max_volumetric_speed.map(Number), [23, 23, 31],
  'the ordinary project save must flatten effective Filament values');
assert.deepEqual(savedProjectConfig.nozzle_diameter.map(Number), [0.6],
  'the ordinary project save must flatten the active Printer draft');
assert.ok(!Object.hasOwn(savedProjectConfig, 'preset_drafts'),
  'standard project config must not contain a draft registry');

// Exercise an independent Prepare-side effective-config consumer.  It must
// still project from native state with the bridge-owned Printer draft present.
const primeTower = callJson('orc_get_prime_tower_projection');
assert.equal(primeTower.ok, true, JSON.stringify(primeTower));
assert.ok(Array.isArray(primeTower.plates), JSON.stringify(primeTower));
assert.ok(primeTower.plates.length > 0, 'the Prepare projection must include the active plate');

console.log(JSON.stringify({
  printer: printer.name,
  shared_filament_source: firstSource,
  independent_filament_source: alternateSource,
  effective_filament_max_volumetric_speed: afterFilamentDrafts.project_config.filament_max_volumetric_speed,
  effective_nozzle_diameter: afterPrinterDraft.project_config.nozzle_diameter,
  saved_filament_max_volumetric_speed: savedProjectConfig.filament_max_volumetric_speed,
  saved_nozzle_diameter: savedProjectConfig.nozzle_diameter,
  prime_tower_plate_count: primeTower.plates.length,
}));
console.log('preset draft registry smoke passed (shared canonical Filament draft, independent source, Printer slice config, flattened 3MF save, Prepare projection)');
