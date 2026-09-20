// Real-WASM configuration-scope regression.
//
// A project/global override and a plate-local override deliberately disagree
// on layer_height. The native bridge must compose the project scope first and
// the plate scope last, both before and after a BBS 3MF save/load round-trip.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let i = 2; i < argv.length; i += 2) opts[argv[i]?.replace(/^--/, '')] = argv[i + 1];
const modulePath = opts.module ?? argv[2];
if (!modulePath) {
  console.error('usage: node config-overlay-precedence-smoke.mjs --module out/orca_slice.js');
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const factory = await loadModuleFactory(modulePath);
const Module = await factory({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(repoRoot, 'packages/profile-resources/dist')));

function callJson(name, argTypes = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
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

requireOk('set project override', callJson('orc_set_project_config_override',
  ['string', 'string', 'string', 'string'], ['project', '', 'layer_height', '0.24']));
requireOk('set project Prepare override', callJson('orc_set_project_config_override',
  ['string', 'string', 'string', 'string'], ['project', '', 'enable_prime_tower', '1']));
requireOk('set project Prepare mode', callJson('orc_set_project_config_override',
  ['string', 'string', 'string', 'string'], ['project', '', 'timelapse_type', '1']));
session = requireOk('plate session after project override', callJson('orc_get_plate_session_snapshot'));
const revisionAfterProject = session.input_revisions[plateId];
requireOk('set plate override', callJson('orc_set_project_config_override',
  ['string', 'string', 'string', 'string'], ['plate', plateId, 'layer_height', '0.16']));
requireOk('set plate Prepare mode', callJson('orc_set_project_config_override',
  ['string', 'string', 'string', 'string'], ['plate', plateId, 'timelapse_type', '0']));
session = requireOk('plate session after plate override', callJson('orc_get_plate_session_snapshot'));
const revision = session.input_revisions[plateId];
if (!(revision > revisionAfterProject))
  throw new Error(`plate override did not advance the target revision: ${JSON.stringify(session)}`);

let overlay = requireOk('read overlay', callJson('orc_get_project_config_overlay')).overlay;
if (overlay.project?.layer_height !== '0.24' ||
    !Object.values(overlay.plates ?? {}).some((values) => values?.layer_height === '0.16'))
  throw new Error(`conflicting project/plate overrides were not retained: ${JSON.stringify(overlay)}`);

function prepareProjectionForPlate(expectedPlateId) {
  const projection = requireOk('Prepare projection', callJson('orc_get_prime_tower_projection'));
  const plate = projection.plates?.find((candidate) => candidate.plate_id === expectedPlateId);
  if (!plate || plate.forced !== false)
    throw new Error(`plate override did not win in Prepare effective config: ${JSON.stringify(projection)}`);
  return plate;
}

const firstPrepare = prepareProjectionForPlate(plateId);

let sliced = await callAsyncTask(callJson, 'orc_slice_plate',
  ['string', 'string', 'number'], ['{}', plateId, revision]);
requireOk('slice before round-trip', sliced);
let first = firstExportedLayerSteps(sliced.receipt);
if (Math.abs(first.steps[0] - 0.16) >= 0.005)
  throw new Error(`plate override did not win before round-trip: ${JSON.stringify(first.steps)}`);

const exportedProject = requireOk('export project', callJson('orc_export_project'));
const projectBytes = readAndFree(exportedProject.bytes_ptr, exportedProject.bytes_length);
requireOk('clear model', callJson('orc_clear_model'));
const projectPtr = writeBytes(projectBytes);
const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
  [projectPtr, projectBytes.byteLength, 0, 'config-overlay-precedence.3mf']);
Module._free(projectPtr);
requireOk('reload project', loaded);

overlay = requireOk('read round-tripped overlay', callJson('orc_get_project_config_overlay')).overlay;
if (overlay.project?.layer_height !== '0.24' ||
    !Object.values(overlay.plates ?? {}).some((values) => values?.layer_height === '0.16'))
  throw new Error(`conflicting overrides did not round-trip: ${JSON.stringify(overlay)}`);

session = requireOk('round-tripped plate session', callJson('orc_get_plate_session_snapshot'));
const reloadedPlate = session.current_plate_id;
const secondPrepare = prepareProjectionForPlate(reloadedPlate);
const reloadedRevision = session.input_revisions[reloadedPlate];
sliced = await callAsyncTask(callJson, 'orc_slice_plate',
  ['string', 'string', 'number'], ['{}', reloadedPlate, reloadedRevision]);
requireOk('slice after round-trip', sliced);
const second = firstExportedLayerSteps(sliced.receipt);
if (Math.abs(second.steps[0] - 0.16) >= 0.005)
  throw new Error(`plate override did not win after round-trip: ${JSON.stringify(second.steps)}`);

console.log(JSON.stringify({
  ok: true,
  projectLayerHeight: overlay.project.layer_height,
  plateLayerHeight: '0.16',
  beforeRoundTripSteps: first.steps,
  afterRoundTripSteps: second.steps,
  beforeRoundTripPrepareForced: firstPrepare.forced,
  afterRoundTripPrepareForced: secondPrepare.forced,
  loadedMode: loaded.mode,
}));
