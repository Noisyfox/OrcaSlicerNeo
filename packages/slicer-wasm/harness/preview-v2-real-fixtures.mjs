// Preview v2 B4 real-fixture evidence runner.
//
// This runner intentionally reports bridge output instead of retaining G-code
// or screenshots. It installs the repository profile packages, slices one
// named fixture through the real WASM bridge, and records the observable
// counts/categories needed by the B4 manifest. It never edits the C++
// submodule and does not use a mock module.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';

const options = {};
for (let i = 2; i < argv.length; i += 2) {
  const key = argv[i]?.replace(/^--/, '');
  if (key) options[key] = argv[i + 1];
}

const root = resolve(import.meta.dirname, '..');
const modulePath = resolve(options.module ?? `${root}/out/serial/orca_slice.js`);
const fixture = options.fixture ?? 'feature-rich-single-material';
const fixtureRoot = resolve(root, 'fixtures/preview-v2');
const fixtureDefinitions = {
  'feature-rich-single-material': {
    model: resolve(root, 'fixtures/cube.stl'),
    config: resolve(fixtureRoot, 'feature-rich-single-material.config.json'),
    printer: 'Bambu Lab P1P 0.4 nozzle',
    // The native bridge has no plater placement service. Match the established
    // P1P smoke fixture's explicit centre placement on its 256 mm bed.
    offset: [128, 128, 10],
  },
};
const definition = fixtureDefinitions[fixture];
if (!definition) {
  throw new Error(`fixture is not runnable by this bridge: ${fixture}`);
}

const config = JSON.parse(await readFile(definition.config, 'utf8'));
const model = await readFile(definition.model);
const profileRoot = resolve(root, '../profile-resources/dist');
const factory = await loadModuleFactory(modulePath);
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));

function callJson(name, argTypes, args) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  const text = Module.UTF8ToString(ptr);
  Module._free(ptr);
  return JSON.parse(text);
}

function readArray(ptr, Constructor, length) {
  if (!ptr || length <= 0) return new Constructor(0);
  const bytes = Constructor.BYTES_PER_ELEMENT * length;
  const result = new Constructor(Module.HEAPU8.buffer.slice(Number(ptr), Number(ptr) + bytes));
  Module._free(Number(ptr));
  return result;
}

function freeArray(ptr) {
  if (ptr) Module._free(Number(ptr));
}

const init = callJson('orc_init', ['string'], ['']);
if (!init.ok) throw new Error(`orc_init failed: ${JSON.stringify(init)}`);
const selected = callJson('orc_select_preset', ['string', 'string'], ['printer', definition.printer]);
if (!selected.ok || selected.printer?.name !== definition.printer) {
  throw new Error(`printer selection failed: ${JSON.stringify(selected)}`);
}

const modelPtr = Number(Module._malloc(model.length));
Module.HEAPU8.set(model, modelPtr);
const loaded = callJson(
  'orc_add_model',
  ['pointer', 'number', 'string', 'string'],
  [modelPtr, model.length, 'stl', 'preview-v2-real-fixture.stl'],
);
Module._free(modelPtr);
if (!loaded.ok) throw new Error(`model load failed: ${JSON.stringify(loaded)}`);

const positioned = callJson(
  'orc_set_instance_offset',
  ['number', 'number', 'number', 'number', 'number'],
  [0, 0, definition.offset[0], definition.offset[1], definition.offset[2]],
);
if (!positioned.ok) throw new Error(`model placement failed: ${JSON.stringify(positioned)}`);

const sliced = callJson('orc_slice', ['string'], [JSON.stringify(config)]);
if (!sliced.ok) throw new Error(`slice failed: ${JSON.stringify(sliced)}`);
const result = callJson('orc_get_slice_result', [], []);
if (!result.ok || result.preview_version !== 2) {
  throw new Error(`preview result failed: ${JSON.stringify(result)}`);
}

const toolpath = result.toolpath ?? {};
const count = Number(toolpath.segment_count ?? 0);
const roles = readArray(toolpath.extrusion_role_ptr, Uint16Array, count);
const moveTypes = readArray(toolpath.move_type_ptr, Uint8Array, count);
const extruders = readArray(toolpath.extruder_id_ptr, Uint8Array, count);
const colorPrints = readArray(toolpath.color_print_id_ptr, Uint8Array, count);
readArray(toolpath.starts_ptr, Float32Array, count * 3);
readArray(toolpath.ends_ptr, Float32Array, count * 3);
readArray(toolpath.layer_id_ptr, Uint32Array, count);
readArray(toolpath.move_order_ptr, Uint32Array, count);
readArray(toolpath.gcode_id_ptr, Uint32Array, count);
readArray(toolpath.width_ptr, Float32Array, count);
readArray(toolpath.height_ptr, Float32Array, count);
for (const metric of Object.values(toolpath.metrics ?? {})) freeArray(metric.ptr);

const gcode = Module.FS.readFile('/out.gcode');
const gcodeLines = Buffer.from(gcode).toString('utf8').split('\n').length;
const unique = (values) => [...new Set(values)].sort((a, b) => a - b);
console.log(JSON.stringify({
  fixture,
  module: modulePath,
  profile: definition.printer,
  source: definition.model,
  config: definition.config,
  result: {
    commands: gcodeLines,
    segments: count,
    layers: result.layers,
    featureRoles: unique(roles),
    moveTypes: unique(moveTypes),
    extruders: unique(extruders),
    colorPrints: unique(colorPrints),
    featurePalette: result.metadata?.feature_palette ?? [],
  },
}, null, 2));
