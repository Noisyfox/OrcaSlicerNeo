export interface WebCapabilities { webgl2: boolean; wasm64: boolean; }

export function supportsWebgl2(): boolean {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

/** Chrome exposes memory64 through the i64 address option. Keep the probe
 * isolated so unsupported browsers fail before a worker/WASM module starts. */
export function supportsWasm64(): boolean {
  try {
    if (typeof WebAssembly?.Memory !== 'function') return false;
    new WebAssembly.Memory({ initial: 1, maximum: 1, address: 'i64' } as WebAssembly.MemoryDescriptor & { address: string });
    return true;
  } catch { return false; }
}

export function detectWebCapabilities(): WebCapabilities {
  return { webgl2: supportsWebgl2(), wasm64: supportsWasm64() };
}
