// apps/desktop/e2e/stub/orca_slice.js — throwaway bridge-shaped module used
// ONLY by the packaged-app probe (staged into public/wasm/ by
// scripts/stage-stub-wasm.mjs, which is gitignored). Replaced by the real
// Emscripten artifact in CI (e2e-real). Implements just enough of the bridge
// for the app's boot path: init → getProfileSnapshot → getOptionMetadata.
//
// Contract: every bridge call returns a malloc'd JSON C string; the client
// reads it via Number(ccall(...)) → UTF8ToString(ptr) → JSON.parse (see
// packages/slicer-wasm/src/client/heap.ts callJson). ccall must therefore
// return the heap POINTER, not the object — same machinery as the client's
// createMockModule (putJson). Only orc_set_progress_callback is 'void'.
export default function makeStubModule() {
  // ---- tiny bump allocator over the module's heap ----
  const HEAPU8 = new Uint8Array(64 * 1024 * 1024);
  let bump = 1024;
  function malloc(size) {
    const p = bump;
    bump += (size + 7) & ~7;
    if (bump > HEAPU8.length) throw new Error('stub heap exhausted');
    return p;
  }

  function utf8ToString(ptr) {
    if (!Number.isFinite(Number(ptr))) return '';
    let end = Number(ptr);
    while (HEAPU8[end] !== 0) end++;
    return new TextDecoder().decode(HEAPU8.subarray(Number(ptr), end));
  }

  function putJson(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const p = malloc(bytes.length + 1);
    HEAPU8.set(bytes, p);
    return p;
  }

  // ---- the bridge fns (boot path only) ----
  const bridge = {
    orc_init() {
      return { ok: true, prints: 1, filaments: 2, printers: 3 };
    },
    orc_get_preset_snapshot() {
      const preset = (name) => ({
        name, is_visible: true, is_default: false, selected: false,
        vendor_id: 'bambulab', model: '', variant: '',
      });
      const printer = 'Bambu Lab X1 Carbon 0.4 nozzle';
      const print = '0.20mm Standard @BBL X1C';
      const filament = 'Bambu PLA Basic @BBL X1C';
      return {
        ok: true,
        printers: [{ ...preset(printer), selected: true }, preset('Bambu Lab P1S 0.4 nozzle')],
        prints: [{ ...preset(print), selected: true }],
        filaments: [{ ...preset(filament), selected: true }, preset('Bambu PLA Matte @BBL X1C')],
        printer: { name: printer, idx: 0 },
        print: { name: print, idx: 0 },
        filament: { name: filament, idx: 0 },
      };
    },
    orc_get_option_metadata() {
      return {
        layer_height: { type: 'float' },
        wall_loops: { type: 'int' },
        sparse_infill_density: { type: 'percent' },
        sparse_infill_pattern: { type: 'enum', enum_values: ['grid', 'gyroid', 'lines'] },
      };
    },
    orc_set_progress_callback() {}, // ret 'void' — return value unused
  };

  const VOID_RETURNS = new Set(['orc_set_progress_callback']);

  return {
    ccall(name, ret, argTypes, args) {
      const fn = bridge[name];
      if (!fn) throw new Error(`stub: unregistered bridge fn ${name}`);
      const result = fn(...args);
      if (VOID_RETURNS.has(name)) return undefined;
      return putJson(result);
    },
    UTF8ToString: utf8ToString,
    _malloc: malloc,
    _free: () => {},
    HEAPU8,
    HEAPU32: new Uint32Array(64 * 1024 * 1024),
    HEAPF32: new Float32Array(64 * 1024 * 1024),
    addFunction: () => 0,
    removeFunction: () => {},
    FS: { writeFile() {}, readFile() { return new Uint8Array(0); } },
  };
}
