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

// The threaded wasm build must use every logical core available at runtime;
// the serial build (WASM_THREADING=0) must report a single-concurrency pool.
// The loader evaluates navigator.hardwareConcurrency dynamically, so the
// expected value is intentionally not baked into this test.
const threading = callJson('orc_get_threading_info', [], []);
const runtimeCores = globalThis.navigator?.hardwareConcurrency;
const poolOk = threading.threaded
  ? Number.isInteger(threading.max_concurrency) && threading.max_concurrency >= 1
    && threading.arena_concurrency === threading.max_concurrency
    && (runtimeCores === undefined || threading.max_concurrency === runtimeCores)
  : threading.max_concurrency === 1 && threading.arena_concurrency === 1;
check('variant reports a consistent TBB pool',
      threading.ok === true && poolOk,
      `${JSON.stringify(threading)} runtimeCores=${runtimeCores}`);

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
const loaded = callJson('orc_add_model', ['pointer', 'number', 'string'],
                        [dataPtr, stl.length, 'stl']);
Module._free(dataPtr);
check('orc_add_model ok', loaded.ok === true && loaded.objects > 0, JSON.stringify(loaded));

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

// Add Model must append to the live scene; Clear Scene is the only operation
// that resets it. Restore a single cube afterwards so the existing slice and
// centering checks below continue to exercise the one-object fixture.
const secondPtr = Number(Module._malloc(stl.length));
Module.HEAPU8.set(stl, secondPtr);
const appended = callJson('orc_add_model', ['pointer', 'number', 'string'],
                          [secondPtr, stl.length, 'stl']);
Module._free(secondPtr);
check('orc_add_model preserves existing objects', appended.ok === true && appended.objects === 2,
      JSON.stringify(appended));
const cleared = callJson('orc_clear_model', [], []);
check('orc_clear_model resets the scene', cleared.ok === true, JSON.stringify(cleared));
const restoredPtr = Number(Module._malloc(stl.length));
Module.HEAPU8.set(stl, restoredPtr);
const restored = callJson('orc_add_model', ['pointer', 'number', 'string'],
                          [restoredPtr, stl.length, 'stl']);
Module._free(restoredPtr);
check('orc_add_model restores one object after clear', restored.ok === true && restored.objects === 1,
      JSON.stringify(restored));

// 4c. delete whole objects by their stable ObjectIDs. Requests are validated
// before any mutation and deduplicated; a bad ID leaves the scene intact.
{
  const secondPtr = Number(Module._malloc(stl.length));
  Module.HEAPU8.set(stl, secondPtr);
  const two = callJson('orc_add_model', ['pointer', 'number', 'string'],
                       [secondPtr, stl.length, 'stl']);
  Module._free(secondPtr);
  check('delete fixture has two objects', two.ok === true && two.objects === 2, JSON.stringify(two));

  const twoStruct = callJson('orc_get_model_structure', [], []);
  check('structure read for delete', twoStruct.ok === true && twoStruct.objects?.length === 2,
        JSON.stringify(twoStruct));
  const ids = twoStruct.objects.map((o) => o.id);

  const bad = callJson('orc_delete_objects', ['string'], [JSON.stringify([999999999])]);
  check('orc_delete_objects rejects an unknown object ID',
        !bad.ok && /object not found/.test(bad.error ?? ''), JSON.stringify(bad));
  const intact = callJson('orc_get_model_mesh', [], []);
  check('rejected delete leaves the scene intact',
        intact.ok === true && intact.objects?.length === 2, JSON.stringify(intact));

  const del = callJson('orc_delete_objects', ['string'], [JSON.stringify([ids[1], ids[0], ids[1]])]);
  check('orc_delete_objects removes deduped stable IDs',
        del.ok === true && del.objects === 0 && del.deleted === 2, JSON.stringify(del));
  const empty = callJson('orc_get_model_mesh', [], []);
  check('empty scene reports an empty mesh', empty.ok === true && empty.objects?.length === 0,
        JSON.stringify(empty));
}

// Restore a single cube so the existing slice/export checks keep their
// one-object fixture.
{
  const restorePtr = Number(Module._malloc(stl.length));
  Module.HEAPU8.set(stl, restorePtr);
  const restoredAgain = callJson('orc_add_model', ['pointer', 'number', 'string'],
                                 [restorePtr, stl.length, 'stl']);
  Module._free(restorePtr);
  check('orc_add_model restores the slice fixture', restoredAgain.ok === true && restoredAgain.objects === 1,
        JSON.stringify(restoredAgain));
}

