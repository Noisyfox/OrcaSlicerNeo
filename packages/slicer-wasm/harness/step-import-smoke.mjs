import { fixtureProfileOptions } from './profile-installer.mjs';
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
const upstreamFixtureDir = resolve(repoRoot, 'packages/slicer-wasm/cpp/tests/data');
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
    const rawIndices = Module.HEAPU8.slice(Number(entry.index_ptr),
      Number(entry.index_ptr) + entry.index_count * Uint32Array.BYTES_PER_ELEMENT);
    const indices = new Uint32Array(rawIndices.buffer);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertices.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], vertices[i + axis]);
        max[axis] = Math.max(max[axis], vertices[i + axis]);
      }
    }
    const validIndices = indices.length % 3 === 0 && indices.every(index => index < entry.vertex_count);
    const edges = new Map();
    let area = 0;
    if (validIndices) for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = indices.subarray(i, i + 3);
      for (const [from, to] of [[a, b], [b, c], [c, a]]) {
        const key = from < to ? `${from}:${to}` : `${to}:${from}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
      const u = [0, 1, 2].map(axis => vertices[b * 3 + axis] - vertices[a * 3 + axis]);
      const v = [0, 1, 2].map(axis => vertices[c * 3 + axis] - vertices[a * 3 + axis]);
      area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0]) / 2;
    }
    summaries.push({ entry, min, max, validIndices, finiteVertices: vertices.every(Number.isFinite), area,
      openEdges: [...edges.values()].filter(count => count === 1).length,
      nonManifoldEdges: [...edges.values()].filter(count => count > 2).length });
    Module._free(Number(entry.vertex_ptr));
    Module._free(Number(entry.index_ptr));
  }
  return { response, summaries };
}

const near = (actual, expected, epsilon = 1e-2) => Math.abs(actual - expected) <= epsilon;
const init = callJson('orc_init', ['string'], [fixtureProfileOptions(Module)]);
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

// Reuse the pinned core's regression assets, with the same assertions as
// cpp/tests/libslic3r/test_step.cpp. The public bridge keeps compounds atomic;
// native split-compound=true coverage remains in the upstream test suite.
async function upstreamImport(name, bytes) {
  callJson('orc_clear_model', [], []);
  const imported = addModel(bytes ?? await readFile(resolve(upstreamFixtureDir, name)), 'step', name);
  const structure = callJson('orc_get_model_structure', [], []);
  const mesh = meshSummary();
  check(`${name} imports one named object`, imported.ok === true && imported.objects === 1 &&
    structure.objects?.length === 1 && structure.objects[0].name === name, JSON.stringify(imported));
  check(`${name} triangulates every part with finite indexed geometry`, mesh.response.ok === true &&
    mesh.summaries.length > 0 && mesh.summaries.length === structure.objects?.[0]?.volumes?.length &&
    mesh.summaries.every(summary => summary.entry.index_count > 0 && summary.validIndices &&
      summary.finiteVertices && Number.isFinite(summary.area) && summary.area > 0));
  return { object: structure.objects?.[0], summaries: mesh.summaries };
}
const cone = await upstreamImport('cone_tilted_seam_pcurve.step');
check('tilted cone seam remains closed after OCCT triangulation', cone.object?.volumes?.length === 1 &&
  cone.summaries.length === 1 && cone.summaries[0].openEdges === 0 && cone.summaries[0].nonManifoldEdges === 0,
JSON.stringify(cone.summaries.map(({ openEdges, nonManifoldEdges }) => ({ openEdges, nonManifoldEdges }))));
const surfaces = await upstreamImport('surface_model_geometric_set.step');
const surface = surfaces.summaries[0];
check('loose faces remain one part containing both 10 mm square planes', surfaces.object?.volumes?.length === 1 &&
  surfaces.summaries.length === 1 && near(surface.area, 200) &&
  surface.max.every((value, axis) => near(value - surface.min[axis], 10)),
JSON.stringify(surface && { min: surface.min, max: surface.max, area: surface.area }));

const namedBoxes = await readFile(resolve(upstreamFixtureDir, 'utf8_part_names.step'));
const expectedNames = ['pièce', 'Gehäuse', 'bracket'];
function checkNamedParts(label, imported) {
  check(`${label} preserves UTF-8 part names and ASCII control`,
    JSON.stringify(imported.object?.volumes?.map(volume => volume.name)) === JSON.stringify(expectedNames));
  check(`${label} retains three closed box meshes`, imported.summaries.length === 3 &&
    imported.summaries.every(summary => summary.openEdges === 0 && summary.nonManifoldEdges === 0));
}
checkNamedParts('solid import', await upstreamImport('utf8_part_names.step', namedBoxes));
// Exercise the shell-without-solid branch with exactly the same faces, units,
// and names. Only their STEP representation changes; no duplicate asset needed.
let shellCount = 0;
const namedShells = namedBoxes.toString('utf8')
  .replace(/MANIFOLD_SOLID_BREP\('([^']*)',\s*(#\d+)\)/g, (_match, name, shell) => {
    ++shellCount;
    return `SHELL_BASED_SURFACE_MODEL('${name}',(${shell}))`;
  }).replaceAll('ADVANCED_BREP_SHAPE_REPRESENTATION', 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION');
check('named shell fixture converts all three solid wrappers', shellCount === 3);
checkNamedParts('shell import', await upstreamImport('utf8-part-shells.step', Buffer.from(namedShells)));

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
const exported = exportGcode(callJson, { receipt: sliced.receipt, filenameBase: '' });
const gcode = validateGcode(Module.FS.readFile(exported.path));
check('valid STEP exports non-empty G-code', exported.ok === true && gcode.ok,
      JSON.stringify(gcode));

// A failed import after slicing must retain that result, too.
const beforeSlicedStructure = JSON.stringify(callJson('orc_get_model_structure', [], []));
const rejectedAfterSlice = addModel(malformed, 'stp', 'malformed-after-slice.stp');
const afterSlicedStructure = JSON.stringify(callJson('orc_get_model_structure', [], []));
const exportAfterReject = exportGcode(callJson, { receipt: sliced.receipt, filenameBase: '' });
const gcodeAfterReject = validateGcode(Module.FS.readFile(exportAfterReject.path));
check('malformed STEP leaves sliced scene and result unchanged',
      rejectedAfterSlice.ok !== true && afterSlicedStructure === beforeSlicedStructure
      && exportAfterReject.ok === true && gcodeAfterReject.ok,
      JSON.stringify({ rejectedAfterSlice, exportAfterReject, gcodeAfterReject }));

if (failures > 0) {
  console.error(`STEP import smoke failed: ${failures} check(s)`);
  process.exitCode = 1;
}
