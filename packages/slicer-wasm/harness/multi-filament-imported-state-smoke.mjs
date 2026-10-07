// Real-WASM imported multi-material painting/layer-tool-change round-trip.
// This assembles a deterministic BBS archive in memory, loads it through the
// native reader, then verifies writer preservation and slot-delete/merge remapping.
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { callAsyncTask, getSliceResult } from './async-task-mailbox.mjs';
import { buildIndependentReader3mf } from './multi-filament-fixture-builder.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const options = {};
for (let index = 2; index < argv.length; index += 2)
  options[argv[index]?.replace(/^--/, '')] = argv[index + 1];
if (!options.module) {
  console.error('usage: node multi-filament-imported-state-smoke.mjs --module out/{serial,threaded}/orca_slice.js');
  process.exit(2);
}

const root = resolve(import.meta.dirname, '../../..');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function textEntry(entries, name) {
  const entry = entries.find((item) => item.name === name);
  assert.ok(entry, `archive is missing ${name}`);
  return decoder.decode(entry.content);
}

function buildImportedStateArchive() {
  const entries = readZipEntries(buildIndependentReader3mf());
  // The dual-nozzle H2D profile uses a positive bed coordinate system; keep
  // this tiny synthetic painted cube inside it so the regression reaches the
  // slice/preview pipeline rather than the placement validator.
  const model = textEntry(entries, '3D/3dmodel.model')
    .replace('transform="1 0 0 0 1 0 0 0 1 0 0 10"', 'transform="1 0 0 0 1 0 0 0 1 100 100 10"');
  // FacetsAnnotation serializes Extruder1..4 as the deterministic nibble
  // strings 4, 8, 0C, and 1C (the low two bits encode split sides).
  const paintStates = ['4', '8', '0C', '1C', '4', '8', '0C', '1C', '4', '8', '0C', '1C'];
  let triangle = 0;
  const paintedModel = model.replace(/<triangle\b[^>]*\/>/g, (source) =>
    source.replace('/>', ` paint_color="${paintStates[triangle++]}"/>`));
  assert.equal(triangle, paintStates.length, 'fixture must paint every cube facet deterministically');

  const project = JSON.parse(textEntry(entries, 'Metadata/project_settings.config'));
  Object.assign(project, {
    printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
    printer_model: 'Bambu Lab H2D',
    filament_settings_id: [
      'Generic PLA @Project', 'Generic PETG @Project',
      'Generic PLA @Project', 'Generic PETG @Project',
    ],
    filament_colour: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'],
    filament_multi_colour: ['#FF0000 #FFFFFF #0000FF', '#00FF00 #0000FF', '', '#FFFF00 invalid'],
    filament_colour_type: ['1', '0', '1', 'future'],
    filament_map: ['1', '1', '1', '1'],
    filament_volume_map: ['0', '0', '0', '0'],
    filament_nozzle_map: ['0', '0', '0', '0'],
    filament_map_2: ['1', '1', '1', '1'],
    filament_self_index: ['0', '0', '0', '0'],
    filament_extruder_variant: ['0', '0', '0', '0'],
    flush_volumes_matrix: ['0', '100', '110', '120', '100', '0', '130', '140',
      '110', '130', '0', '150', '120', '140', '150', '0'],
  });

  const modelSettings = textEntry(entries, 'Metadata/model_settings.config')
    .replace('filament_maps" value="1 1"', 'filament_maps" value="2 1 1 1"')
    .replace('filament_volume_maps" value="0 0"', 'filament_volume_maps" value="0 0 0 0"')
    .replace('filament_nozzle_maps" value="0 0"', 'filament_nozzle_maps" value="0 0 0 0"')
    .replace('</plate>', '<filament id="3" tray_info_idx="PLA-BLUE" type="PLA" color="#0000FF" used_m="0" used_g="0" group_id="0" nozzle_diameter="0.4" volume_type="Standard" used_for_object="true" used_for_support="false"/><filament id="4" tray_info_idx="PETG-YELLOW" type="PETG" color="#FFFF00" used_m="0" used_g="0" group_id="0" nozzle_diameter="0.4" volume_type="Standard" used_for_object="true" used_for_support="false"/></plate>');
  assert.match(modelSettings, /filament_maps" value="2 1 1 1"/);

  const layerGcode = `<?xml version="1.0" encoding="utf-8"?>
<custom_gcodes_per_layer>
  <plate>
    <plate_info id="1"/>
    <layer top_z="0.2" type="2" extruder="2" color="#00FF00" extra="" gcode="tool_change"/>
    <layer top_z="0.4" type="2" extruder="4" color="#FFFF00" extra="" gcode="tool_change"/>
    <mode value="MultiExtruder"/>
  </plate>
</custom_gcodes_per_layer>
`;
  const filamentEntries = [1, 2, 3, 4].map((index) => {
    const source = JSON.parse(textEntry(entries, `Metadata/filament_settings_${index <= 2 ? index : index - 2}.config`));
    source.name = project.filament_settings_id[index - 1];
    source.filament_settings_id = [source.name];
    source.filament_colour = [project.filament_colour[index - 1]];
    return { name: `Metadata/filament_settings_${index}.config`, content: encoder.encode(JSON.stringify(source)) };
  });
  const replaced = entries
    .filter((entry) => ![
      '3D/3dmodel.model', 'Metadata/model_settings.config',
      'Metadata/project_settings.config', 'Metadata/custom_gcode_per_layer.xml',
      'Metadata/filament_settings_1.config', 'Metadata/filament_settings_2.config',
      'Metadata/filament_settings_3.config', 'Metadata/filament_settings_4.config',
    ].includes(entry.name))
    .concat([
      { name: '3D/3dmodel.model', content: encoder.encode(paintedModel) },
      { name: 'Metadata/model_settings.config', content: encoder.encode(modelSettings) },
      { name: 'Metadata/project_settings.config', content: encoder.encode(JSON.stringify(project)) },
      { name: 'Metadata/custom_gcode_per_layer.xml', content: encoder.encode(layerGcode) },
      ...filamentEntries,
    ]);
  return writeStoredZip(replaced);
}

const factory = await loadModuleFactory(resolve(options.module));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(options['profile-root'] ?? `${root}/packages/profile-resources/dist`)));

