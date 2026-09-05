// ----------------------------------------------------------------
// ---- Real WASM BBS 3MF save -> clear -> load round-trip harness ----
// ----------------------------------------------------------------
// This deliberately drives the public bridge seam directly.  It is run once
// for each production wasm64 variant, so an API that only works with the mock
// module cannot accidentally become the persistence implementation.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

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

const init = callJson('orc_init', ['string'], ['']);
check('initialise real module', init.ok === true, JSON.stringify(init));

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

const secondPlate = callJson('orc_add_plate', [], []);
check('create second native plate', secondPlate.ok === true && secondPlate.plates?.length === 2,
      JSON.stringify(secondPlate));
const secondPlateModel = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Second Plate Cube']);
check('add geometry to second plate', secondPlateModel.ok === true && secondPlateModel.affected_plate_ids_after?.length === 1
      && secondPlateModel.affected_plate_ids_after[0] === secondPlate.current_plate_id,
      JSON.stringify(secondPlateModel));
const beforeExportSession = callJson('orc_get_plate_session_snapshot', [], []);
check('capture complete multi-plate session', beforeExportSession.ok === true && beforeExportSession.plates?.length === 2
      && beforeExportSession.instances?.some((instance) => instance.plate_id === beforeExportSession.plates[0].plate_id)
      && beforeExportSession.instances?.some((instance) => instance.plate_id === beforeExportSession.plates[1].plate_id),
      JSON.stringify(beforeExportSession));

const exported = callJson('orc_export_project', [], []);
check('export native BBS 3MF', exported.ok === true && exported.bytes_ptr > 0 && exported.bytes_length > 4,
      JSON.stringify(exported));
const project = exported.ok ? readAndFree(exported.bytes_ptr, exported.bytes_length) : new Uint8Array();
check('export returns a ZIP payload', project[0] === 0x50 && project[1] === 0x4b,
      `bytes=${project.byteLength}`);

const cleared = callJson('orc_clear_model', [], []);
check('clear active scene before reload', cleared.ok === true, JSON.stringify(cleared));

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
  callJson('orc_clear_model', [], []);
}

const projectPtr = writeBytes(project);
const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
                        [projectPtr, project.length, 0, 'roundtrip.3mf']);
Module._free(projectPtr);
check('reload exported project', loaded.ok === true && loaded.mode === 'project' && loaded.objects === 2
      && loaded.compatibility === 'bambu' && loaded.project_settings_available === true,
      JSON.stringify(loaded));

const afterSession = callJson('orc_get_plate_session_snapshot', [], []);
check('reload preserves plate order and current identity', afterSession.ok === true && afterSession.plates?.length === 2
      && afterSession.current_plate_id === afterSession.plates[1].plate_id
      && afterSession.plates.every((plate, index) => plate.display_index === index),
      JSON.stringify(afterSession));
check('reload preserves plate membership', afterSession.instances?.some((instance) => instance.plate_id === afterSession.plates[0].plate_id)
      && afterSession.instances?.some((instance) => instance.plate_id === afterSession.plates[1].plate_id),
      JSON.stringify(afterSession.instances));
const afterSlice = callJson('orc_get_slice_result', [], []);
check('reload does not restore derived slice result', afterSlice.ok === true && afterSlice.objects === 0
      && afterSlice.layers === 0 && afterSlice.metadata?.result_id === 0
      && afterSlice.metadata?.source_text?.available === false, JSON.stringify(afterSlice));

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
check('reject invalid project without disturbing the active session',
      invalid.ok !== true && afterInvalid.objects?.length === after.objects?.length
      && afterInvalid.objects?.[0]?.volumes?.length === afterObject?.volumes?.length,
      JSON.stringify({ invalid, objects: afterInvalid.objects?.length }));

if (failures) {
  console.error(`project round-trip failed: ${failures} check(s)`);
  process.exitCode = 1;
}
