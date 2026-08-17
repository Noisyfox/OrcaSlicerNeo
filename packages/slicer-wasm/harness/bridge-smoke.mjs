// ----------------------------------------------------------------
// ------------ Bridge smoke: drive orc_* exports directly --------
// ----------------------------------------------------------------
// Loads the built module and exercises every bridge function end to end:
// init -> presets -> metadata -> load model -> slice (with progress) ->
// slice result -> export gcode -> cancel. The 3D-preview buffers are M2.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';
import { loadModuleFactory, validateGcode } from './run-slice.mjs';

const [moduleArg, stlArg] = argv.slice(2);
if (!moduleArg || !stlArg) {
  console.error('usage: node bridge-smoke.mjs <out/orca_slice.js> <cube.stl>');
  process.exit(2);
}

// loadModuleFactory chdirs into the module's dir (Emscripten resolves the
// .data preload bundle from CWD); paths are absolutized first (resolve()
// after the chdir would root them at the module dir).
const stlPath = resolve(stlArg);
const boxStlPath = resolve(dirname(stlPath), 'floating-box.stl');
const factory = await loadModuleFactory(moduleArg);
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

// 1. init (full preset bundle; fresh config = all installed)
// wasm64: every C param needs a value — orc_init's app_config_json arg
// gets an empty string (null-ish → fresh config), never zero args
// (undefined → BigInt conversion TypeError in the wasm64 wrapper).
const init = callJson('orc_init', ['string'], ['']);
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

// 4b. load-time centering (OrcaSlicer Plater behavior, replicated in the
// bridge because the GUI is not compiled into the WASM build): non-project
// loads center each object's mesh around the origin and rest it on the bed
// (Plater.cpp _load_files: center_around_origin + ensure_on_bed per object).
// cube.stl spans [0,20]^3 — after load the exported LOCAL vertices must be
// centered (bbox center ≈ origin, i.e. [-10,10]^3) with the bed drop carried
// by the instance offset (Z = half height, XY = 0), so the rendered world
// min Z is 0. Regression: vertices used to keep the raw STL coordinates
// (cube at [0,20]^3, offset 0) and the renderer showed the model wherever
// the file's own origin was.
{
  const mm = callJson('orc_get_model_mesh', [], []);
  if (mm.ok && mm.objects?.length === 1) {
    const o = mm.objects[0];
    const verts = new Float32Array(readBytes(Module, Number(o.vertex_ptr), o.vertex_count * 3 * 4).buffer);
    Module._free(Number(o.index_ptr));
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < verts.length; i += 3)
      for (let a = 0; a < 3; a++) {
        if (verts[i + a] < min[a]) min[a] = verts[i + a];
        if (verts[i + a] > max[a]) max[a] = verts[i + a];
      }
    const center = [0, 1, 2].map((a) => (min[a] + max[a]) / 2);
    const near = (v, e) => Math.abs(v - e) < 1e-3;
    check('load-time centering: local bbox center at origin',
          center.every((c) => near(c, 0)), `center=[${center}]`);
    check('load-time centering: bed drop carried by instance offset',
          near(o.offset[0], 0) && near(o.offset[1], 0) && near(o.offset[2], (max[2] - min[2]) / 2),
          `offset=[${o.offset}] height=${(max[2] - min[2]).toFixed(3)}`);
    check('load-time centering: renders resting on the bed (world min Z = 0)',
          near(min[2] + o.offset[2], 0), `minZ=${min[2]} offsetZ=${o.offset[2]}`);
  } else {
    check('load-time centering: mesh available', false, JSON.stringify(mm).slice(0, 120));
  }
}

// Copy [ptr, ptr+len) out of the heap and free it — mirrors the client's
// heap.ts readBytes contract. wasm64: the module exports ONLY HEAPU8
// (EXPORTED_RUNTIME_METHODS), so Module.HEAPF32/HEAPU32 are undefined — the
// float/uint views must be derived from the exported byte view (verified
// fresh after memory growth; toolpath buffers routinely land past the 64MB
// initial heap). readBytes must run BEFORE any other bridge call, since the
// copy happens on the live heap.
function readBytes(Module, ptr, len) {
  try {
    return Module.HEAPU8.slice(ptr, ptr + len);
  } finally {
    Module._free(ptr);
  }
}

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