function callJson(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  const result = JSON.parse(Module.UTF8ToString(pointer));
  Module._free(pointer);
  return result;
}

function request(name, body) { return callJson(name, ['string'], [JSON.stringify(body)]); }
function paintedModelKey() {
  const model = callJson('orc_get_model_mesh');
  for (const list of [model.geometries, model.paint_geometries])
    for (const geometry of list ?? []) {
      Module._free(Number(geometry.vertex_ptr));
      Module._free(Number(geometry.index_ptr));
    }
  assert.equal(model.ok, true, JSON.stringify(model));
  assert.ok(model.paint_geometries.length > 0, 'imported fixture must have native paint geometry');
  return model.paint_geometries[0].paint_key;
}
function writeBytes(bytes) {
  const pointer = Number(Module._malloc(bytes.byteLength));
  Module.HEAPU8.set(bytes, pointer);
  return pointer;
}
function readBytes(pointer, length) {
  const bytes = Module.HEAPU8.slice(Number(pointer), Number(pointer) + Number(length));
  Module._free(Number(pointer));
  return bytes;
}
function exportProject() {
  const exported = callJson('orc_export_project');
  assert.equal(exported.ok, true, JSON.stringify(exported));
  const bytes = Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + Number(exported.bytes_length));
  Module._free(Number(exported.bytes_ptr));
  return bytes;
}
function exportedText(bytes, name) {
  return textEntry(readZipEntries(bytes), name);
}

