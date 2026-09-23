// ----------------------------------------------------------------
// -------- Native STEP bridge smoke: import, atomicity, and slice ---
// ----------------------------------------------------------------
// This harness drives the real C++ bridge through a wasm64 module. It is
// intentionally host-neutral so the same assertions run against serial and
// threaded artifacts.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';
import { loadModuleFactory, validateGcode } from './run-slice.mjs';

const [moduleArg, fixtureDirArg, profileRootArg] = argv.slice(2);
if (!moduleArg || !fixtureDirArg) {
  console.error('usage: node step-import-smoke.mjs <out/orca_slice.js> <fixtures/step> [profile-package-root]');
  process.exit(2);
}

const fixtureDir = resolve(fixtureDirArg);
const repoRoot = resolve(import.meta.dirname, '../../..');
const profileRoot = resolve(profileRootArg ?? `${repoRoot}/packages/profile-resources/dist`);
const factory = await loadModuleFactory(moduleArg);
const Module = await factory({ noInitialRun: true, print: console.error, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));

function callJson(name, argTypes, args) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  const text = Module.UTF8ToString(ptr);
  Module._free(ptr);
  return JSON.parse(text);
}

let failures = 0;
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

async function fixture(name) {
  return readFile(resolve(fixtureDir, name));
}

function addModel(bytes, ext, filename) {
  const ptr = Number(Module._malloc(bytes.length));
  try {
    Module.HEAPU8.set(bytes, ptr);
    return callJson('orc_add_model', ['pointer', 'number', 'string', 'string'],
                    [ptr, bytes.length, ext, filename]);
  } finally {
    Module._free(ptr);
  }
}

function meshSummary() {
  const response = callJson('orc_get_model_mesh', [], []);
  const summaries = [];
  if (!response.ok) return { response, summaries };
  for (const geometry of response.geometries ?? []) {
    const entry = { ...response.renderables.find((item) => item.volume_id === geometry.volume_id), ...geometry };
    const raw = Module.HEAPU8.slice(Number(entry.vertex_ptr),
      Number(entry.vertex_ptr) + entry.vertex_count * 3 * Float32Array.BYTES_PER_ELEMENT);
    const vertices = new Float32Array(raw.buffer);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertices.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], vertices[i + axis]);
        max[axis] = Math.max(max[axis], vertices[i + axis]);
      }
    }
    summaries.push({ entry, min, max });
    Module._free(Number(entry.vertex_ptr));
    Module._free(Number(entry.index_ptr));
  }
  return { response, summaries };
}

const near = (actual, expected, epsilon = 1e-2) => Math.abs(actual - expected) <= epsilon;
const init = callJson('orc_init', ['string'], ['{"log_level":"error"}']);
check('orc_init succeeds', init.ok === true, JSON.stringify(init));

const step = await fixture('step-box-20mm.step');
const malformed = await fixture('malformed.step');

// A valid .step import projects its selected filename and native solid name,
// keeps the source units in millimetres, and returns non-empty triangulation.
callJson('orc_clear_model', [], []);
const first = addModel(step, 'step', 'step-box-20mm.step');
check('.step imports one object and instance',
      first.ok === true && first.objects === 1 && first.instances === 1, JSON.stringify(first));
const firstStructure = callJson('orc_get_model_structure', [], []);
const firstObject = firstStructure.objects?.[0];
check('.step uses the selected filename as object name',
      firstStructure.ok === true && firstObject?.name === 'step-box-20mm.step',
      JSON.stringify(firstObject));
check('.step preserves the native solid name as volume name',
      firstObject?.volumes?.length === 1 && firstObject.volumes[0].name === 'Body1',
      JSON.stringify(firstObject?.volumes));