// 6. slice config — every key below uses the option names valid at the
// pinned SHA (pre-rename names like temperature/perimeters/bed_shape/
// start_gcode are silently dropped by libslic3r's handle_legacy catch-all —
// see Fix round 2). Ground truth is the module's own metadata fetched above;
// the assertion loop right below the object verifies each key exists.
const configJson = {
  // Drift at the pinned SHA: the layer-G-code option is layer_change_gcode
  // (not layer_gcode); relative-E marlin requires the "G92 E0" reset here or
  // Print::validate rejects the config (fixtures/config.json uses the same).
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
  // Multi-line values keep the escaped-\n form; the JSON arrives double-
  // escaped and orc_slice's unescape path restores the real newlines.
  machine_start_gcode: 'G28\\nG1 Z5 F5000',
  machine_end_gcode: 'M104 S0\\nM140 S0\\nG28 X0\\nM84',
};
for (const k of Object.keys(configJson))
  check(`config key ${k} exists`, k in meta, `type=${meta[k]?.type}`);
const sliced = callJson('orc_slice', ['string'], [JSON.stringify(configJson)]);
// Fix round 2: unrecognized_keys is always present on success (empty when the
// config is valid) — a non-empty array means the client sent dropped keys.
check('orc_slice ok', sliced.ok === true
      && Array.isArray(sliced.unrecognized_keys) && sliced.unrecognized_keys.length === 0,
      JSON.stringify(sliced));
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

// 7b. binary slice-result buffers (M2 contract)
const res2 = callJson('orc_get_slice_result', [], []);
check('slice result has toolpath buffers', res2.ok === true
      && res2.toolpath && res2.toolpath.vertex_count > 0,
      JSON.stringify(res2).slice(0, 200));
if (res2.toolpath && res2.toolpath.vertex_count > 0) {
  const n = res2.toolpath.vertex_count;
  const pos = new Float32Array(readBytes(Module, Number(res2.toolpath.vertex_ptr), n * 3 * 4).buffer);
  const layers = new Uint32Array(readBytes(Module, Number(res2.toolpath.layer_ptr), n * 4).buffer);
  const feats = new Uint32Array(readBytes(Module, Number(res2.toolpath.feature_ptr), n * 4).buffer);
  check('toolpath positions finite', pos.every((v) => Number.isFinite(v)));
  check('toolpath layers ascending within range', layers.every((l) => l >= 0 && l < res2.layers));
  check('toolpath features in palette', feats.every((f) => Number.isInteger(f) && f >= 0));
}
if (res2.mesh && res2.mesh.vertex_count > 0) {
  const mi = new Uint32Array(readBytes(Module, Number(res2.mesh.index_ptr), res2.mesh.index_count * 4).buffer);
  check('mesh indices < vertex_count', mi.every((i) => i < res2.mesh.vertex_count));
  Module._free(Number(res2.mesh.vertex_ptr));
  Module._free(Number(res2.mesh.layer_ptr));
}

// 7c. model mesh buffers (M2 contract)
const mm = callJson('orc_get_model_mesh', [], []);
check('orc_get_model_mesh ok', mm.ok === true && mm.objects?.length === 1, JSON.stringify(mm).slice(0, 200));
if (mm.objects?.length === 1) {
  const o = mm.objects[0];
  check('model mesh has cube geometry', o.vertex_count === 8 && o.index_count === 36,
        `verts=${o.vertex_count} idx=${o.index_count}`);
  Module._free(Number(o.vertex_ptr));
  Module._free(Number(o.index_ptr));
}

// 7d. instance offset round-trip
const off = callJson('orc_set_instance_offset', ['number', 'number', 'number', 'number', 'number'],
                     [0, 0, 10, 20, 0]);