const archive = buildImportedStateArchive();
assert.equal(callJson('orc_init', ['string'], ['']).ok, true);
function legacyEmptyNotesArchive(source) {
  const entries = readZipEntries(source);
  const project = JSON.parse(textEntry(entries, 'Metadata/project_settings.config'));
  // Match the legacy Bambu project shape: the Project config establishes the
  // material-slot count, but serializes an unset per-filament note as a scalar
  // empty string. Orca's Preset::normalize() expands it before preset loading.
  project.filament_diameter = project.filament_settings_id.map(() => '1.75');
  project.filament_notes = '';
  return writeStoredZip(entries.map((entry) => entry.name === 'Metadata/project_settings.config'
    ? { name: entry.name, content: encoder.encode(JSON.stringify(project)) }
    : entry));
}
function loadArchive(bytes, name) {
  const archivePointer = writeBytes(bytes);
  const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [archivePointer, bytes.byteLength, 0, name]);
  Module._free(archivePointer);
  return loaded;
}
function loadImportedArchive() {
  return loadArchive(archive, 'imported-painting-tools.3mf');
}
const legacyNotes = loadArchive(legacyEmptyNotesArchive(archive), 'legacy-empty-filament-notes.3mf');
assert.equal(legacyNotes.ok, true, JSON.stringify(legacyNotes));
const loaded = loadImportedArchive();
assert.equal(loaded.ok, true, JSON.stringify(loaded));
const colourArrays = ['filament_colour', 'filament_multi_colour', 'filament_colour_type'];
const beforeProjection = JSON.parse(exportedText(exportProject(), 'Metadata/project_settings.config'));
const importedSession = callJson('orc_get_filament_session_snapshot');
assert.equal(importedSession.slots.length, 4, JSON.stringify(importedSession));
assert.deepEqual(importedSession.slots.map((slot) => slot.colour.display), [
  { mode: 'multicolor', colors: ['#FF0000', '#FFFFFF', '#0000FF'] },
  { mode: 'gradient', colors: ['#00FF00', '#0000FF'] },
  { mode: 'solid', colors: ['#0000FF'] },
  { mode: 'solid', colors: ['#FFFF00'] },
]);
assert.deepEqual(importedSession.slots.map((slot) => slot.colour.native), [
  { representative: '#FF0000', multi_colour: '#FF0000 #FFFFFF #0000FF', type: '1' },
  { representative: '#00FF00', multi_colour: '#00FF00 #0000FF', type: '0' },
  { representative: '#0000FF', multi_colour: '', type: '1' },
  { representative: '#FFFF00', multi_colour: '#FFFF00 invalid', type: 'future' },
]);
assert.deepEqual(callJson('orc_get_filament_session_snapshot').slots.map((slot) => slot.colour.native),
  importedSession.slots.map((slot) => slot.colour.native), 'read-only snapshots must preserve native colour arrays');
const afterProjection = JSON.parse(exportedText(exportProject(), 'Metadata/project_settings.config'));
for (const key of colourArrays)
  assert.deepEqual(afterProjection[key], beforeProjection[key], `${key} changed while reading a snapshot`);
