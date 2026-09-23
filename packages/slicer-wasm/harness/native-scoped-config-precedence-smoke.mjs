// Real-WASM configuration-scope regression.
//
// A project/global override and a plate-local override deliberately disagree
// on layer_height. The native bridge must compose the project scope first and
// the plate scope last, both before and after a BBS 3MF save/load round-trip.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { resetNativeScopedConfig, setNativeScopedConfig } from './native-scoped-command.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let i = 2; i < argv.length; i += 2) opts[argv[i]?.replace(/^--/, '')] = argv[i + 1];
const modulePath = opts.module ?? argv[2];
if (!modulePath) {
  console.error('usage: node native-scoped-config-precedence-smoke.mjs --module out/orca_slice.js');
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const encoder = new TextEncoder();
const privateNeoEntryNames = [
  'Metadata/orca_neo_config_overlay_v1.json',
  'Metadata/orca_neo_plate_session_v1.json',
  'Metadata/orca_neo_filament_state_v1.json',
];
const factory = await loadModuleFactory(modulePath);
const Module = await factory({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(repoRoot, 'packages/profile-resources/dist')));

function callJson(name, argTypes = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
const setScoped = (scope, id, key, value) => setNativeScopedConfig(callJson, scope, id, key, value);

function writeBytes(bytes) {
  const ptr = Number(Module._malloc(bytes.byteLength));
  Module.HEAPU8.set(bytes, ptr);
  return ptr;
}

function readAndFree(ptr, length) {
  const bytes = Module.HEAPU8.slice(Number(ptr), Number(ptr) + Number(length));
  Module._free(Number(ptr));
  return bytes;
}

function requireOk(label, result) {
  if (!result?.ok) throw new Error(`${label}: ${JSON.stringify(result)}`);
  return result;
}

function layerSteps(gcode) {
  const zCommentLevels = [...gcode.matchAll(/^;Z:\s*(-?\d+(?:\.\d+)?)/gm)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  const fallbackLevels = [...gcode.matchAll(/^\s*G1\b[^\n]*\bZ(-?\d+(?:\.\d+)?)\b/gm)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  const levels = [...new Set(zCommentLevels.length > 0 ? zCommentLevels : fallbackLevels)].sort((a, b) => a - b);
  return [...new Set(levels.slice(1).map((value, index) => Number((value - levels[index]).toFixed(4))))]
    .filter((value) => value > 0);
}

function firstExportedLayerSteps(receipt) {
  const exported = requireOk('export gcode', exportGcode(callJson, receipt));
  return { exported, steps: layerSteps(Buffer.from(Module.FS.readFile(exported.path)).toString('utf8')) };
}

const init = requireOk('init', callJson('orc_init', ['string'], ['{"log_level":"error"}']));
requireOk('add model', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'precedence regression cube']));

let session = requireOk('plate session', callJson('orc_get_plate_session_snapshot'));
const plateId = session.current_plate_id;

requireOk('set project override', setScoped('project', undefined, 'layer_height', '0.24'));
requireOk('set project Prepare override', setScoped('project', undefined, 'enable_prime_tower', '1'));
requireOk('set project Prepare mode', setScoped('project', undefined, 'timelapse_type', '1'));
session = requireOk('plate session after project override', callJson('orc_get_plate_session_snapshot'));
const revisionAfterProject = session.input_revisions[plateId];
requireOk('set native plate bed type', setScoped('plate', plateId, 'curr_bed_type', 'Engineering Plate'));
requireOk('set native plate spiral mode', setScoped('plate', plateId, 'spiral_mode', '1'));
const unsupportedPlateOverride = setScoped('plate', plateId, 'layer_height', '0.16');
if (unsupportedPlateOverride.ok || unsupportedPlateOverride.error_code !== 'unsupported_reference')
  throw new Error(`unsupported plate option was not rejected: ${JSON.stringify(unsupportedPlateOverride)}`);
const unsupportedPlateReset = resetNativeScopedConfig(callJson, 'plate', plateId, 'layer_height');
if (unsupportedPlateReset.ok || unsupportedPlateReset.error_code !== 'unsupported_reference')
  throw new Error(`unsupported plate reset was not rejected: ${JSON.stringify(unsupportedPlateReset)}`);
session = requireOk('plate session after plate override', callJson('orc_get_plate_session_snapshot'));
const revision = session.input_revisions[plateId];
if (!(revision > revisionAfterProject))
  throw new Error(`plate override did not advance the target revision: ${JSON.stringify(session)}`);

let nativeScopedConfig = requireOk('read native scoped config', callJson('orc_get_native_scoped_config')).native_scoped_config.snapshot;
if (nativeScopedConfig.project?.layer_height !== '0.24' ||
    !Object.values(nativeScopedConfig.plates ?? {}).some((values) =>
      values?.curr_bed_type === 'Engineering Plate' && values?.spiral_mode === '1'))
  throw new Error(`native project/plate values were not retained: ${JSON.stringify(nativeScopedConfig)}`);

let sliced = await callAsyncTask(callJson, 'orc_slice_plate',
  ['string', 'string', 'number'], ['{}', plateId, revision]);
requireOk('slice before round-trip', sliced);
let first = firstExportedLayerSteps(sliced.receipt);
if (Math.abs(first.steps[0] - 0.24) >= 0.005)
  throw new Error(`project layer height did not reach the slice: ${JSON.stringify(first.steps)}`);

const exportedProject = requireOk('export project', callJson('orc_export_project'));
const projectBytes = readAndFree(exportedProject.bytes_ptr, exportedProject.bytes_length);
const exportedEntries = readZipEntries(projectBytes);
if (exportedEntries.some((entry) => privateNeoEntryNames.includes(entry.name)))
  throw new Error('ordinary native 3MF save emitted Neo-private project metadata');
const projectSettingsEntry = exportedEntries.find((entry) => entry.name === 'Metadata/project_settings.config');
if (!projectSettingsEntry)
  throw new Error('ordinary native 3MF save omitted project_settings.config');
const nativeProjectSettings = JSON.parse(new TextDecoder().decode(projectSettingsEntry.content));
const nativeDifferentSettings = nativeProjectSettings.different_settings_to_system;
const nativeDifferentKeys = Array.isArray(nativeDifferentSettings)
  ? nativeDifferentSettings.flatMap((value) => String(value).split(';').filter(Boolean)) : [];
if (!nativeDifferentKeys.includes('layer_height') || !nativeDifferentKeys.includes('timelapse_type'))
  throw new Error(`native edited Print difference was not emitted by the upstream archive path: ${JSON.stringify(nativeDifferentSettings)}`);
// This value is the standard Orca/BBS project-settings field.  It must remain
// native preset-difference input; Neo must not treat it as a list of Project
// scope keys to restore after load.
const projectWithNativeDifferentSettings = writeStoredZip([
  ...exportedEntries.map((entry) => entry.name === projectSettingsEntry.name
    ? { ...entry, content: encoder.encode(JSON.stringify({
        ...nativeProjectSettings,
        different_settings_to_system: nativeDifferentSettings,
      })) }
    : entry),
  { name: 'Metadata/orca_neo_config_overlay_v1.json',
    content: encoder.encode(JSON.stringify({ schema: 'removed', project: { layer_height: '0.42' } })) },
  { name: 'Metadata/orca_neo_plate_session_v1.json',
    content: encoder.encode(JSON.stringify({ schema: 'removed', current_plate_index: 1 })) },
  { name: 'Metadata/orca_neo_filament_state_v1.json',
    content: encoder.encode(JSON.stringify({ schema: 'removed', state: { filament_presets: ['invalid'] } })) },
]);
requireOk('clear model', callJson('orc_clear_model'));
const projectPtr = writeBytes(projectWithNativeDifferentSettings);
const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
  [projectPtr, projectWithNativeDifferentSettings.byteLength, 0, 'native-scoped-config-precedence.3mf']);
Module._free(projectPtr);
requireOk('reload project', loaded);

nativeScopedConfig = requireOk('read round-tripped native scoped config', callJson('orc_get_native_scoped_config')).native_scoped_config.snapshot;
if (nativeScopedConfig.project?.layer_height !== '0.24' ||
    nativeScopedConfig.project?.timelapse_type !== '1' ||
    !Object.values(nativeScopedConfig.plates ?? {}).some((values) =>
      values?.curr_bed_type === 'Engineering Plate' && values?.spiral_mode === '1') ||
    Object.values(nativeScopedConfig.plates ?? {}).some((values) => values?.layer_height === '0.16'))
  throw new Error(`native BBS scoped values did not round-trip through standard owner paths: ${JSON.stringify(nativeScopedConfig)}`);

session = requireOk('round-tripped plate session', callJson('orc_get_plate_session_snapshot'));
const reloadedPlate = session.current_plate_id;
const reloadedRevision = session.input_revisions[reloadedPlate];
sliced = await callAsyncTask(callJson, 'orc_slice_plate',
  ['string', 'string', 'number'], ['{}', reloadedPlate, reloadedRevision]);
requireOk('slice after round-trip', sliced);
const second = firstExportedLayerSteps(sliced.receipt);
if (Math.abs(second.steps[0] - 0.24) >= 0.005)
  throw new Error(`project layer height did not survive round-trip: ${JSON.stringify(second.steps)}`);
const reloadedExport = requireOk('export after private metadata input', callJson('orc_export_project'));
const reloadedEntries = readZipEntries(readAndFree(reloadedExport.bytes_ptr, reloadedExport.bytes_length));
if (reloadedEntries.some((entry) => privateNeoEntryNames.includes(entry.name)))
  throw new Error('private Neo metadata was reproduced after an ignored input');

// Geometry-only import deliberately keeps only the native object extruder
// assignment. Object and volume/part overrides are cleared on the appended
// object, even when the source archive contains those native values.
const sourceStructure = requireOk('read source structure', callJson('orc_get_model_structure'));
const sourceObject = sourceStructure.objects?.[0];
const sourceVolume = sourceObject?.volumes?.[0];
if (!sourceObject?.id || !sourceVolume?.id)
  throw new Error(`source structure did not expose object and volume IDs: ${JSON.stringify(sourceStructure)}`);
const sourceExtruderMutation = requireOk('set source object extruder', setScoped('object', String(sourceObject.id), 'extruder', '1'));
const expectedExtruder = sourceExtruderMutation.native_scoped_config?.replacements?.find(
  (replacement) => replacement.scope === 'object' && replacement.id === String(sourceObject.id),
)?.values?.extruder;
if (typeof expectedExtruder !== 'string')
  throw new Error(`source object extruder assignment was not returned by native snapshot: ${JSON.stringify(sourceExtruderMutation)}`);
requireOk('set source object override', setScoped('object', String(sourceObject.id), 'layer_height', '0.24'));
requireOk('set source part override', setScoped('part', String(sourceVolume.id), 'layer_height', '0.28'));
const geometrySource = requireOk('export geometry-only source', callJson('orc_export_project'));
const geometrySourceBytes = readAndFree(geometrySource.bytes_ptr, geometrySource.bytes_length);
const sourceObjectIds = new Set((sourceStructure.objects ?? []).map((object) => String(object.id)));
const geometryPtr = writeBytes(geometrySourceBytes);
const geometry = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
  [geometryPtr, geometrySourceBytes.byteLength, 1, 'native-scoped-config-geometry-only.3mf']);