check('orc_set_instance_offset ok', off.ok === true, JSON.stringify(off));
const mm2 = callJson('orc_get_model_mesh', [], []);
// Guard the object access so a failed check reports a check() failure
// instead of throwing a TypeError on an undefined objects[0].
check('offset applied', mm2.ok === true && mm2.objects?.[0]?.offset?.[0] === 10,
      JSON.stringify(mm2.objects?.[0]?.offset));
if (mm2.objects?.length === 1) {
  Module._free(Number(mm2.objects[0].vertex_ptr));
  Module._free(Number(mm2.objects[0].index_ptr));
}

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
// Fix round 2 (honest test): 'temperature' is the pre-rename name (now
// nozzle_temperature) and is dropped by handle_legacy at the pinned SHA —
// orc_slice must surface it in unrecognized_keys instead of silently
// ignoring it. The real config (check 6) stays clean and asserts the
// empty case.
const resliced = callJson('orc_slice', ['string'],
                          [JSON.stringify({ ...configJson, layer_height: 0.25, temperature: 210 })]);
check('re-slice after removeFunction ok', resliced.ok === true, JSON.stringify(resliced));
check('unknown key reported', Array.isArray(resliced.unrecognized_keys)
      && resliced.unrecognized_keys.includes('temperature'),
      `unrecognized_keys=${JSON.stringify(resliced.unrecognized_keys)}`);
const result2 = callJson('orc_get_slice_result', [], []);
check('re-slice actually re-ran', result2.ok === true && result2.layers > 0 && result2.layers !== result.layers,
      `layers=${result2.layers} (first slice: ${result2.layers})`);

// 10. SlicingErrors surfacing (regression 2026-08-15): a model whose first
// layer has no extrusions throws SlicingErrors whose what() is just "Errors"
// (Exception.hpp:44) — orc_slice must surface the per-object messages from
// errors_ (bridge.cpp error_json_from_exception) or the renderer can only
// show the bare category. floating-box.stl: bottom at z=0.3, above the 0.2
// first layer, no supports -> "empty first layer" SlicingError -> SlicingErrors.
const boxStl = await readFile(boxStlPath);
const boxPtr = Number(Module._malloc(boxStl.length));
Module.HEAPU8.set(boxStl, boxPtr);
const boxLoaded = callJson('orc_load_model', ['pointer', 'number', 'string'],
                           [boxPtr, boxStl.length, 'stl']);
Module._free(boxPtr);
check('floating-box loads', boxLoaded.ok === true && boxLoaded.objects === 1, JSON.stringify(boxLoaded));
// Load-time centering (check 4b) dropped the box onto the bed (world min Z
// = 0) — lift it back so its bottom sits at z=0.3 like the raw fixture.
// This keeps the check about ERROR SURFACING, not about raw coordinates
// surviving the load: offset.z is the ensure_on_bed lift, +0.3 re-floats it.
const boxMesh = callJson('orc_get_model_mesh', [], []);
if (boxMesh.ok && boxMesh.objects?.[0]) {
  Module._free(Number(boxMesh.objects[0].vertex_ptr));
  Module._free(Number(boxMesh.objects[0].index_ptr));
  const floatZ = boxMesh.objects[0].offset[2] + 0.3;
  const boxLifted = callJson('orc_set_instance_offset', ['number', 'number', 'number', 'number', 'number'],
                             [0, 0, 0, 0, floatZ]);
  check('floating-box re-floated', boxLifted.ok === true, JSON.stringify(boxLifted));
} else {
  check('floating-box mesh available', false, JSON.stringify(boxMesh).slice(0, 120));
}
const boxSliced = callJson('orc_slice', ['string'], [JSON.stringify(configJson)]);
check('slice error surfaces the real message, not the bare category',
      !boxSliced.ok && typeof boxSliced.error === 'string'
      && boxSliced.error !== 'Errors' && boxSliced.error.includes('empty first layer'),
      JSON.stringify(boxSliced));

