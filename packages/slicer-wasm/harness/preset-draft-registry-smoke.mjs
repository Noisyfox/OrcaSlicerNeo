// Focused real-WASM coverage for bridge-owned Printer/Filament drafts.
// node harness/preset-draft-registry-smoke.mjs --module out/serial/orca_slice.js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { readZipEntries, replaceEntry } from './native-3mf-parser.mjs';
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
const dormantSource = callJson('orc_get_preset_snapshot').filament_catalog
  .map((entry) => entry.name).find((name) => name !== firstSource && name !== alternateSource);
assert.ok(dormantSource, 'profile packages must provide a source for the dormant-draft persistence check');

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
const actualSlotColoursBeforeDraft = session.slots.map((slot) => slot.colour.effective);

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

const defaultColourDraft = mutateDraft('set', 'filament', firstSource,
  { key: 'default_filament_colour', value: '#123456' });
assert.equal(defaultColourDraft.overrides.default_filament_colour, '#123456');
session = callJson('orc_get_filament_session_snapshot');
assert.deepEqual(session.slots.map((slot) => slot.colour.effective), actualSlotColoursBeforeDraft,
  'editing the shared material default must not recolour project-owned actual slots');
const dormantDraft = mutateDraft('set', 'filament', dormantSource,
  { key: 'filament_cost', value: '47' });
assert.equal(dormantDraft.modified, true);

// Save through Orca's ordinary BBS writer: it must flatten effective values
// into project_settings.config without persisting a Neo-private draft object.
const exported = callJson('orc_export_project');
assert.equal(exported.ok, true, JSON.stringify(exported));
const exportedBytes = readBytes(exported.bytes_ptr, exported.bytes_length);
const archive = readZipEntries(exportedBytes);
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
assert.deepEqual(savedProjectConfig.filament_colour, actualSlotColoursBeforeDraft,
  'the ordinary 3MF config must retain actual slot colours independently of material defaults');
const differentSettings = Array.isArray(savedProjectConfig.different_settings_to_system)
  ? savedProjectConfig.different_settings_to_system
  : [savedProjectConfig.different_settings_to_system ?? ''];
assert.ok(differentSettings.some((value) => String(value).includes('default_filament_colour')),
'standard preset-difference metadata must identify active Filament draft fields');
assert.ok(!differentSettings.some((value) => String(value).includes('filament_cost')),
'dormant, unreferenced draft fields must not be added to the project metadata');

function loadArchive(bytes, displayName) {
  const pointer = Number(Module._malloc(bytes.length));
  Module.HEAPU8.set(bytes, pointer);
  try {
    return callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
      [pointer, bytes.length, 0, displayName]);
  } finally { Module._free(pointer); }
}
const reloaded = loadArchive(exportedBytes, 'preset-drafts-roundtrip.3mf');
assert.equal(reloaded.ok, true, JSON.stringify(reloaded));
const reloadedPresets = callJson('orc_get_preset_snapshot');
assert.equal(reloadedPresets.project_config.filament_max_volumetric_speed, '23,23,31',
  'real 3MF reload must preserve effective shared and independent Filament inputs');
assert.equal(reloadedPresets.project_config.nozzle_diameter, '0.6',
  'real 3MF reload must preserve the active Printer draft value');
assert.deepEqual(reloadedPresets.project_config.filament_colour.split(';'), actualSlotColoursBeforeDraft,
  'real 3MF reload must preserve actual slot colours without deriving them from the default-colour draft');
assert.equal(callJson('orc_get_preset_draft', ['string', 'string'], ['filament', firstSource])
  .overrides.default_filament_colour, '#123456');
assert.deepEqual(callJson('orc_get_preset_draft', ['string', 'string'], ['filament', firstSource])
  .overrides, {
  default_filament_colour: '#123456', filament_max_volumetric_speed: '23',
}, 'reload must reconstruct one shared canonical Filament overlay');
assert.deepEqual(callJson('orc_get_preset_draft', ['string', 'string'], ['filament', alternateSource])
  .overrides, { filament_max_volumetric_speed: '31' },
'reload must reconstruct an independent active Filament overlay');
assert.deepEqual(callJson('orc_get_preset_draft', ['string', 'string'], ['printer', printer.name])
  .overrides, { nozzle_diameter: '0.6' }, 'reload must reconstruct the active Printer overlay');
assert.equal(callJson('orc_get_preset_draft', ['string', 'string'], ['filament', dormantSource])
  .draft_exists, false, 'unreferenced drafts must not return after 3MF reload');

// A BBS archive can itself provide the canonical Filament source. Exercise
// the native later-slot path where loading the same embedded source more than
// once may update its stored config in place; Neo must preserve that source
// and reconstruct only the active runtime overlay from ordinary project data.
const originalEmbeddedFixture = await readFile(resolve(repoRoot,
  'packages/slicer-wasm/fixtures/multi-filament/independent-reader-basic.3mf'));
const availableFilaments = callJson('orc_get_preset_snapshot').filament_catalog.map((entry) => entry.name);
const embeddedPlaParent = availableFilaments.find((name) => name === 'Generic PLA @BBL P1P');
const embeddedPetgParent = availableFilaments.find((name) => name === 'Generic PETG @BBL P1P');
assert.ok(embeddedPlaParent && embeddedPetgParent, 'profile packages must provide parents for embedded BBS sources');
let embeddedFixture = originalEmbeddedFixture;
const originalEmbeddedEntries = readZipEntries(embeddedFixture);
const originalEmbeddedSettings = originalEmbeddedEntries
  .find(({ name }) => name === 'Metadata/project_settings.config');