Module._free(geometryPtr);
requireOk('geometry-only import', geometry);
const afterGeometryStructure = requireOk('read geometry-only structure', callJson('orc_get_model_structure'));
const importedObject = (afterGeometryStructure.objects ?? []).find(
  (object) => !sourceObjectIds.has(String(object.id)));
if (!importedObject)
  throw new Error(`geometry-only import did not append an object: ${JSON.stringify(afterGeometryStructure)}`);
const afterGeometryConfig = requireOk('read geometry-only native config',
  callJson('orc_get_native_scoped_config')).native_scoped_config.snapshot;
const importedObjectConfig = afterGeometryConfig.objects?.[String(importedObject.id)] ?? {};
if (importedObjectConfig.extruder !== expectedExtruder || Object.prototype.hasOwnProperty.call(importedObjectConfig, 'layer_height'))
  throw new Error(`geometry-only import did not retain only object extruder assignment: expected=${expectedExtruder} actual=${JSON.stringify(importedObjectConfig)}`);
for (const volume of importedObject.volumes ?? []) {
  const importedPartConfig = afterGeometryConfig.parts?.[String(volume.id)] ?? {};
  if (Object.prototype.hasOwnProperty.call(importedPartConfig, 'layer_height'))
    throw new Error(`geometry-only import retained part override: ${JSON.stringify(importedPartConfig)}`);
}

console.log(JSON.stringify({
  ok: true,
  projectLayerHeight: nativeScopedConfig.project.layer_height,
  plateBedType: Object.values(nativeScopedConfig.plates ?? {}).find((values) => values?.curr_bed_type)?.curr_bed_type,
  plateSpiralMode: Object.values(nativeScopedConfig.plates ?? {}).find((values) => values?.spiral_mode)?.spiral_mode,
  nativeDifferentSettings: nativeProjectSettings.different_settings_to_system,
  nativeDifferentSettingsDidNotBecomeProjectScope: true,
  beforeRoundTripSteps: first.steps,
  afterRoundTripSteps: second.steps,
  exportedEntryNames: exportedEntries.map((entry) => entry.name),
  neoPrivateMetadataIgnored: true,
  geometryOnlyObjectConfig: importedObjectConfig,
  geometryOnlyExpectedExtruder: expectedExtruder,
  loadedMode: loaded.mode,
}));