if (options['memory-only'] === 'true') {
  const native = () => callJson('orc_get_filament_session_snapshot').slots.map((slot) => slot.colour.native);
  const original = native();
  const slots = importedSession.slots.map((slot) => ({
    preset: slot.preset.name, colour: slot.colour.effective, native: slot.colour.native,
  }));
  const missingNative = request('orc_apply_remembered_filament_rack', {
    version: 1, revision: importedSession.revisions.session,
    slots: slots.map(({ native: _native, ...slot }) => slot),
  });
  assert.equal(missingNative.error_code, 'invalid_command', 'internal rack command requires complete native metadata');
  assert.deepEqual(native(), original, 'invalid internal rack leaves all imported raw values intact');
  const restored = request('orc_apply_remembered_filament_rack', {
    version: 1, revision: importedSession.revisions.session, slots,
  });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.deepEqual(native(), original, 'native remembered apply retains all raw colour fields');
  const printer = callJson('orc_get_preset_snapshot').printer.name;
  const rejectedPrinter = request('orc_select_printer_with_remembered_rack', {
    printer, remembered_rack: { version: 1, slots: slots.map(({ native: _native, ...slot }) => slot) },
    remembered_bed_type: null,
  });
  assert.equal(rejectedPrinter.error_code, 'invalid_request', 'Printer transition also requires complete internal metadata');
  assert.deepEqual(native(), original, 'invalid Printer transition does not mutate raw colours');
  const switched = request('orc_select_printer_with_remembered_rack', {
    printer, remembered_rack: { version: 1, slots }, remembered_bed_type: null,
  });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  assert.deepEqual(native(), original, 'Printer transition applies remembered raw metadata');
  const exported = exportProject();
  const config = JSON.parse(exportedText(exported, 'Metadata/project_settings.config'));
  for (const key of colourArrays)
    assert.deepEqual(config[key], beforeProjection[key], `3MF writer changed ${key}`);
  const reopened = loadArchive(exported, 'remembered-colours.3mf');
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.deepEqual(native(), original, 'standard 3MF reader reopens every remembered raw colour field');
  const reopenedSlots = callJson('orc_get_filament_session_snapshot').slots.map((slot) => ({
    preset: slot.preset.name, colour: slot.colour.effective, native: slot.colour.native,
  }));
  const malformed = reopenedSlots.map((slot, index) => index === 0 ? { ...slot,
    native: { representative: 'not-a-colour', multi_colour: 'unparsed-list', type: 'future' },
  } : slot);
  const revised = request('orc_apply_remembered_filament_rack', {
    version: 1, revision: callJson('orc_get_filament_session_snapshot').revisions.session, slots: malformed,
  });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  assert.deepEqual(native()[0], malformed[0].native, 'native restore must retain malformed raw metadata');
  const nullEntry = malformed.map((slot, index) => index === 0 ? { ...slot,
    native: { representative: null, multi_colour: null, type: null },
  } : slot);
  const restoredNull = request('orc_apply_remembered_filament_rack', {
    version: 1, revision: callJson('orc_get_filament_session_snapshot').revisions.session, slots: nullEntry,
  });
  assert.equal(restoredNull.ok, true, JSON.stringify(restoredNull));
  assert.deepEqual(native()[0], { representative: nullEntry[0].colour,
    multi_colour: nullEntry[0].colour, type: '1' }, 'missing native array entries use documented solid fallback');
  console.log('PASS remembered raw filament rack native apply, Printer transition, and 3MF round-trip');
  process.exit(0);
}
if (options['edit-only'] === 'true') {
  const session = () => callJson('orc_get_filament_session_snapshot');
  const native = () => session().slots.map((slot) => slot.colour.native);
  const original = native();
  const revision = () => session().revisions.session;
  const command = (colour, extra = {}) => request('orc_set_filament_slot_colour', {
    version: 1, revision: revision(), slot: 1, colour, ...extra,
  });
  for (const colour of ['#112233', { kind: 'solid', color: '#112233GG' },
    { kind: 'linear-gradient', start: '#112233', end: '#0000FF8' },
    { kind: 'linear-gradient', start: '#112233', end: '#0000FF40', middle: '#abcdef' }]) {
    const rejected = command(colour);
    assert.equal(rejected.error_code, 'native_validation_failure', JSON.stringify(rejected));
    assert.deepEqual(native(), original, 'invalid colour command must not mutate any raw slot');
  }
  for (const color of ['#11223300', '#11223380', '#112233FF']) {
    const solid = command({ kind: 'solid', color });
    assert.equal(solid.ok, true, JSON.stringify(solid));
    assert.deepEqual(native()[0], { representative: color, multi_colour: color, type: '1' });
    assert.deepEqual(session().slots[0].colour.display, { mode: 'solid', colors: [color] });
    const savedSolid = exportProject();
    const settings = JSON.parse(exportedText(savedSolid, 'Metadata/project_settings.config'));
    assert.equal(settings.filament_colour[0], color, 'solid alpha survives native 3MF export');
    const undo = callJson('orc_history_undo');
    assert.equal(undo.ok, true, JSON.stringify(undo));
    assert.deepEqual(native(), original, 'Undo restores raw colours after a solid RGBA edit');
  }
  const colour = { kind: 'linear-gradient', start: '#FFEEDD80', end: '#0000FF40' };
  for (const extra of [{ inject_failure: true }, { inject_failure_stage: 'before-history' },
    { inject_failure_stage: 'during-history' }]) {
    const rejected = command(colour, extra);
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.deepEqual(native(), original, 'failed gradient edit rolls back complete native colours');
  }
  const before = session();
  const edited = command(colour);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.deepEqual(edited.result.mutation.colour, colour);
  assert.deepEqual(native()[0], { representative: '#FFEEDD80', multi_colour: '#FFEEDD80 #0000FF40', type: '0' });
  assert.deepEqual(session().slots[0].colour.display, { mode: 'gradient', colors: ['#FFEEDD80', '#0000FF40'] });
  assert.deepEqual(native().slice(1), original.slice(1), 'unrelated imported slots stay raw-identical');
  assert.equal(edited.result.mutation.history_entry_delta, 1);
  const after = session();
  const stale = request('orc_set_filament_slot_colour', { version: 1, revision: before.revisions.session, slot: 1,
    colour: { kind: 'solid', color: '#ABCDEF' } });
  assert.equal(stale.error_code, 'stale_revision');
  assert.deepEqual(native()[0], after.slots[0].colour.native);
  const undo = callJson('orc_history_undo');
  assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.deepEqual(native(), original, 'Undo restores all imported raw metadata');
  const redo = callJson('orc_history_redo');
  assert.equal(redo.ok, true, JSON.stringify(redo));
  assert.deepEqual(native()[0], after.slots[0].colour.native, 'Redo restores complete two-endpoint gradient');
  const saved = exportProject();
  const settings = JSON.parse(exportedText(saved, 'Metadata/project_settings.config'));
  assert.deepEqual(settings.filament_colour[0], '#FFEEDD80');
  assert.deepEqual(settings.filament_multi_colour[0], '#FFEEDD80 #0000FF40');
  assert.deepEqual(settings.filament_colour_type[0], '0');
  const reopened = loadArchive(saved, 'edited-gradient.3mf');
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.deepEqual(native()[0], after.slots[0].colour.native, 'standard 3MF reader reopens edited gradient');
  console.log('PASS imported multicolor to gradient edit, validation, rollback, history, and 3MF round-trip');
  process.exit(0);
}
if (options['lifecycle-only'] === 'true') {
  const native = () => callJson('orc_get_filament_session_snapshot').slots.map((slot) => slot.colour.native);
  const revision = () => callJson('orc_get_filament_session_snapshot').revisions.session;
  const original = native();
  const check = (expected, label) => assert.deepEqual(native(), expected, label);
  const undo = (expected, label) => {
    const result = callJson('orc_history_undo');
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
    check(expected, label);
  };
  const redo = (expected, label) => {
    const result = callJson('orc_history_redo');
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
    check(expected, label);
  };

  const added = request('orc_add_filament_slot', { version: 1, revision: revision() });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.deepEqual(native().slice(0, 4), original, 'Add retains every old raw colour');
  assert.equal(native()[4].type, '1', 'new slot starts solid');
  const afterAdd = native();
  const stale = request('orc_delete_filament_slot', { version: 1, revision: importedSession.revisions.session, slot: 2 });
  assert.equal(stale.error_code, 'stale_revision');
  check(afterAdd, 'stale command leaves all raw colours intact');
  const rejected = request('orc_delete_filament_slot', { version: 1, revision: revision(), slot: 2, inject_failure: true });
  assert.equal(rejected.ok, false);
  check(afterAdd, 'failed mutation rolls back all raw colours');
  undo(original, 'Undo Add restores imported entries');
  redo(afterAdd, 'Redo Add retains imported entries');
  undo(original, 'Undo Add again restores imported entries');

  const selected = request('orc_select_filament_slot_preset', {
    version: 1, revision: revision(), slot: 1, preset: importedSession.slots[1].preset.name,
  });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  assert.notEqual(importedSession.slots[0].preset.name, importedSession.slots[1].preset.name);
  assert.equal(callJson('orc_get_filament_session_snapshot').slots[0].preset.name, importedSession.slots[1].preset.name);
  check(original, 'changing a preset retains multi-colour even when representative equals its old default');
  undo(original, 'Undo preset selection retains raw entries');
  redo(original, 'Redo preset selection retains raw entries');

  const unknownTypePreset = request('orc_select_filament_slot_preset', {
    version: 1, revision: revision(), slot: 4, preset: importedSession.slots[0].preset.name,
  });
  assert.equal(unknownTypePreset.ok, true, JSON.stringify(unknownTypePreset));
  check(original, 'changing another preset retains unknown type and malformed list verbatim');
  undo(original, 'Undo unknown-type preset selection retains raw entries');
  redo(original, 'Redo unknown-type preset selection retains raw entries');

  const deleted = request('orc_delete_filament_slot', { version: 1, revision: revision(), slot: 2 });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  check([original[0], original[2], original[3]], 'Delete shifts complete raw entries');
  undo(original, 'Undo Delete restores complete entries');
  redo([original[0], original[2], original[3]], 'Redo Delete shifts complete entries');
  undo(original, 'Undo Delete again restores imported entries');

  const merged = request('orc_merge_filament_slots', { version: 1, revision: revision(), source: 2, destination: 4 });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  check([original[0], original[2], original[3]], 'Merge retains destination complete entry');
  undo(original, 'Undo Merge restores complete entries');
  redo([original[0], original[2], original[3]], 'Redo Merge retains destination entry');
  undo(original, 'Undo Merge again restores imported entries');

  const currentPrinter = callJson('orc_get_preset_snapshot').printer.name;
  const transitioned = request('orc_select_printer_with_remembered_rack', {
    printer: currentPrinter, remembered_rack: null, remembered_bed_type: null,
  });
  assert.equal(transitioned.ok, true, JSON.stringify(transitioned));
  check(original, 'compatible Printer transition retains raw colours');
  undo(original, 'Undo Printer transition retains raw colours');
  redo(original, 'Redo Printer transition retains raw colours');

  const solid = request('orc_set_filament_slot_colour', { version: 1, revision: revision(), slot: 1, colour: { kind: 'solid', color: '#ABCDEF' } });
  assert.equal(solid.ok, true, JSON.stringify(solid));
  assert.deepEqual(native()[0], { representative: '#ABCDEF', multi_colour: '#ABCDEF', type: '1' });
  undo(original, 'Undo solid edit restores imported multi-colour');
  console.log('PASS imported multi-filament colour lifecycle smoke');
  process.exit(0);
}
if (options['load-only'] === 'true') {
  console.log('PASS imported multi-filament legacy-vector load smoke');
  process.exit(0);
}

