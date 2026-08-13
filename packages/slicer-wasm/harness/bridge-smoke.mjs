// ----------------------------------------------------------------
// ------------ Bridge smoke: drive orc_* exports directly --------
// ----------------------------------------------------------------
// Loads the built module and exercises every bridge function end to end:
// init -> presets -> metadata -> load model -> slice (with progress) ->
// slice result -> export gcode -> cancel. The 3D-preview buffers are M2.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { argv } from 'node:process';
import { validateGcode } from './run-slice.mjs';

const [modulePath, stlPath] = argv.slice(2);
if (!modulePath || !stlPath) {
  console.error('usage: node bridge-smoke.mjs <out/orca_slice.js> <cube.stl>');
  process.exit(2);
}

const factory = (await import(pathToFileURL(modulePath).href)).default;
const Module = await factory({ noInitialRun: true, print: console.error, printErr: console.error });

// wasm64: pointer-bearing arguments must be typed 'pointer' — Emscripten 6's
// ccall toC converts them to the BigInt the raw i64 wasm param requires
// (plain 'number' passes the Number through unwrapped and the wasm call
// throws "Cannot convert <ptr> to a BigInt"). i32 args (lengths, enum
// values) stay 'number'; string args are auto-converted.
// Heap pointers keep their Number form on the JS side (_malloc/_free are
// wrapped to return/accept Numbers; HEAPU8.set needs a Number offset).
function callJson(name, argTypes, args) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  const s = Module.UTF8ToString(ptr);
  Module._free(ptr);
  return JSON.parse(s);
}

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

// 1. init (embedded curated presets)
const init = callJson('orc_init', [], []);
check('orc_init ok', init.ok === true, JSON.stringify(init));
check('init has printers', init.printers > 0, `printers=${init.printers}`);

// 2. presets
const printers = callJson('orc_get_presets', ['string'], ['printer']);
check('orc_get_presets(printer)', Array.isArray(printers.presets) && printers.presets.length > 0,
      `count=${printers.presets?.length}`);
const prints = callJson('orc_get_presets', ['string'], ['print']);
check('orc_get_presets(print)', Array.isArray(prints.presets) && prints.presets.length > 0,
      `count=${prints.presets?.length}`);

// 3. option metadata
const meta = callJson('orc_get_option_metadata', [], []);
check('orc_get_option_metadata has layer_height',
      meta.layer_height?.type === 'float', JSON.stringify(meta.layer_height));
// Drift at the pinned SHA: the infill-pattern option is sparse_infill_pattern
// (PrintConfig.cpp:3410) — there is no fill_pattern key (renamed upstream);
// orc_get_option_metadata reflects the pinned names.
check('metadata has sparse_infill_pattern enum', Array.isArray(meta.sparse_infill_pattern?.enum_values));

// 4. load model (bytes via the heap)
const stl = await readFile(stlPath);
const dataPtr = Number(Module._malloc(stl.length));
Module.HEAPU8.set(stl, dataPtr);
const loaded = callJson('orc_load_model', ['pointer', 'number', 'string'],
                        [dataPtr, stl.length, 'stl']);
Module._free(dataPtr);
check('orc_load_model ok', loaded.ok === true && loaded.objects > 0, JSON.stringify(loaded));

// 5. progress callback (wasm function table, ALLOW_TABLE_GROWTH)
// wasm64: the bridge's progress_fn is void(*)(int, const char*) = (i32, i64)
// in wasm signatures — the pointer param must be 'j', so the addFunction
// signature is 'vij' (a 'vii' entry mismatches the call site and the
// call_indirect traps with "null function or function signature mismatch").
let progressCalls = 0;
let progressText = '';
const cb = Module.addFunction((percent, text) => {
  progressCalls++;
  // wasm64: the text pointer arrives as a BigInt — UTF8ToString(text) would
  // throw; Number() gives the heap address (Fix round 1).
  progressText = Module.UTF8ToString(Number(text));
}, 'vij');
Module.ccall('orc_set_progress_callback', null, ['pointer'], [cb]);

