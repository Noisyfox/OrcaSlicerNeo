export interface WebCapabilities { webgl2: boolean; wasm64: boolean; threadedWasm: boolean; }

export function supportsWebgl2(): boolean {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

/** Chrome exposes memory64 through the i64 address option. Keep the probe
 * isolated so unsupported browsers fail before a worker/WASM module starts. */
export function supportsWasm64(): boolean {
  try {
    if (typeof WebAssembly?.Memory !== 'function') return false;
    // Memory64 uses BigInt page counts; number values throw even in browsers
    // that fully support the i64 address space.
    new WebAssembly.Memory({ initial: 1n, maximum: 1n, address: 'i64' } as unknown as WebAssembly.MemoryDescriptor & { address: string });
    return true;
  } catch { return false; }
}

export function detectWebCapabilities(): WebCapabilities {
  return {
    webgl2: supportsWebgl2(),
    wasm64: supportsWasm64(),
    threadedWasm: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
      && typeof SharedArrayBuffer === 'function',
  };
}