const importedPaintKey = paintedModelKey();
const importedPlates = callJson('orc_get_plate_session_snapshot');
const importedPlate = importedPlates.plates.find((plate) => plate.plate_id === importedPlates.current_plate_id);
assert.ok(importedPlate, JSON.stringify(importedPlates));
assert.match(JSON.stringify(importedPlate.settings), /2[, ]1/);
const paintedSlice = await callAsyncTask(callJson, 'orc_slice', ['string'], ['{}']);
assert.equal(paintedSlice.ok, true, JSON.stringify(paintedSlice));
const paintedPreview = getSliceResult(callJson, paintedSlice.receipt);
assert.equal(paintedPreview.ok, true, JSON.stringify(paintedPreview));
const paintedCount = Number(paintedPreview.toolpath?.segment_count ?? 0);
assert.ok(paintedCount > 0, JSON.stringify(paintedPreview));
const paintedFilaments = [...new Set(readBytes(paintedPreview.toolpath.extruder_id_ptr, paintedCount))].sort((a, b) => a - b);
assert.deepEqual(paintedFilaments, [0, 1, 2, 3], JSON.stringify({ paintedFilaments, paintedPreview }));
assert.deepEqual(paintedPreview.metadata?.extruder_palette?.slice(0, 4).map((entry) => entry.color),
  [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]], JSON.stringify(paintedPreview.metadata));