// 4d. Step 2: non-destructive metadata operations resolve by stable ObjectID.
// The loaded cube is a single solid part, so set_volume_type must be rejected
// by the last-solid-part guard (a positive type change with a multi-part object
// is exercised by the mock-module contract tests). Names and printable state
// are restored afterwards so the slice/export checks keep their fixture.
{
  const structure = callJson('orc_get_model_structure', [], []);
  check('structure read before metadata ops', structure.ok === true && structure.objects?.length === 1,
        JSON.stringify(structure));
  if (structure.ok && structure.objects?.length === 1) {
    const obj = structure.objects[0];
    const vol = obj.volumes[0];
    const inst = obj.instances[0];
    const originalName = obj.name;
    const originalVolName = vol.name;

    const renamed = callJson('orc_rename_object', ['number', 'string'], [obj.id, 'Renamed Object']);
    check('orc_rename_object ok', renamed.ok === true, JSON.stringify(renamed));
    const afterRename = callJson('orc_get_model_structure', [], []);
    check('object renames by stable ID',
          afterRename.ok === true && afterRename.objects?.[0]?.name === 'Renamed Object',
          JSON.stringify(afterRename.objects?.[0]?.name));

    const renamedVol = callJson('orc_rename_volume', ['number', 'string'], [vol.id, 'Renamed Part']);
    check('orc_rename_volume ok', renamedVol.ok === true, JSON.stringify(renamedVol));
    const afterRenameVol = callJson('orc_get_model_structure', [], []);
    check('volume renames by stable ID',
          afterRenameVol.ok === true && afterRenameVol.objects?.[0]?.volumes?.[0]?.name === 'Renamed Part',
          JSON.stringify(afterRenameVol.objects?.[0]?.volumes?.[0]?.name));

    // Single solid part: turning it into a non-print volume is refused.
    const badType = callJson('orc_set_volume_type', ['number', 'string'], [vol.id, 'negative_volume']);
    check('last-solid-part guard rejects the type change',
          !badType.ok && /last solid part/.test(badType.error ?? ''),
          JSON.stringify(badType));
    const afterBadType = callJson('orc_get_model_structure', [], []);
    check('rejected type change leaves the part untouched',
          afterBadType.ok === true && afterBadType.objects?.[0]?.volumes?.[0]?.type === 'model_part',
          JSON.stringify(afterBadType.objects?.[0]?.volumes?.[0]?.type));

    const unprintable = callJson('orc_set_object_printable', ['number', 'number'], [obj.id, 0]);
    check('orc_set_object_printable(false) ok', unprintable.ok === true, JSON.stringify(unprintable));
    const afterUnprintable = callJson('orc_get_model_structure', [], []);
    check('object toggle flips the object gate and every instance',
          afterUnprintable.ok === true && afterUnprintable.objects?.[0]?.printable === false
          && afterUnprintable.objects?.[0]?.instances.every((i) => i.printable === false),
          JSON.stringify(afterUnprintable.objects?.[0]));
    const reprinted = callJson('orc_set_object_printable', ['number', 'number'], [obj.id, 1]);
    check('orc_set_object_printable(true) restores the fixture', reprinted.ok === true, JSON.stringify(reprinted));

    const instOff = callJson('orc_set_instance_printable', ['number', 'number'], [inst.id, 0]);
    check('orc_set_instance_printable(false) ok', instOff.ok === true, JSON.stringify(instOff));
    const afterInstOff = callJson('orc_get_model_structure', [], []);
    check('instance toggle flips exactly the target instance',
          afterInstOff.ok === true && afterInstOff.objects?.[0]?.instances?.[0]?.printable === false,
          JSON.stringify(afterInstOff.objects?.[0]?.instances?.[0]));
    const instOn = callJson('orc_set_instance_printable', ['number', 'number'], [inst.id, 1]);
    check('orc_set_instance_printable(true) restores the fixture', instOn.ok === true, JSON.stringify(instOn));

    const badObject = callJson('orc_rename_object', ['number', 'string'], [999999999, 'nope']);
    check('rename rejects an unknown object ID', !badObject.ok && /object not found/.test(badObject.error ?? ''),
          JSON.stringify(badObject));
    const badTypeStr = callJson('orc_set_volume_type', ['number', 'string'], [vol.id, 'not_a_type']);
    check('set type rejects an unknown type string', !badTypeStr.ok && /invalid volume type/.test(badTypeStr.error ?? ''),
          JSON.stringify(badTypeStr));

    // Restore names so later slice/export checks are unaffected.
    callJson('orc_rename_object', ['number', 'string'], [obj.id, originalName]);
    callJson('orc_rename_volume', ['number', 'string'], [vol.id, originalVolName]);
  }
}

