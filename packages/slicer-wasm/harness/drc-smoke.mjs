// ----------------------------------------------------------------
// -------- DRC bridge smoke: native Draco → Model → G-code -------
// ----------------------------------------------------------------
// This deliberately uses the real C++ bridge and its upstream DRC loader.
// It is not a JavaScript Draco decoder test: the bytes cross the WASM heap,
// are staged in MEMFS, and libslic3r/Format/DRC.cpp decodes them.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory, validateGcode } from './run-slice.mjs';

const [moduleArg, fixtureDirArg, profileRootArg] = argv.slice(2);
if (!moduleArg || !fixtureDirArg) {
  console.error('usage: node drc-smoke.mjs <out/orca_slice.js> <fixtures/drc> [profile-package-root]');
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

function nearly(actual, expected, epsilon = 1e-3) {
  return Math.abs(actual - expected) <= epsilon;
}

async function fixture(name) {
  return readFile(resolve(fixtureDir, name));
}

function addDrc(bytes, displayName) {
  const ptr = Number(Module._malloc(bytes.length));
  try {
    Module.HEAPU8.set(bytes, ptr);
    return callJson('orc_add_model', ['pointer', 'number', 'string', 'string'],
                    [ptr, bytes.length, 'drc', displayName]);
  } finally {
    Module._free(ptr);
  }
}

function meshSummary() {
  const mesh = callJson('orc_get_model_mesh', [], []);
  if (!mesh.ok || mesh.objects?.length !== 1) return { mesh };
  const object = mesh.objects[0];
  try {
    const raw = Module.HEAPU8.slice(Number(object.vertex_ptr),
      Number(object.vertex_ptr) + object.vertex_count * 3 * Float32Array.BYTES_PER_ELEMENT);
    const vertices = new Float32Array(raw.buffer);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertices.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], vertices[i + axis]);
        max[axis] = Math.max(max[axis], vertices[i + axis]);
      }
    }
    return { object, min, max };
  } finally {
    Module._free(Number(object.vertex_ptr));
    Module._free(Number(object.index_ptr));
  }
}

const init = callJson('orc_init', ['string'], ['']);
check('orc_init succeeds', init.ok === true, JSON.stringify(init));
const presetSnapshot = callJson('orc_get_preset_snapshot', [], []);
const plateSnapshot = callJson('orc_get_plate_session_snapshot', [], []);
const printableArea = presetSnapshot.printable_area ?? [];
const areaBounds = printableArea.reduce((bounds, point) => ({
  minX: Math.min(bounds.minX, point[0]), maxX: Math.max(bounds.maxX, point[0]),
  minY: Math.min(bounds.minY, point[1]), maxY: Math.max(bounds.maxY, point[1]),
}), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
const selectedPlate = plateSnapshot.plates?.find((plate) =>
  plate.plate_id === plateSnapshot.current_plate_id);
const selectedPlateWorldCenter = [
  selectedPlate.origin[0] + (areaBounds.minX + areaBounds.maxX) * 0.5,
  selectedPlate.origin[1] + (areaBounds.minY + areaBounds.maxY) * 0.5,
];

// Each sample is an official Google Draco v1.5.7 triangular mesh.  The exact
// local bounding box deliberately proves the loader retained the source axes
// and coordinates before the shared Plater-style centering/bed placement.
const meshes = [
  {
    name: 'cube_att.drc', vertices: 8, indices: 36,
    min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5],
  },
  {
    name: 'test_nm.obj.edgebreaker.cl4.2.2.drc', vertices: 99, indices: 510,
    min: [-1, -0.8535534, -1], max: [1, 0.8535534, 1],
  },
  {
    name: 'test_nm.obj.sequential.cl3.2.2.drc', vertices: 97, indices: 510,
    min: [-1, -0.8535534, -1], max: [1, 0.8535534, 1],
  },
];