const preserved = exportProject();
const preservedModel = exportedText(preserved, '3D/3dmodel.model');
const preservedLayers = exportedText(preserved, 'Metadata/custom_gcode_per_layer.xml');
const preservedPaint = [...preservedModel.matchAll(/paint_color="([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(preservedPaint, ['4', '8', '0C', '1C', '4', '8', '0C', '1C', '4', '8', '0C', '1C']);
assert.match(preservedLayers, /extruder="2" color="#00FF00"/);
assert.match(preservedLayers, /extruder="4" color="#FFFF00"/);
assert.match(preservedLayers, /gcode="tool_change"/);

const deleted = request('orc_delete_filament_slot', {
  version: 1, revision: importedSession.revisions.session, slot: 2,
});
assert.equal(deleted.ok, true, JSON.stringify(deleted));
const deletedPaintKey = paintedModelKey();
assert.notEqual(deletedPaintKey, importedPaintKey, 'deletion must version the rendered facet resource');
const remapped = exportProject();
const remappedModel = exportedText(remapped, '3D/3dmodel.model');
const remappedLayers = exportedText(remapped, 'Metadata/custom_gcode_per_layer.xml');
const remappedPaint = [...remappedModel.matchAll(/paint_color="([^"]+)"/g)].map((match) => match[1]);
assert.equal(remappedPaint.length, 9, JSON.stringify(remappedPaint));
assert.deepEqual(remappedPaint, ['4', '8', '0C', '4', '8', '0C', '4', '8', '0C']);
assert.doesNotMatch(remappedLayers, /extruder="2"/);
assert.match(remappedLayers, /extruder="3" color="#FFFF00"/);
assert.match(remappedLayers, /gcode="tool_change"/);

// Merge from a fresh reload: source slot 2 is merged into non-adjacent
// destination slot 4. Both source and destination therefore become the
// post-merge slot 3, while original slot 3 becomes slot 2.  The native
// facet encoding therefore maps old states 1,2,3,4 to 1,3,2,3.
assert.equal(callJson('orc_init', ['string'], ['']).ok, true);
assert.equal(loadImportedArchive().ok, true);
const mergeBaselinePaintKey = paintedModelKey();
const mergeSession = callJson('orc_get_filament_session_snapshot');
const merged = request('orc_merge_filament_slots', {
  version: 1, revision: mergeSession.revisions.session, source: 2, destination: 4,
});
assert.equal(merged.ok, true, JSON.stringify(merged));
const mergedPaintKey = paintedModelKey();
assert.notEqual(mergedPaintKey, mergeBaselinePaintKey, 'merge must version the rendered facet resource');
const mergeUndo = callJson('orc_history_undo');
assert.equal(mergeUndo.ok, true, JSON.stringify(mergeUndo));
assert.equal(paintedModelKey(), mergeBaselinePaintKey, 'Undo must restore pre-merge paint geometry');
const mergeRedo = callJson('orc_history_redo');
assert.equal(mergeRedo.ok, true, JSON.stringify(mergeRedo));
assert.equal(paintedModelKey(), mergedPaintKey, 'Redo must restore merged paint geometry');
const mergedArchive = exportProject();
const mergedModel = exportedText(mergedArchive, '3D/3dmodel.model');
const mergedLayers = exportedText(mergedArchive, 'Metadata/custom_gcode_per_layer.xml');
const mergedPaint = [...mergedModel.matchAll(/paint_color="([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(mergedPaint, ['4', '0C', '8', '0C', '4', '0C', '8', '0C', '4', '0C', '8', '0C']);
assert.deepEqual([...mergedLayers.matchAll(/<layer\b[^>]*extruder="([^"]+)"[^>]*color="([^"]+)"[^>]*gcode="tool_change"/g)]
  .map((match) => `T${match[1]}/${match[2]}`), ['T3/#00FF00', 'T3/#FFFF00']);

console.log(JSON.stringify({
  importedSlots: importedSession.slots.length,
  paintedPlateMap: importedPlate.settings,
  paintedPreview: { filaments: paintedFilaments, palette: paintedPreview.metadata.extruder_palette.slice(0, 4) },
  preservedPainting: preservedPaint,
  preservedLayerToolChanges: ['T2/#00FF00', 'T4/#FFFF00'],
  remappedPainting: remappedPaint,
  remappedLayerToolChanges: ['deleted=T2', 'survivor=T3/#FFFF00'],
  mergedPainting: mergedPaint,
  mergedLayerToolChanges: ['source=T3/#00FF00', 'destination=T3/#FFFF00'],
}, null, 2));
