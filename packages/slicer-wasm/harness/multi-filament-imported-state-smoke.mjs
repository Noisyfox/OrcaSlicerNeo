// Real-WASM imported multi-material painting/layer-tool-change round-trip.
// This assembles a deterministic BBS archive in memory, loads it through the
// native reader, then verifies writer preservation and slot-delete/merge remapping.
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { callAsyncTask } from './async-task-mailbox.mjs';
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
    filament_multi_colour: ['', '', '', ''],
    filament_colour_type: ['RGB', 'RGB', 'RGB', 'RGB'],
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
function loadImportedArchive() {
  const archivePointer = writeBytes(archive);
  const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [archivePointer, archive.byteLength, 0, 'imported-painting-tools.3mf']);
  Module._free(archivePointer);
  return loaded;
}
const loaded = loadImportedArchive();
assert.equal(loaded.ok, true, JSON.stringify(loaded));

const importedSession = callJson('orc_get_filament_session_snapshot');
assert.equal(importedSession.slots.length, 4, JSON.stringify(importedSession));
const importedPlates = callJson('orc_get_plate_session_snapshot');
const importedPlate = importedPlates.plates.find((plate) => plate.plate_id === importedPlates.current_plate_id);
assert.ok(importedPlate, JSON.stringify(importedPlates));
assert.match(JSON.stringify(importedPlate.settings), /2[, ]1/);
const paintedSlice = await callAsyncTask(callJson, 'orc_slice', ['string'], ['{}']);
assert.equal(paintedSlice.ok, true, JSON.stringify(paintedSlice));
const paintedPreview = callJson('orc_get_slice_result');
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
const mergeSession = callJson('orc_get_filament_session_snapshot');
const merged = request('orc_merge_filament_slots', {
  version: 1, revision: mergeSession.revisions.session, source: 2, destination: 4,
});
assert.equal(merged.ok, true, JSON.stringify(merged));
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