for (const expected of meshes) {
  callJson('orc_clear_model', [], []);
  const added = addDrc(await fixture(expected.name), expected.name);
  check(`${expected.name}: imports as one object and instance`,
        added.ok === true && added.objects === 1 && Array.isArray(added.instances)
        && added.instances.length === 1, JSON.stringify(added));
  const structure = callJson('orc_get_model_structure', [], []);
  check(`${expected.name}: selected filename becomes the object name`,
        structure.ok === true && structure.objects?.[0]?.name === expected.name
        && structure.objects[0]?.volumes?.length === 1, JSON.stringify(structure.objects?.[0]));
  const summary = meshSummary();
  check(`${expected.name}: expected topology`,
        summary.object?.vertex_count === expected.vertices && summary.object?.index_count === expected.indices,
        JSON.stringify(summary.object && { vertices: summary.object.vertex_count, indices: summary.object.index_count }));
  check(`${expected.name}: local bounding box is preserved`,
        summary.min?.every((value, axis) => nearly(value, expected.min[axis]))
        && summary.max?.every((value, axis) => nearly(value, expected.max[axis])),
        JSON.stringify({ min: summary.min, max: summary.max }));
  check(`${expected.name}: centered and resting on the bed`,
        summary.object && nearly(summary.object.offset[0], selectedPlateWorldCenter[0])
        && nearly(summary.object.offset[1], selectedPlateWorldCenter[1])
        && nearly(summary.min[2] + summary.object.offset[2], 0),
        JSON.stringify({ minZ: summary.min?.[2], offset: summary.object?.offset,
          expectedXY: selectedPlateWorldCenter }));
}

// Appending follows the existing STL semantics; a second successful import
// never replaces the current scene.
callJson('orc_clear_model', [], []);
const cube = await fixture('cube_att.drc');
const first = addDrc(cube, 'first.drc');
const second = addDrc(cube, 'second.drc');
check('DRC imports append to the current plate',
      first.ok === true && second.ok === true && second.objects === 2
      && Array.isArray(second.instances) && second.instances.length === 2,
      JSON.stringify(second));

// The documented supported failure modes must be atomic: leave both the
// pre-existing object and its stale slice/result state untouched on failure.
callJson('orc_clear_model', [], []);
addDrc(cube, 'stable.drc');
const before = callJson('orc_get_model_structure', [], []);
const pointCloud = addDrc(await fixture('cube_pc.drc'), 'cube_pc.drc');
const afterPointCloud = callJson('orc_get_model_structure', [], []);
check('point clouds are rejected atomically',
      !pointCloud.ok && afterPointCloud.ok === true
      && afterPointCloud.objects?.length === 1 && afterPointCloud.objects[0]?.name === 'stable.drc',
      JSON.stringify({ pointCloud, afterPointCloud }));
const corrupt = addDrc(cube.subarray(0, cube.length - 20), 'truncated.drc');
const afterCorrupt = callJson('orc_get_model_structure', [], []);
check('truncated DRC input is rejected atomically',
      !corrupt.ok && afterCorrupt.ok === true
      && afterCorrupt.objects?.length === 1 && afterCorrupt.objects[0]?.name === before.objects?.[0]?.name,
      JSON.stringify({ corrupt, afterCorrupt }));

// A small real DRC mesh must traverse the complete bridge slice/export path.
callJson('orc_clear_model', [], []);
const sliceInput = addDrc(await fixture('test_nm.obj.edgebreaker.cl4.2.2.drc'), 'slice.drc');
const config = {
  layer_change_gcode: 'G92 E0',
  layer_height: 0.2, initial_layer_print_height: 0.2,
  nozzle_diameter: 0.4, filament_diameter: 1.75,
  nozzle_temperature: 210, nozzle_temperature_initial_layer: 215,
  hot_plate_temp_initial_layer: 60,
  printable_area: '0x0,220x0,220x220,0x220',
  wall_loops: 2, top_shell_layers: 3, bottom_shell_layers: 3,
  sparse_infill_density: '15%', sparse_infill_pattern: 'grid',
  outer_wall_speed: 60, sparse_infill_speed: 80, travel_speed: 150,
  gcode_flavor: 'marlin',
  machine_start_gcode: 'G28\\nG1 Z5 F5000',
  machine_end_gcode: 'M104 S0\\nM140 S0\\nG28 X0\\nM84',
};
const sliced = callJson('orc_slice', ['string'], [JSON.stringify(config)]);
check('DRC model slices successfully', sliceInput.ok === true && sliced.ok === true, JSON.stringify(sliced));
if (sliced.ok) {
  const exported = callJson('orc_export_gcode', [], []);
  const gcode = validateGcode(Module.FS.readFile('/out.gcode'));
  check('DRC model exports non-empty G-code', exported.ok === true && gcode.ok, JSON.stringify(gcode));
}

if (failures > 0) {
  console.error(`DRC smoke failed: ${failures} check(s)`);
  process.exitCode = 1;
}
