// Import the side-effect-free bootstrap, not the barrel that creates a Worker.
import { supportsWasm32, supportsWasm64 } from '../../../packages/slicer-runtime/src/bootstrap';
export { supportsWasm64 } from '../../../packages/slicer-runtime/src/bootstrap';
export interface WebCapabilities { webgl2: boolean; wasm: boolean; wasm64: boolean; threadedWasm: boolean; }

export function supportsWebgl2(): boolean {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

export function detectWebCapabilities(): WebCapabilities {
  return {
    webgl2: supportsWebgl2(),
    wasm: supportsWasm32(),
    wasm64: supportsWasm64(),
    threadedWasm: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
      && typeof SharedArrayBuffer === 'function',
  };
}
