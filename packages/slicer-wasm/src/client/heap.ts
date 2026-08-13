// packages/slicer-wasm/src/client/heap.ts
// ----------------------------------------------------------------
// Heap marshaling: strings in, bytes in, typed arrays out. All
// bridge returns are malloc'd C strings (or binary buffers on the
// heap); the JS side always _free()s what it allocates or reads.
// wasm64: pointer-bearing ccall args use 'pointer' and are
// Number()-cast on the way back (see harness/bridge-smoke.mjs).
// ----------------------------------------------------------------
import type { OrcaModule } from './types';

export function writeBytes(module: OrcaModule, bytes: Uint8Array): number {
  const ptr = Number(module._malloc(bytes.length));
  module.HEAPU8.set(bytes, ptr);
  return ptr;
}

/** Read a malloc'd JSON C string; frees it. */
export function readJsonString(module: OrcaModule, ptr: number): unknown {
  try {
    return JSON.parse(module.UTF8ToString(ptr));
  } finally {
    module._free(ptr);
  }
}

/** Copy [ptr, ptr+len) out of the heap into a fresh ArrayBuffer-backed array. */
export function readBytes(module: OrcaModule, ptr: number, len: number): Uint8Array {
  try {
    return module.HEAPU8.slice(ptr, ptr + len);
  } finally {
    module._free(ptr);
  }
}

/** The Emscripten-6 / wasm64 ccall convention used across the harness. */
export function callJson(
  module: OrcaModule,
  name: string,
  argTypes: string[],
  args: unknown[],
): unknown {
  const ptr = Number(module.ccall(name, 'number', argTypes, args));
  return readJsonString(module, ptr);
}
