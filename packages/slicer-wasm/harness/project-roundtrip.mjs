import { fixtureProfileOptions } from './profile-installer.mjs';
// ----------------------------------------------------------------
// ---- Real WASM BBS 3MF save -> clear -> load round-trip harness ----
// ----------------------------------------------------------------
// This deliberately drives the public bridge seam directly.  It is run once
// for each production wasm64 variant, so an API that only works with the mock
// module cannot accidentally become the persistence implementation.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { callAsyncTask, getSliceResult, resultTarget } from './async-task-mailbox.mjs';
import { readZipEntries } from './native-3mf-parser.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { mutateNativeScopedConfig, setNativeScopedConfig } from './native-scoped-command.mjs';

const opts = {};
for (let i = 2; i < argv.length; i += 2) opts[argv[i]?.replace(/^--/, '')] = argv[i + 1];
const modulePath = opts.module;
if (!modulePath) {
  console.error('usage: node project-roundtrip.mjs --module out/orca_slice.js [--profile-root dist] [--model cube.stl]');
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const modelPath = resolve(opts.model ?? `${repoRoot}/packages/slicer-wasm/fixtures/cube.stl`);
const profileRoot = resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`);
const factory = await loadModuleFactory(modulePath);
const Module = await factory({ noInitialRun: true, print: console.error, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));

function callJson(name, types, args) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const text = Module.UTF8ToString(ptr);
  Module._free(ptr);
  return JSON.parse(text);
}

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

const model = await readFile(modelPath);
let failures = 0;
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

const init = callJson('orc_init', ['string'], [fixtureProfileOptions(Module)]);
check('initialise real module', init.ok === true, JSON.stringify(init));
const startupScoped = callJson('orc_get_native_scoped_config', [], []).native_scoped_config.snapshot.project;
check('fresh startup inherits tower rotation without a local override',
  !Object.hasOwn(startupScoped, 'wipe_tower_rotation_angle'));

// Exercise every generic Project parameter using the live native catalogue.
// Rack, flushing, bed and coordinate inputs have dedicated authorities and
// separate fixtures below; they must not be fuzzed as ordinary Print options.
const initialProfiles = callJson('orc_get_preset_snapshot', [], []);
const initialConfig = initialProfiles.project_config;
const metadata = callJson('orc_get_option_metadata', [], []);
const dedicatedKeys = new Set([
  'wipe_tower_x', 'wipe_tower_y', 'filament_colour', 'filament_colour_type',
  'filament_multi_colour', 'filament_map_mode', 'filament_map', 'filament_volume_map',
  'filament_nozzle_map', 'curr_bed_type', 'flush_volumes_vector', 'flush_volumes_matrix',
  'flush_multiplier', 'flush_multiplier_fast', 'prime_volume_mode', 'nozzle_volume_type',
  'has_filament_switcher', 'enable_filament_dynamic_map',
]);
function changedValue(definition, value) {
  if (definition.enum_values?.length) return definition.enum_values.find(entry => entry !== value);
  if (definition.type === 'bool') return value === '1' ? '0' : '1';
  if (['float', 'int', 'percent', 'float_or_percent'].includes(definition.type)) {
    const parsed = Number.parseFloat(value);
    const previous = Number.isFinite(parsed) ? parsed : 0; // Nullable scalar: materialize a value.
    let step = definition.type === 'int' ? 1 : 0.17;
    if (definition.type !== 'int' && Number.isFinite(definition.min) && Number.isFinite(definition.max) && definition.max > definition.min)
      step = Math.min(step, (definition.max - definition.min) / 3);
    let next = previous + step;
    if (definition.max !== undefined && next > definition.max) next = previous - step;
    if (definition.min !== undefined && next < definition.min) return undefined;
    return String(Number(next.toFixed(4))) + (value.endsWith('%') ? '%' : '');
  }
  if (definition.type === 'string') return value + ' neo persistence';
  if (definition.type === 'strings') return 'neo-persistence';
  if (['floats', 'ints', 'percents', 'bools', 'floats_or_percents'].includes(definition.type)) {
    const type = definition.type === 'floats_or_percents' ? 'float_or_percent' : definition.type.slice(0, -1);
    return value.split(',').map(entry => changedValue({ ...definition, type }, entry)).join(',');
  }
}
const auditedKeys = [];
for (const [key, definition] of Object.entries(metadata)) {
  if (!definition.scopes?.includes('project') || dedicatedKeys.has(key)) continue;
  const value = initialConfig[key] ?? definition.default;
  const changed = typeof value === 'string' ? changedValue(definition, value) : undefined;
  if (changed === undefined || changed === value) throw new Error(`Project audit has no changed fixture for ${key}`);
  const result = setNativeScopedConfig(callJson, 'project', undefined, key, changed);
  if (!result.ok) throw new Error(`Project audit cannot edit ${key}: ${JSON.stringify(result)}`);
  auditedKeys.push(key);
}
// Keep the original regression explicit alongside the catalogue-driven audit.
check('rotation is covered by the Project catalogue audit', auditedKeys.includes('wipe_tower_rotation_angle'));
check('internal extruder mapping is excluded from Project editing',
  !metadata.print_extruder_id.scopes.includes('project') && !metadata.print_extruder_variant.scopes.includes('project'));
const projectMetadataValues = { filament_colour: '#123456', filament_multi_colour: '#123456 #ABCDEF',
  filament_colour_type: '0', flush_multiplier: '0.67', flush_multiplier_fast: '1.57',
  flush_volumes_vector: '151,163' };
for (const [key, value] of Object.entries(projectMetadataValues))
  check(`edit project metadata ${key}`, setNativeScopedConfig(callJson, 'project', undefined, key, value).ok === true);
function setProjectSupportRouting(selector) {
  const session = callJson('orc_get_filament_session_snapshot', [], []);
  const routed = callJson('orc_set_filament_routing', ['string'], [JSON.stringify({
    version: 1, revision: session.revisions.session, selector, slot: 1, targets: [{ kind: 'project' }],
  })]);
  check(`edit project routing ${selector}`, routed.ok === true, JSON.stringify(routed));
}
for (const selector of ['support-base', 'support-interface']) setProjectSupportRouting(selector);
const expectedConfig = callJson('orc_get_preset_snapshot', [], []).project_config;
const preservedKeys = [...auditedKeys, ...dedicatedKeys].filter(key => typeof expectedConfig[key] === 'string');
const emptyExport = callJson('orc_export_project', [], []);
check('export settings-only project', emptyExport.ok === true && emptyExport.objects === 0 && emptyExport.bytes_length > 4);
if (emptyExport.ok) {
  const emptyBytes = readAndFree(emptyExport.bytes_ptr, emptyExport.bytes_length);
  const archiveConfig = JSON.parse(new TextDecoder().decode(
    readZipEntries(emptyBytes).find(entry => entry.name === 'Metadata/project_settings.config').content));
  for (const key of auditedKeys)
    if (!Object.hasOwn(archiveConfig, key)) throw new Error(`3MF omitted Project parameter ${key}`);
  const emptyPtr = writeBytes(emptyBytes);
  const emptyLoaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [emptyPtr, emptyBytes.length, 0, 'settings-only.3mf']);
  Module._free(emptyPtr);
  check('settings-only reopen retains zero models', emptyLoaded.ok === true && emptyLoaded.objects === 0);
  const differences = preservedKeys.filter(key => emptyLoaded.preset_snapshot?.project_config?.[key] !== expectedConfig[key]);
  check(`settings-only reopen preserves all ${auditedKeys.length} edited Project parameters`, differences.length === 0,
    JSON.stringify(differences.map(key => ({ key, saved: expectedConfig[key], loaded: emptyLoaded.preset_snapshot?.project_config?.[key] }))));
  const reopenedRouting = callJson('orc_get_filament_session_snapshot', [], []).routing;
  for (const selector of ['support-base', 'support-interface'])
    check(`settings-only reopen preserves project routing ${selector}`,
      reopenedRouting.find(entry => entry.target === 'project' && entry.selector === selector)?.effective_slot === 1);
}
// Follow the same native steps as shared New Project, including restoration
// of system selections and a reset before establishing the clean baseline.
check('close audited project', callJson('orc_close_project', [], []).ok === true);
for (const kind of ['printer', 'print'])
  check(`restore system ${kind} for New Project`, callJson('orc_select_preset', ['string', 'string'], [kind, initialProfiles[kind].name]).ok === true);
check('New Project resets Print parameters', mutateNativeScopedConfig(callJson, 'reset-all', [{ scope: 'project' }]).ok === true);
const newConfig = callJson('orc_get_preset_snapshot', [], []).project_config;
const resetDifferences = auditedKeys.filter(key => newConfig[key] !== initialConfig[key]);
check('New Project restores all audited parameters to the system baseline', resetDifferences.length === 0, JSON.stringify(resetDifferences));
const newRouting = callJson('orc_get_filament_session_snapshot', [], []).routing;
for (const selector of ['support-base', 'support-interface'])
  check(`New Project resets project routing ${selector}`,
    newRouting.find(entry => entry.target === 'project' && entry.selector === selector)?.effective_slot === 0);
for (const key of Object.keys(projectMetadataValues))
  check(`Print reset preserves dedicated authority ${key}`, newConfig[key] === expectedConfig[key], JSON.stringify({ saved: expectedConfig[key], current: newConfig[key] }));
const newHistory = callJson('orc_history_reset', ['string'], [JSON.stringify({
  selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {},
})]);
check('New Project establishes clean history', newHistory.dirty === false && newHistory.canUndo === false && newHistory.canRedo === false);
// Check representative parameters again with model geometry in the archive.
const modelProjectValues = { wipe_tower_rotation_angle: '90', layer_height: '0.24', wall_loops: '5',
  prime_tower_width: '63', fuzzy_skin: 'all', fuzzy_skin_thickness: '0.42', inner_wall_speed: '123',
  staggered_inner_seams: '1', sparse_infill_density: '37%' };
for (const [key, value] of Object.entries(modelProjectValues))
  check(`edit model-project ${key}`, setNativeScopedConfig(callJson, 'project', undefined, key, value).ok === true);

const modelPtr = writeBytes(model);
const added = callJson('orc_add_model', ['pointer', 'number', 'string', 'string'],
                      [modelPtr, model.length, 'stl', 'cube.stl']);
Module._free(modelPtr);
check('load source geometry', added.ok === true && added.objects === 1 && added.instances === 1,
      JSON.stringify(added));

const before = callJson('orc_get_model_structure', [], []);
const beforeObject = before.objects?.[0];
check('capture source structure', before.ok === true && beforeObject?.volumes?.length === 1,
      JSON.stringify(beforeObject));
for (const selector of ['support-base', 'support-interface']) setProjectSupportRouting(selector);

const secondPlate = callJson('orc_add_plate', [], []);
check('create second native plate', secondPlate.ok === true && secondPlate.plates?.length === 2,
      JSON.stringify(secondPlate));
const secondPlateModel = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Second Plate Cube']);
check('add geometry to second plate', secondPlateModel.ok === true && secondPlateModel.plate_session.affected_plate_ids_after?.length === 1
      && secondPlateModel.plate_session.affected_plate_ids_after[0] === secondPlate.current_plate_id,
      JSON.stringify(secondPlateModel));
const beforeExportSession = callJson('orc_get_plate_session_snapshot', [], []);
const beforeExportMesh = callJson('orc_get_model_mesh', [], []);
check('capture complete multi-plate session', beforeExportSession.ok === true && beforeExportSession.plates?.length === 2
      && beforeExportSession.instances?.some((instance) => instance.plate_id === beforeExportSession.plates[0].plate_id)
      && beforeExportSession.instances?.some((instance) => instance.plate_id === beforeExportSession.plates[1].plate_id),
      JSON.stringify(beforeExportSession));
const oldPlateIds = beforeExportSession.plates?.map((plate) => plate.plate_id) ?? [];
const oldCurrentPlateId = beforeExportSession.current_plate_id;
const oldCurrentRevision = beforeExportSession.input_revisions?.[oldCurrentPlateId] ?? 0;
const seededSlice = await callAsyncTask(callJson, 'orc_slice_plate',
  ['string', 'string', 'number'], ['{}', oldCurrentPlateId, oldCurrentRevision]);
check('materialize an old-session result before replacement', seededSlice.ok === true,
      JSON.stringify(seededSlice));
const seededResult = getSliceResult(callJson, seededSlice.receipt);
check('old-session result is publishable before replacement', seededResult.ok === true,
      JSON.stringify(seededResult));

const exported = callJson('orc_export_project', [], []);
check('export native BBS 3MF', exported.ok === true && exported.bytes_ptr > 0 && exported.bytes_length > 4,
      JSON.stringify(exported));
const project = exported.ok ? readAndFree(exported.bytes_ptr, exported.bytes_length) : new Uint8Array();
check('export returns a ZIP payload', project[0] === 0x50 && project[1] === 0x4b,
      `bytes=${project.byteLength}`);
if (exported.ok) {
  const privateEntries = readZipEntries(project).filter(({ name }) => name.startsWith('Metadata/orca_neo_'));
  check('export omits all Neo-private project metadata', privateEntries.length === 0,
    JSON.stringify(privateEntries.map(({ name }) => name)));
}

const cleared = callJson('orc_clear_model', [], []);
check('clear active scene before reload', cleared.ok === true, JSON.stringify(cleared));
const clearSceneRouting = callJson('orc_get_filament_session_snapshot', [], []).routing;
for (const selector of ['support-base', 'support-interface'])
  check(`Clear Scene retains project routing ${selector}`,
    clearSceneRouting.find(entry => entry.target === 'project' && entry.selector === selector)?.effective_slot === 1);

if (opts['check-add-model'] === 'true') {
  const addProjectPtr = writeBytes(project);
  const addedProject = callJson('orc_add_model', ['pointer', 'number', 'string', 'string'],
                                [addProjectPtr, project.length, '3mf', 'added.3mf']);
  Module._free(addProjectPtr);
  check('add-model 3MF requests and loads model resources',
        addedProject.ok === true && addedProject.objects === 2 && addedProject.instances === 2,
        JSON.stringify(addedProject));
  callJson('orc_clear_model', [], []);
}
if (opts['check-geometry'] === 'true') {
  const geometryPtr = writeBytes(project);
  const geometry = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
                            [geometryPtr, project.length, 1, 'geometry.3mf']);
  Module._free(geometryPtr);
  check('geometry-only BBS import', geometry.ok === true && geometry.mode === 'geometry-only',
        JSON.stringify(geometry));
  // The native candidate is destroyed after this call.  Keep a follow-up
  // bridge call in the regression sequence so a threaded load cannot leave a
  // backup-manager/lifetime worker or otherwise poison the next request.
  const geometryFollowup = callJson('orc_get_model_structure', [], []);
  check('geometry-only cleanup keeps bridge callable',
        geometryFollowup.ok === true && geometryFollowup.objects?.length === 2,
        JSON.stringify(geometryFollowup));
  const geometryMesh = callJson('orc_get_model_mesh', [], []);
  const sourceOffsets = beforeExportMesh.renderables?.map((entry) => entry.instance_transform?.offset) ?? [];
  const importedOffsets = geometryMesh.renderables?.map((entry) => entry.instance_transform?.offset) ?? [];
  const sourceDelta = sourceOffsets.length >= 2
    ? sourceOffsets[1].slice(0, 2).map((value, index) => value - sourceOffsets[0][index]) : [];
  const importedDelta = importedOffsets.length >= 2
    ? importedOffsets[1].slice(0, 2).map((value, index) => value - importedOffsets[0][index]) : [];
  check('geometry-only import translates the group once and preserves relative XY layout',
        sourceDelta.length === 2 && sourceDelta.some((value) => Math.abs(value) > 1e-6)
        && importedDelta.every((value, index) => Math.abs(value - sourceDelta[index]) < 1e-6),
        JSON.stringify({ sourceOffsets, importedOffsets, sourceDelta, importedDelta }));
  callJson('orc_clear_model', [], []);
}

const projectPtr = writeBytes(project);
const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
                        [projectPtr, project.length, 0, 'roundtrip.3mf']);
Module._free(projectPtr);
check('reload exported project', loaded.ok === true && loaded.mode === 'project' && loaded.objects === 2
      && loaded.compatibility === 'bambu' && loaded.project_settings_available === true,
      JSON.stringify(loaded));
for (const [key, value] of Object.entries(modelProjectValues))
  check(`model-project reopen preserves ${key}`, loaded.preset_snapshot?.project_config?.[key] === value,
    JSON.stringify({ saved: value, loaded: loaded.preset_snapshot?.project_config?.[key] }));
const modelReopenedRouting = callJson('orc_get_filament_session_snapshot', [], []).routing;
for (const selector of ['support-base', 'support-interface'])
  check(`model-project reopen preserves project routing ${selector}`,
    modelReopenedRouting.find(entry => entry.target === 'project' && entry.selector === selector)?.effective_slot === 1);
const freshHistory = callJson('orc_history_status', [], []);
check('3MF reload starts a clean history baseline', freshHistory.ok !== false &&
      freshHistory.canUndo === false && freshHistory.canRedo === false &&
      freshHistory.dirty === false,
      JSON.stringify(freshHistory));

const afterSession = callJson('orc_get_plate_session_snapshot', [], []);
check('reload preserves plate order and current identity', afterSession.ok === true && afterSession.plates?.length === 2
      && afterSession.current_plate_id === afterSession.plates[0].plate_id
      && afterSession.plates.every((plate, index) => plate.display_index === index),
      JSON.stringify(afterSession));
check('reload allocates fresh session-only IDs and empty input stamps',
      afterSession.plates?.every((plate) => !oldPlateIds.includes(plate.plate_id)
        && afterSession.input_revisions?.[plate.plate_id] === 0),
      JSON.stringify({ oldPlateIds, loaded: afterSession.plates, revisions: afterSession.input_revisions }));
check('reload preserves plate membership', afterSession.instances?.some((instance) => instance.plate_id === afterSession.plates[0].plate_id)
      && afterSession.instances?.some((instance) => instance.plate_id === afterSession.plates[1].plate_id),
      JSON.stringify(afterSession.instances));
const afterSlice = getSliceResult(callJson,
  resultTarget(afterSession.current_plate_id,
    afterSession.input_revisions[afterSession.current_plate_id], 1));
check('reload does not restore derived slice result', afterSlice.ok !== true
      && ['stale', 'unavailable'].includes(afterSlice.status), JSON.stringify(afterSlice));

const after = callJson('orc_get_model_structure', [], []);
const afterObject = after.objects?.[0];
check('round-trip preserves object and volume structure',
      after.ok === true && after.objects?.length === 2 && afterObject?.volumes?.length === beforeObject?.volumes?.length
      && afterObject?.instanceCount === beforeObject?.instanceCount,
      JSON.stringify(afterObject));

const invalidPtr = writeBytes(new Uint8Array([0x01, 0x02, 0x03]));
const invalid = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
                         [invalidPtr, 3, 0, 'invalid.3mf']);
Module._free(invalidPtr);
const afterInvalid = callJson('orc_get_model_structure', [], []);
const afterInvalidSession = callJson('orc_get_plate_session_snapshot', [], []);
const afterInvalidResult = getSliceResult(callJson,
  resultTarget(afterInvalidSession.current_plate_id,
    afterInvalidSession.input_revisions[afterInvalidSession.current_plate_id], 1));
check('invalid bytes close the loaded project and retain the new empty baseline',
      invalid.ok !== true && afterInvalid.objects?.length === 0
      && afterInvalidSession.plates?.length === 1
      && !afterSession.plates.some((plate) => plate.plate_id === afterInvalidSession.current_plate_id)
      && afterInvalidResult.ok !== true,
      JSON.stringify({ invalid, objects: afterInvalid.objects?.length,
        session: afterInvalidSession, result: afterInvalidResult }));

if (failures) {
  console.error(`project round-trip failed: ${failures} check(s)`);
  process.exitCode = 1;
}