assert.ok(originalEmbeddedSettings);
const duplicatedSourceSettings = JSON.parse(new TextDecoder().decode(originalEmbeddedSettings.content));
duplicatedSourceSettings.filament_settings_id = [
  duplicatedSourceSettings.filament_settings_id[0],
  duplicatedSourceSettings.filament_settings_id[0],
];
duplicatedSourceSettings.printer_settings_id = printer.name;
duplicatedSourceSettings.inherits_group = ['', embeddedPlaParent, embeddedPlaParent, printer.name];
embeddedFixture = replaceEntry(embeddedFixture, 'Metadata/project_settings.config', JSON.stringify(duplicatedSourceSettings));
for (const [entryName, inherits] of [
  ['Metadata/filament_settings_1.config', embeddedPlaParent],
  ['Metadata/filament_settings_2.config', embeddedPetgParent],
]) {
  const presetEntry = readZipEntries(embeddedFixture).find(({ name }) => name === entryName);
  assert.ok(presetEntry, entryName);
  const presetConfig = JSON.parse(new TextDecoder().decode(presetEntry.content));
  presetConfig.inherits = inherits;
  if (entryName.endsWith('filament_settings_1.config')) presetConfig.filament_cost = ['42'];
  embeddedFixture = replaceEntry(embeddedFixture, entryName, JSON.stringify(presetConfig));
}
const embeddedLoad = loadArchive(embeddedFixture, 'embedded-filament-draft-source.3mf');
assert.equal(embeddedLoad.ok, true, JSON.stringify(embeddedLoad));
session = callJson('orc_get_filament_session_snapshot');
assert.equal(session.slots.length, 2);
const embeddedSource = session.slots[0].preset.name;
assert.equal(embeddedSource, 'Generic PLA @Project');
assert.deepEqual(session.slots.map((slot) => slot.preset.name), [embeddedSource, embeddedSource]);
const embeddedSourceBefore = callJson('orc_get_preset_draft', ['string', 'string'],
  ['filament', embeddedSource]);
assert.equal(embeddedSourceBefore.source_values.filament_density, '1.24');
assert.equal(embeddedSourceBefore.source_values.filament_cost, '42');
mutateDraft('set', 'filament', embeddedSource,
  { key: 'filament_density', value: '1.33' });
assert.equal(callJson('orc_get_preset_snapshot').project_config.filament_density, '1.33,1.33');

const embeddedExport = callJson('orc_export_project');
assert.equal(embeddedExport.ok, true, JSON.stringify(embeddedExport));
const embeddedBytes = readBytes(embeddedExport.bytes_ptr, embeddedExport.bytes_length);
const embeddedArchive = readZipEntries(embeddedBytes);
assert.deepEqual(embeddedArchive.filter(({ name }) => name.startsWith('Metadata/orca_neo_')), []);
const embeddedProjectSettingsEntry = embeddedArchive.find(({ name }) => name === 'Metadata/project_settings.config');
assert.ok(embeddedProjectSettingsEntry);
const embeddedSavedConfig = JSON.parse(new TextDecoder().decode(embeddedProjectSettingsEntry.content));
assert.deepEqual(embeddedSavedConfig.filament_density.map(Number), [1.33, 1.33]);
const embeddedSourceRecords = embeddedArchive
  .filter(({ name }) => /^Metadata\/filament_settings_\d+\.config$/.test(name))
  .map(({ content }) => JSON.parse(new TextDecoder().decode(content)))
  .filter((config) => config.name === embeddedSource);
assert.ok(embeddedSourceRecords.length > 0, 'the embedded source preset must remain in the ordinary BBS archive');
for (const sourceRecord of embeddedSourceRecords) {
  assert.equal(sourceRecord.inherits, embeddedPlaParent);
  assert.deepEqual(sourceRecord.filament_cost.map(Number), [42]);
  if (sourceRecord.filament_density)
    assert.deepEqual(sourceRecord.filament_density.map(Number), [1.24],
      'saving a runtime draft must not rewrite the embedded source preset');
}
const embeddedReload = loadArchive(embeddedBytes, 'embedded-filament-draft-roundtrip.3mf');
assert.equal(embeddedReload.ok, true, JSON.stringify(embeddedReload));
session = callJson('orc_get_filament_session_snapshot');
assert.deepEqual(session.slots.map((slot) => slot.preset.name), [embeddedSource, embeddedSource]);
const reloadedEmbeddedDraft = callJson('orc_get_preset_draft', ['string', 'string'],
  ['filament', embeddedSource]);
assert.deepEqual(reloadedEmbeddedDraft.overrides, { filament_density: '1.33' });
assert.equal(reloadedEmbeddedDraft.source_values.filament_density, '1.24',
  'reloading must retain the embedded source rather than the BBS loader’s in-place later-slot update');
assert.equal(callJson('orc_get_preset_snapshot').project_config.filament_density, '1.33,1.33');
assert.equal(callJson('orc_get_preset_draft', ['string', 'string'], ['filament', dormantSource])
  .draft_exists, false, 'replacing a project must clear drafts that are absent from its ordinary data');

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
  reloaded_draft_names: [firstSource, alternateSource, printer.name],
  dormant_draft_name: dormantSource,
  prime_tower_plate_count: primeTower.plates.length,
}));
console.log('preset draft registry smoke passed (shared and independent Filament overlays, Printer overlay, flattened 3MF save/reload, dormant-draft omission, slot-color separation, Prepare projection)');
