import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { metadataEntry, readZipEntries, replaceEntry } from './native-3mf-parser.mjs';

const modulePath = argv[argv.indexOf('--module') + 1];
if (!modulePath) throw new Error('usage: node project-preflight-smoke.mjs --module out/orca_slice.js');
const root = resolve(import.meta.dirname, '../../..');
const factory = await loadModuleFactory(modulePath);
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(root, 'packages/profile-resources/dist')));
function callJson(name, types, args) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const value = JSON.parse(Module.UTF8ToString(ptr));
  Module._free(ptr);
  return value;
}
function bytesPtr(bytes) { const ptr = Number(Module._malloc(bytes.length)); Module.HEAPU8.set(bytes, ptr); return ptr; }
function check(label, condition, detail = '') { console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${!condition && detail ? ` — ${detail}` : ''}`); if (!condition) failures++; }
let failures = 0;
check('init', callJson('orc_init', ['string'], ['']).ok === true);
const model = await readFile(resolve(root, 'packages/slicer-wasm/fixtures/cube.stl'));
const modelPtr = bytesPtr(model);
check('add model', callJson('orc_add_model', ['pointer', 'number', 'string', 'string'], [modelPtr, model.length, 'stl', 'cube.stl']).ok === true);
Module._free(modelPtr);
const beforeModel = callJson('orc_get_model_structure', [], []);
const beforeHistory = callJson('orc_history_status', [], []);
const exported = callJson('orc_export_project', [], []);
const archive = Module.HEAPU8.slice(exported.bytes_ptr, exported.bytes_ptr + exported.bytes_length);
Module._free(exported.bytes_ptr);
const sidecar = metadataEntry(archive, 'Metadata/orca_neo_filament_state_v1.json');
check('export contains Neo filament sidecar', sidecar !== null);
if (sidecar) {
  const malformedState = structuredClone(sidecar);
  malformedState.state.project_config.filament_map = '[1,2,3]';
  const malformedArchive = replaceEntry(archive, 'Metadata/orca_neo_filament_state_v1.json', JSON.stringify(malformedState));
  const malformedPtr = bytesPtr(malformedArchive);
  const malformed = callJson('orc_preflight_project', ['pointer', 'number', 'string'], [malformedPtr, malformedArchive.length, 'malformed-sidecar.3mf']);
  Module._free(malformedPtr);
  check('malformed sidecar rejected before commit', malformed.ok !== true);
  check('malformed sidecar preserves model/history', JSON.stringify(callJson('orc_get_model_structure', [], [])) === JSON.stringify(beforeModel)
    && JSON.stringify(callJson('orc_history_status', [], [])) === JSON.stringify(beforeHistory));
  const malformedMatrixState = structuredClone(sidecar);
  malformedMatrixState.state.project_config.flush_volumes_matrix = '0,1';
  const malformedMatrixArchive = replaceEntry(archive, 'Metadata/orca_neo_filament_state_v1.json', JSON.stringify(malformedMatrixState));
  const malformedMatrixPtr = bytesPtr(malformedMatrixArchive);
  const malformedMatrix = callJson('orc_preflight_project', ['pointer', 'number', 'string'], [malformedMatrixPtr, malformedMatrixArchive.length, 'malformed-matrix-sidecar.3mf']);
  Module._free(malformedMatrixPtr);
  check('malformed sidecar matrix rejected before commit', malformedMatrix.ok !== true);
  const malformedVectorState = structuredClone(sidecar);
  malformedVectorState.state.project_config.filament_map = '';
  const malformedVectorArchive = replaceEntry(archive, 'Metadata/orca_neo_filament_state_v1.json', JSON.stringify(malformedVectorState));
  const malformedVectorPtr = bytesPtr(malformedVectorArchive);
  const malformedVector = callJson('orc_preflight_project', ['pointer', 'number', 'string'], [malformedVectorPtr, malformedVectorArchive.length, 'malformed-vector-sidecar.3mf']);
  Module._free(malformedVectorPtr);
  check('malformed sidecar vector rejected before commit', malformedVector.ok !== true);
  check('malformed sidecar vectors/matrix preserve model/history', JSON.stringify(callJson('orc_get_model_structure', [], [])) === JSON.stringify(beforeModel)
    && JSON.stringify(callJson('orc_history_status', [], [])) === JSON.stringify(beforeHistory));
  const plateOverlay = metadataEntry(archive, 'Metadata/orca_neo_config_overlay_v1.json');
  const outOfRangeOverlay = structuredClone(plateOverlay);
  outOfRangeOverlay.overlay.plates['plate-session-1-plate-1'] = { filament_map: '2' };
  const outOfRangeArchive = replaceEntry(archive, 'Metadata/orca_neo_config_overlay_v1.json', JSON.stringify(outOfRangeOverlay));
  const outOfRangePtr = bytesPtr(outOfRangeArchive);
  const outOfRangePlate = callJson('orc_preflight_project', ['pointer', 'number', 'string'], [outOfRangePtr, outOfRangeArchive.length, 'out-of-range-plate-reference.3mf']);
  Module._free(outOfRangePtr);
  check('out-of-range imported plate reference rejected before commit', outOfRangePlate.ok !== true);
  check('out-of-range plate rejection preserves model/history', JSON.stringify(callJson('orc_get_model_structure', [], [])) === JSON.stringify(beforeModel)
    && JSON.stringify(callJson('orc_history_status', [], [])) === JSON.stringify(beforeHistory));
  const unavailableState = structuredClone(sidecar);
  unavailableState.state.filament_presets[0] = '__unavailable_sidecar_preset__';
  const unavailableArchive = replaceEntry(archive, 'Metadata/orca_neo_filament_state_v1.json', JSON.stringify(unavailableState));
  const unavailablePtr = bytesPtr(unavailableArchive);
  const unavailable = callJson('orc_preflight_project', ['pointer', 'number', 'string'], [unavailablePtr, unavailableArchive.length, 'unavailable-sidecar.3mf']);
  Module._free(unavailablePtr);
  check('unavailable sidecar preset rejected before commit', unavailable.ok !== true);
  check('unavailable sidecar preserves model/history', JSON.stringify(callJson('orc_get_model_structure', [], [])) === JSON.stringify(beforeModel)
    && JSON.stringify(callJson('orc_history_status', [], [])) === JSON.stringify(beforeHistory));
}
const projectPtr = bytesPtr(archive);
const preflight = callJson('orc_preflight_project', ['pointer', 'number', 'string'], [projectPtr, archive.length, 'preflight.3mf']);
check('preflight returns token', preflight.ok === true && typeof preflight.preflight_token === 'string');
check('preflight reports slot delta field', Array.isArray(preflight.embedded_preset_warnings?.filament_slot_changes));
const afterPreflightModel = callJson('orc_get_model_structure', [], []);
const afterPreflightHistory = callJson('orc_history_status', [], []);
check('preflight leaves model unchanged', JSON.stringify(afterPreflightModel) === JSON.stringify(beforeModel));
check('preflight leaves history unchanged', JSON.stringify(afterPreflightHistory) === JSON.stringify(beforeHistory));
check('cancel preflight', callJson('orc_cancel_project_preflight', ['string'], [preflight.preflight_token]).ok === true);
check('cancel leaves model unchanged', JSON.stringify(callJson('orc_get_model_structure', [], [])) === JSON.stringify(beforeModel));

// Compatibility provenance must use the requested BBS/Orca project order,
// before native config loading falls back to an available preset.
const nativeFixture = await readFile(resolve(root, 'packages/slicer-wasm/fixtures/native-interoperability/orca-native-multi-plate.3mf'));
const nativeSettings = readZipEntries(nativeFixture).find((entry) => entry.name === 'Metadata/project_settings.config');
const incompatibleSettings = JSON.parse(new TextDecoder().decode(nativeSettings.content));
incompatibleSettings.filament_settings_id = ['AliZ PA-CF @P1-X1'];
const incompatibleArchive = replaceEntry(nativeFixture, 'Metadata/project_settings.config', JSON.stringify(incompatibleSettings));
const incompatiblePtr = bytesPtr(incompatibleArchive);
const incompatiblePreflight = callJson('orc_preflight_project', ['pointer', 'number', 'string'], [incompatiblePtr, incompatibleArchive.length, 'incompatible-request.3mf']);
Module._free(incompatiblePtr);
const incompatibleDelta = incompatiblePreflight.embedded_preset_warnings?.filament_slot_changes;
check('incompatible BBS request reports exact compatibility delta', incompatiblePreflight.ok === true
  && incompatibleDelta?.length === 1
  && incompatibleDelta[0].before === 'AliZ PA-CF @P1-X1'
  && incompatibleDelta[0].after === 'AliZ PA-CF @System'
  && incompatibleDelta[0].reason === 'native-compatibility');
if (incompatiblePreflight.preflight_token) {
  const incompatibleCommit = callJson('orc_commit_project_preflight', ['string'], [incompatiblePreflight.preflight_token]);
  const compatibleSnapshot = callJson('orc_get_filament_session_snapshot', [], []);
  check('accepted incompatible request commits effective compatible slot', incompatibleCommit.ok === true
    && compatibleSnapshot.slots?.[0]?.preset?.name === incompatibleDelta?.[0]?.after);
}
const second = callJson('orc_preflight_project', ['pointer', 'number', 'string'], [projectPtr, archive.length, 'preflight.3mf']);
check('intervening mutation', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'stale-preflight-mutation']).ok === true);
const interveningModel = callJson('orc_get_model_structure', [], []);
const interveningHistory = callJson('orc_history_status', [], []);
const staleCommit = callJson('orc_commit_project_preflight', ['string'], [second.preflight_token]);
check('stale preflight rejected', staleCommit.ok !== true);
check('stale preflight preserves model', JSON.stringify(interveningModel) === JSON.stringify(callJson('orc_get_model_structure', [], [])));
check('stale preflight preserves history', JSON.stringify(interveningHistory) === JSON.stringify(callJson('orc_history_status', [], [])));
const third = callJson('orc_preflight_project', ['pointer', 'number', 'string'], [projectPtr, archive.length, 'preflight.3mf']);
const beforeInjectedModel = callJson('orc_get_model_structure', [], []);
const beforeInjectedHistory = callJson('orc_history_status', [], []);
const beforeInjectedPlateSession = callJson('orc_get_plate_session_snapshot', [], []);
const seededSlice = callJson('orc_slice', ['string'], ['{}']);
const beforeInjectedPreview = seededSlice.ok === true ? callJson('orc_get_slice_result', [], []) : null;
const beforeInjectedFilament = callJson('orc_get_filament_session_snapshot', [], []);
check('seed derived result before injected commit failure', seededSlice.ok === true && beforeInjectedPreview?.ok === true
  && beforeInjectedPreview.metadata?.result_id > 0);
check('inject commit failure armed', callJson('orc_test_inject_project_commit_failure', [], []).ok === true);
const injectedCommit = callJson('orc_commit_project_preflight', ['string'], [third.preflight_token]);
check('post-publication commit failure rejected', injectedCommit.ok !== true);
check('post-publication failure preserves model', JSON.stringify(callJson('orc_get_model_structure', [], [])) === JSON.stringify(beforeInjectedModel));
const afterInjectedHistory = callJson('orc_history_status', [], []);
check('post-publication failure preserves history cursor', afterInjectedHistory.cursor === beforeInjectedHistory.cursor && afterInjectedHistory.revision === beforeInjectedHistory.revision);
const afterInjectedPlateSession = callJson('orc_get_plate_session_snapshot', [], []);
const afterInjectedFilament = callJson('orc_get_filament_session_snapshot', [], []);
const afterInjectedPreview = callJson('orc_get_slice_result', [], []);
check('post-publication failure preserves derived result validity', beforeInjectedPreview?.metadata?.result_id > 0
  && afterInjectedPreview.ok === true
  && afterInjectedPreview.objects === beforeInjectedPreview.objects
  && afterInjectedPreview.layers === beforeInjectedPreview.layers
  && afterInjectedPreview.metadata?.source_text?.available === beforeInjectedPreview.metadata.source_text.available
  && afterInjectedPreview.metadata?.source_text?.byte_length === beforeInjectedPreview.metadata.source_text.byte_length
  && JSON.stringify(afterInjectedPreview.metadata?.extruder_palette) === JSON.stringify(beforeInjectedPreview.metadata.extruder_palette));
check('post-publication failure preserves plate and session revisions', JSON.stringify(afterInjectedPlateSession) === JSON.stringify(beforeInjectedPlateSession)
  && JSON.stringify(afterInjectedFilament) === JSON.stringify(beforeInjectedFilament), JSON.stringify({beforeInjectedPlateSession, afterInjectedPlateSession, beforeInjectedFilament, afterInjectedFilament}));
const fourth = callJson('orc_preflight_project', ['pointer', 'number', 'string'], [projectPtr, archive.length, 'preflight.3mf']);
const committed = callJson('orc_commit_project_preflight', ['string'], [fourth.preflight_token]);
check('commit preflight', committed.ok === true && committed.mode === 'project');
const baselineRack = callJson('orc_get_filament_session_snapshot', [], []);
const badRack = callJson('orc_restore_filament_rack', ['string'], [JSON.stringify({ version: 1, revision: baselineRack.revisions.session, slots: [
  { preset: baselineRack.slots[0].preset.name, colour: '#112233' }, { preset: '__missing__', colour: '#445566' },
] })]);
check('incompatible rack rejected', badRack.ok === false);
const afterBadRack = callJson('orc_get_filament_session_snapshot', [], []);
check('incompatible rack is atomic', JSON.stringify(afterBadRack) === JSON.stringify(baselineRack));
const validRack = { version: 1, revision: baselineRack.revisions.session, slots: [{ preset: baselineRack.slots[0].preset.name, colour: '#112233' }] };
const restoredRack = callJson('orc_restore_filament_rack', ['string'], [JSON.stringify(validRack)]);
check('valid rack restores atomically', restoredRack.ok === true && restoredRack.result?.mutation?.history_entry_delta === 1);
const injectedBefore = callJson('orc_get_filament_session_snapshot', [], []);
const injected = callJson('orc_restore_filament_rack', ['string'], [JSON.stringify({ ...validRack, revision: injectedBefore.revisions.session, inject_failure: true })]);
check('injected rack failure rejected', injected.ok === false);
check('injected rack failure preserves state', JSON.stringify(callJson('orc_get_filament_session_snapshot', [], [])) === JSON.stringify(injectedBefore));
Module._free(projectPtr);
if (failures) process.exit(1);
console.log('project preflight/rack atomic smoke passed');