// 6. slice (config mirroring fixtures/config.ini, as JSON)
const configJson = {
  // Drift at the pinned SHA: the layer-G-code option is layer_change_gcode
  // (not layer_gcode); relative-E marlin requires the "G92 E0" reset here or
  // Print::validate rejects the config (fixtures/config.json uses the same).
  layer_change_gcode: 'G92 E0',
  layer_height: 0.2, first_layer_height: 0.2, nozzle_diameter: 0.4,
  filament_diameter: 1.75, temperature: 210, first_layer_temperature: 215,
  bed_temperature: 60, first_layer_bed_temperature: 60,
  bed_shape: '0x0,220x0,220x220,0x220',
  perimeters: 2, top_solid_layers: 3, bottom_solid_layers: 3,
  fill_density: '15%', sparse_infill_pattern: 'grid',
  perimeter_speed: 60, infill_speed: 80, travel_speed: 150,
  gcode_flavor: 'marlin',
  start_gcode: 'G28\\nG1 Z5 F5000', end_gcode: 'M104 S0\\nM140 S0\\nG28 X0\\nM84',
};
const sliced = callJson('orc_slice', ['string'], [JSON.stringify(configJson)]);
check('orc_slice ok', sliced.ok === true, JSON.stringify(sliced));
check('progress fired', progressCalls > 0, `calls=${progressCalls}`);
check('progress text arrives', progressText.length > 0, `text="${progressText.slice(0, 40)}"`);
// Fix round 1: the bridge's g_progress is a raw fn ptr with no orc_* clear
// path — removeFunction nulls the wasm table slot but g_progress would still
// hold the stale index, and a re-slice that re-runs process() would call_indirect
// the nulled slot and trap (a wasm trap is NOT catchable by the C++ try/catch —
// the module dies). Clear it via the API first (the status lambda guards
// if (g_progress), so nullptr just disables the callback).
Module.ccall('orc_set_progress_callback', null, ['pointer'], [0]);
Module.removeFunction(cb);

// 7. slice result stats
const result = callJson('orc_get_slice_result', [], []);
check('orc_get_slice_result layers > 0', result.ok === true && result.layers > 0,
      JSON.stringify(result));

// 8. export gcode (MEMFS) + validate
const exported = callJson('orc_export_gcode', [], []);
check('orc_export_gcode ok', exported.ok === true, JSON.stringify(exported));
const gcode = validateGcode(Module.FS.readFile('/out.gcode'));
check('gcode valid', gcode.ok, JSON.stringify(gcode));

// 9. cancel is safe
const cancelled = callJson('orc_cancel', [], []);
check('orc_cancel ok', cancelled.ok === true, JSON.stringify(cancelled));

// Fix-round-1 repro: re-slice after removeFunction. A stale g_progress used to
// trap inside the status lambda during process() ("null function or function
// signature mismatch"). A re-slice with the SAME model/config short-circuits
// (apply/process no-op, no callbacks) — which is how the bug used to hide — so
// load the model again (fresh Model => apply sees changes => process re-runs)
// AND change layer_height so the layer count provably differs from the first
// slice, proving the re-slice actually re-sliced instead of short-circuiting.
const stl2 = await readFile(stlPath);
const dataPtr2 = Number(Module._malloc(stl2.length));
Module.HEAPU8.set(stl2, dataPtr2);
const reloaded = callJson('orc_load_model', ['pointer', 'number', 'string'],
                          [dataPtr2, stl2.length, 'stl']);
Module._free(dataPtr2);
check('reload after removeFunction ok', reloaded.ok === true, JSON.stringify(reloaded));
const resliced = callJson('orc_slice', ['string'],
                          [JSON.stringify({ ...configJson, layer_height: 0.25 })]);
check('re-slice after removeFunction ok', resliced.ok === true, JSON.stringify(resliced));
const result2 = callJson('orc_get_slice_result', [], []);
check('re-slice actually re-ran', result2.ok === true && result2.layers > 0 && result2.layers !== result.layers,
      `layers=${result2.layers} (first slice: ${result.layers})`);

process.exit(failures === 0 ? 0 : 1);