// 4e. Step 3: delete by stable ID, clone, and reorder. The single-cube fixture
// has one solid part, so delete_volumes is exercised via the last-solid-part
// guard (a positive multi-part delete/reorder is covered by the mock contract
// tests). The scene is restored to the original single cube afterwards.
{
  const s = callJson('orc_get_model_structure', [], []);
  check('structure read for step 3', s.ok === true && s.objects?.length === 1,
        JSON.stringify(s));
  if (s.ok && s.objects?.length === 1) {
    const source = s.objects[0];
    const volume = source.volumes[0];

    const cloned = callJson('orc_clone_objects', ['string'], [JSON.stringify([source.id])]);
    check('orc_clone_objects mints a new ObjectID',
          cloned.ok === true && Array.isArray(cloned.newObjectIds)
          && cloned.newObjectIds.length === 1
          && cloned.newObjectIds[0] !== source.id && cloned.objects === 2,
          JSON.stringify(cloned));
    const cloneId = cloned.newObjectIds[0];
    const afterClone = callJson('orc_get_model_structure', [], []);
    const clone = afterClone.objects?.find((o) => o.id === cloneId);
    check('clone carries fresh sub-entity IDs',
          clone && clone.volumes[0].id !== source.volumes[0].id,
          JSON.stringify(clone?.volumes?.[0]));

    // reorder takes a DESTINATION INDEX (0-based); index 0 places the clone first.
    const reordered = callJson('orc_reorder_objects', ['number', 'number'], [cloneId, 0]);
    check('orc_reorder_objects returns the reordered structure',
          reordered.ok === true && Array.isArray(reordered.objects)
          && reordered.objects[0].id === cloneId && reordered.objects[1].id === source.id,
          JSON.stringify(reordered.objects?.map((o) => o.id)));

    // The cube's only part is the last solid part: it cannot be deleted.
    const volDel = callJson('orc_delete_volumes', ['string'], [JSON.stringify([volume.id])]);
    check('volume delete rejects the last solid part',
          !volDel.ok && /last solid part/.test(volDel.error ?? ''), JSON.stringify(volDel));
    const volDelAfter = callJson('orc_get_model_structure', [], []);
    check('rejected volume delete leaves the part',
          volDelAfter.ok === true && volDelAfter.objects?.[0]?.volumes?.length === 1,
          JSON.stringify(volDelAfter.objects?.[0]?.volumes));

    // Non-destructive reorder of a single volume (already at index 0) still returns structure.
    const volReorder = callJson('orc_reorder_volumes', ['number', 'number', 'number'],
                                [source.id, volume.id, 0]);
    const volSource = volReorder.objects?.find((o) => o.id === source.id);
    check('orc_reorder_volumes no-ops on a single part',
          volReorder.ok === true && volSource
          && volSource.volumes[0].id === volume.id,
          JSON.stringify(volSource?.volumes?.[0]?.id));

    const delClone = callJson('orc_delete_objects', ['string'], [JSON.stringify([cloneId])]);
    check('orc_delete_objects removes the clone by ID',
          delClone.ok === true && delClone.objects === 1 && delClone.deleted === 1,
          JSON.stringify(delClone));
    const restoredScene = callJson('orc_get_model_structure', [], []);
    check('scene restored to a single object',
          restoredScene.ok === true && restoredScene.objects?.length === 1
          && restoredScene.objects[0].id === source.id,
          JSON.stringify(restoredScene.objects?.length));
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

// 5. progress transport. Threaded builds publish to the shared-memory
// mailbox: reading it from JS has no function-table callback and therefore
// remains safe when oneTBB invokes a status update on a pthread. Keep the
// old callback check for the serial fallback artifact.
let progressCalls = 0;
let progressText = '';
let cb;
let mailboxWords;
let mailboxText;
let mailboxSequence = 0;
if (threading.threaded) {
  const mailbox = callJson('orc_get_progress_mailbox', [], []);
  check('threaded progress mailbox exported', mailbox.ok === true
        && Number.isInteger(mailbox.byte_offset) && Number.isInteger(mailbox.text_capacity),
        JSON.stringify(mailbox));
  if (mailbox.ok && Module.HEAPU8.buffer instanceof SharedArrayBuffer) {
    mailboxWords = new Int32Array(Module.HEAPU8.buffer, mailbox.byte_offset, 4);
    mailboxText = new Uint8Array(Module.HEAPU8.buffer, mailbox.byte_offset + 16, mailbox.text_capacity);
    mailboxSequence = Atomics.load(mailboxWords, 0);
  } else {
    check('threaded progress mailbox is shared', false, String(Module.HEAPU8.buffer.constructor?.name));
  }
} else {
  // wasm64: progress_fn is void(*)(int, const char*) = (i32, i64), so the
  // dynamically registered fallback callback needs signature 'vij'.
  cb = Module.addFunction((percent, text) => {
    progressCalls++;
    progressText = Module.UTF8ToString(Number(text));
  }, 'vij');
  Module.ccall('orc_set_progress_callback', null, ['pointer'], [cb]);
}

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
if (threading.threaded && mailboxWords && mailboxText) {
  const sequence = Atomics.load(mailboxWords, 0);
  const percent = Atomics.load(mailboxWords, 1);
  const length = Atomics.load(mailboxWords, 2);
  const text = new TextDecoder().decode(mailboxText.slice(0, length));
  check('threaded progress mailbox completed a stable update',
        sequence > mailboxSequence && sequence % 2 === 0 && percent === 100,
        `before=${mailboxSequence} after=${sequence} percent=${percent}`);
  check('threaded progress text arrives', text.length > 0, `text="${text.slice(0, 40)}"`);
} else {
  check('progress fired', progressCalls > 0, `calls=${progressCalls}`);
  check('progress text arrives', progressText.length > 0, `text="${progressText.slice(0, 40)}"`);
  // Clear the serial bridge's stored pointer before removeFunction. Otherwise
  // a later slice would call a stale table slot and trap.
  Module.ccall('orc_set_progress_callback', null, ['pointer'], [0]);
  Module.removeFunction(cb);
}

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

// Regression: re-slice after the serial fallback callback is removed. A stale
// g_progress used to trap inside the status lambda during process() ("null
// function or function signature mismatch"). A re-slice with the SAME model/config short-circuits
// (apply/process no-op, no callbacks) — which is how the bug used to hide — so
// load the model again (fresh Model => apply sees changes => process re-runs)
// AND change layer_height so the layer count provably differs from the first
// slice, proving the re-slice actually re-sliced instead of short-circuiting.
const stl2 = await readFile(stlPath);
const dataPtr2 = Number(Module._malloc(stl2.length));
Module.HEAPU8.set(stl2, dataPtr2);
callJson('orc_clear_model', [], []);
const reloaded = callJson('orc_add_model', ['pointer', 'number', 'string'],
                          [dataPtr2, stl2.length, 'stl']);
Module._free(dataPtr2);
check('reload before re-slice ok', reloaded.ok === true, JSON.stringify(reloaded));
// Fix round 2 (honest test): 'temperature' is the pre-rename name (now
// nozzle_temperature) and is dropped by handle_legacy at the pinned SHA —
// orc_slice must surface it in unrecognized_keys instead of silently
// ignoring it. The real config (check 6) stays clean and asserts the
// empty case.
const resliced = callJson('orc_slice', ['string'],
                          [JSON.stringify({ ...configJson, layer_height: 0.25, temperature: 210 })]);
check('re-slice after progress cleanup ok', resliced.ok === true, JSON.stringify(resliced));
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
callJson('orc_clear_model', [], []);
const boxLoaded = callJson('orc_add_model', ['pointer', 'number', 'string'],
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

// 10b. Step 4a: split a multi-shell volume into parts, then confirm the split
// parts still slice to valid G-code.
{
  const multiPath = resolve(dirname(stlPath), 'multipart.stl');
  const multi = await readFile(multiPath);
  const mpPtr = Number(Module._malloc(multi.length));
  Module.HEAPU8.set(multi, mpPtr);
  callJson('orc_clear_model', [], []);
  const loaded = callJson('orc_add_model', ['pointer', 'number', 'string'],
                          [mpPtr, multi.length, 'stl']);
  Module._free(mpPtr);
  check('multipart fixture loads', loaded.ok === true && loaded.objects === 1, JSON.stringify(loaded));

  const s = callJson('orc_get_model_structure', [], []);
  check('multipart volume is splittable',
        s.ok === true && s.objects?.[0]?.volumes?.[0]?.isSplittable === true,
        JSON.stringify(s.objects?.[0]?.volumes?.[0]?.isSplittable));
  const vol = s.objects?.[0]?.volumes?.[0];
  if (vol) {
    const split = callJson('orc_split_volume_to_parts', ['number', 'number', 'number'], [vol.id, 1, 0]);
    check('orc_split_volume_to_parts produces parts',
          split.ok === true && split.parts >= 2
          && Array.isArray(split.newVolumeIds) && split.newVolumeIds.length === split.parts,
          JSON.stringify({ parts: split.parts, newVolumeIds: split.newVolumeIds }));
    const afterSplit = callJson('orc_get_model_structure', [], []);
    check('split parts appear with fresh IDs and the old ID is stale',
          afterSplit.ok === true
          && afterSplit.objects?.[0]?.volumes?.length === split.parts
          && afterSplit.objects[0].volumes.every((v) => split.newVolumeIds.includes(v.id))
          && !afterSplit.objects[0].volumes.some((v) => v.id === vol.id),
          JSON.stringify(afterSplit.objects?.[0]?.volumes?.map((v) => v.id)));

    const S = callJson('orc_slice', ['string'], [JSON.stringify(configJson)]);
    check('split parts slice to valid G-code', S.ok === true, JSON.stringify(S));
    if (S.ok) {
      const g = validateGcode(Module.FS.readFile('/out.gcode'));
      check('split parts G-code valid', g.ok, JSON.stringify(g));
    }
  } else {
    check('multipart volume available', false, JSON.stringify(s).slice(0, 120));
  }
}

// 10c. Step 4b: split a multi-shell object into one object per shell.
{
  const multiPath = resolve(dirname(stlPath), 'multipart.stl');
  const multi = await readFile(multiPath);
  const mpPtr = Number(Module._malloc(multi.length));
  Module.HEAPU8.set(multi, mpPtr);
  callJson('orc_clear_model', [], []);
  const loaded = callJson('orc_add_model', ['pointer', 'number', 'string'],
                          [mpPtr, multi.length, 'stl']);
  Module._free(mpPtr);
  check('multipart loads for object split', loaded.ok === true && loaded.objects === 1, JSON.stringify(loaded));

  const s = callJson('orc_get_model_structure', [], []);
  const obj = s.objects?.[0];
  if (obj) {
    const split = callJson('orc_split_object_to_objects', ['number', 'number'], [obj.id, 0]);
    check('orc_split_object_to_objects produces one object per shell',
          split.ok === true && Array.isArray(split.newObjectIds)
          && split.newObjectIds.length >= 2 && split.objects === 2,
          JSON.stringify(split));
    const after = callJson('orc_get_model_structure', [], []);
    check('split objects carry fresh IDs and the source is gone',
          after.ok === true && after.objects?.length === 2
          && after.objects.every((o) => split.newObjectIds.includes(o.id))
          && !after.objects.some((o) => o.id === obj.id),
          JSON.stringify(after.objects?.map((o) => o.id)));

    const S = callJson('orc_slice', ['string'], [JSON.stringify(configJson)]);
    check('split objects slice to valid G-code', S.ok === true, JSON.stringify(S));
  } else {
    check('multipart object available', false, JSON.stringify(s).slice(0, 120));
  }
}

// 10d. Step 4c: assemble separate objects into a multipart object.
{
  callJson('orc_clear_model', [], []);
  const p1 = Number(Module._malloc(stl.length));
  Module.HEAPU8.set(stl, p1);
  const l1 = callJson('orc_add_model', ['pointer', 'number', 'string'], [p1, stl.length, 'stl']);
  Module._free(p1);
  const p2 = Number(Module._malloc(stl.length));
  Module.HEAPU8.set(stl, p2);
  const l2 = callJson('orc_add_model', ['pointer', 'number', 'string'], [p2, stl.length, 'stl']);
  Module._free(p2);
  check('assemble fixture has two objects', l1.ok === true && l2.ok === true && l2.objects === 2, JSON.stringify(l2));

  const s = callJson('orc_get_model_structure', [], []);
  const ids = s.objects.map((o) => o.id);
  const merged = callJson('orc_merge_objects_to_multipart', ['string', 'string'], [JSON.stringify(ids), 'Assembly']);
  check('assemble produces a single multipart object',
        merged.ok === true && merged.objectId > 0 && merged.objects === 1, JSON.stringify(merged));
  const after = callJson('orc_get_model_structure', [], []);
  const assembled = after.objects?.[0];
  check('assembled object carries both volumes and the source objects are gone',
        after.ok === true && after.objects?.length === 1
        && assembled?.volumes?.length === 2 && assembled.name === 'Assembly',
        JSON.stringify({ id: assembled?.id, name: assembled?.name, volumes: assembled?.volumes?.length }));

  const S = callJson('orc_slice', ['string'], [JSON.stringify(configJson)]);
  check('assembled multipart slices to valid G-code', S.ok === true, JSON.stringify(S));
}

// 10e. Step 4d: separate instances into objects. The bridge has no op yet to add
// instances, so this is a single-instance live smoke; the multi-instance
// transform/one-object-per-instance behavior is pinned by the mock contract tests.
{
  callJson('orc_clear_model', [], []);
  const p = Number(Module._malloc(stl.length));
  Module.HEAPU8.set(stl, p);
  const loaded = callJson('orc_add_model', ['pointer', 'number', 'string'], [p, stl.length, 'stl']);
  Module._free(p);
  check('separate-instances fixture loads', loaded.ok === true && loaded.objects === 1, JSON.stringify(loaded));

  const s = callJson('orc_get_model_structure', [], []);
  const obj = s.objects?.[0];
  const inst = obj?.instances?.[0];
  if (obj && inst) {
    const sep = callJson('orc_instances_to_separate_objects', ['number', 'string'],
                         [obj.id, JSON.stringify([inst.id])]);
    check('separating the single instance creates one object',
          sep.ok === true && Array.isArray(sep.newObjectIds)
          && sep.newObjectIds.length === 1 && sep.objects === 2,
          JSON.stringify(sep));
    const after = callJson('orc_get_model_structure', [], []);
    const newObj = after.objects?.find((o) => o.id === sep.newObjectIds[0]);
    check('separated object carries a single instance with the source transform',
          after.ok === true && newObj && newObj.instances?.length === 1,
          JSON.stringify(newObj?.instances?.length));
  } else {
    check('separate-instances fixture structure', false, JSON.stringify(s).slice(0, 120));
  }
}

// 10f. add / remove instance.
{
  callJson('orc_clear_model', [], []);
  const p = Number(Module._malloc(stl.length));
  Module.HEAPU8.set(stl, p);
  const loaded = callJson('orc_add_model', ['pointer', 'number', 'string'], [p, stl.length, 'stl']);
  Module._free(p);
  check('add-instance fixture loads', loaded.ok === true && loaded.objects === 1, JSON.stringify(loaded));
  const s = callJson('orc_get_model_structure', [], []);
  const obj = s.objects?.[0];
  if (obj) {
    const added = callJson('orc_add_instance', ['number'], [obj.id]);
    check('orc_add_instance adds an instance',
          added.ok === true && added.instanceId > 0 && added.instanceId !== obj.instances[0].id,
          JSON.stringify(added));
    const afterAdd = callJson('orc_get_model_structure', [], []);
    check('instance count grows',
          afterAdd.ok === true && afterAdd.objects?.[0]?.instanceCount === 2
          && afterAdd.objects[0].instances.length === 2,
          JSON.stringify(afterAdd.objects?.[0]?.instanceCount));

    const removed = callJson('orc_remove_instance', ['number', 'number'], [obj.id, added.instanceId]);
    check('orc_remove_instance removes the instance', removed.ok === true, JSON.stringify(removed));
    const afterRemove = callJson('orc_get_model_structure', [], []);
    check('instance count restored',
          afterRemove.ok === true && afterRemove.objects?.[0]?.instanceCount === 1,
          JSON.stringify(afterRemove.objects?.[0]?.instanceCount));

    const last = afterRemove.objects?.[0]?.instances?.[0];
    const badRemove = callJson('orc_remove_instance', ['number', 'number'], [obj.id, last.id]);
    check('last instance cannot be removed',
          !badRemove.ok && /last instance/.test(badRemove.error ?? ''), JSON.stringify(badRemove));
  } else {
    check('add-instance fixture structure', false, JSON.stringify(s).slice(0, 120));
  }
}

// Keep the harness useful in CI: a run that printed one or more FAIL checks
// must not be reported as successful merely because the script reached EOF.
if (failures > 0) {
  console.error(`bridge smoke failed: ${failures} check(s)`);
  process.exitCode = 1;
}