const firstMesh = meshSummary();
const firstSummary = firstMesh.summaries.find((item) => item.entry.object_idx === 0);
const firstDimensions = firstSummary && firstSummary.max.map((value, axis) => value - firstSummary.min[axis]);
check('.step produces non-empty native geometry',
      firstSummary?.entry.vertex_count > 0 && firstSummary?.entry.index_count > 0,
      JSON.stringify(firstSummary?.entry));
check('.step source dimensions remain 20 mm on every axis',
      firstDimensions?.every((value) => near(value, 20)), JSON.stringify(firstDimensions));

// The .stp spelling follows the same path and appends instead of replacing.
const second = addModel(step, 'stp', 'second.stp');
const appendedStructure = callJson('orc_get_model_structure', [], []);
check('.stp imports through the STEP path and appends',
      second.ok === true && second.objects === 2 && appendedStructure.objects?.length === 2
      && appendedStructure.objects[1]?.name === 'second.stp',
      JSON.stringify({ second, objects: appendedStructure.objects?.map((o) => o.name) }));

// A malformed STEP must fail before the live model or an existing slice result
// is touched. This check captures the complete stable-ID structure as well as
// exportability after a later successful slice.
const beforeMalformed = JSON.stringify(callJson('orc_get_model_structure', [], []));
const rejected = addModel(malformed, 'step', 'malformed.step');
const afterMalformed = JSON.stringify(callJson('orc_get_model_structure', [], []));
check('malformed STEP is rejected atomically',
      rejected.ok !== true && afterMalformed === beforeMalformed,
      JSON.stringify({ rejected, beforeMalformed, afterMalformed }));

// Slice one valid STEP object through the same bridge path used by the app.
callJson('orc_clear_model', [], []);
const sliceInput = addModel(step, 'stp', 'slice-box.stp');
const config = {
  layer_change_gcode: 'G92 E0',
  layer_height: 0.2, initial_layer_print_height: 0.2,
  nozzle_diameter: 0.4, filament_diameter: 1.75,
  nozzle_temperature: 210, nozzle_temperature_initial_layer: 215,
  hot_plate_temp_initial_layer: 60, bed_temperature: 60,
  wall_loops: 2, top_shell_layers: 3, bottom_shell_layers: 3,
  sparse_infill_density: '15%', sparse_infill_pattern: 'grid',
  outer_wall_speed: 60, sparse_infill_speed: 80, travel_speed: 150,
  gcode_flavor: 'marlin',
  machine_start_gcode: 'G28\\nG1 Z5 F5000',
  machine_end_gcode: 'M104 S0\\nM140 S0\\nG28 X0\\nM84',
};
const sliced = await callAsyncTask(callJson, 'orc_slice', ['string'], [JSON.stringify(config)]);
check('valid STEP slices successfully', sliceInput.ok === true && sliced.ok === true,
      JSON.stringify(sliced));
const exported = exportGcode(callJson, sliced.receipt);
const gcode = validateGcode(Module.FS.readFile(exported.path));
check('valid STEP exports non-empty G-code', exported.ok === true && gcode.ok,
      JSON.stringify(gcode));

// A failed import after slicing must retain that result, too.
const beforeSlicedStructure = JSON.stringify(callJson('orc_get_model_structure', [], []));
const rejectedAfterSlice = addModel(malformed, 'stp', 'malformed-after-slice.stp');
const afterSlicedStructure = JSON.stringify(callJson('orc_get_model_structure', [], []));
const exportAfterReject = exportGcode(callJson, sliced.receipt);
const gcodeAfterReject = validateGcode(Module.FS.readFile(exportAfterReject.path));
check('malformed STEP leaves sliced scene and result unchanged',
      rejectedAfterSlice.ok !== true && afterSlicedStructure === beforeSlicedStructure
      && exportAfterReject.ok === true && gcodeAfterReject.ok,
      JSON.stringify({ rejectedAfterSlice, exportAfterReject, gcodeAfterReject }));

if (failures > 0) {
  console.error(`STEP import smoke failed: ${failures} check(s)`);
  process.exitCode = 1;
}
