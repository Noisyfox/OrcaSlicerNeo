import { describe, expect, it } from 'vitest';
import { detectRuntimeCapabilities, resolveRuntimeAsset, selectRuntimeArtifact } from './bootstrap';

describe('portable runtime bootstrap', () => {
  it('requires both isolation and thread primitives for threaded wasm', () => {
    expect(detectRuntimeCapabilities({ webgl2: true, wasm64: true, crossOriginIsolated: true, SharedArrayBuffer: ArrayBuffer, Atomics: {} }).threadedWasm).toBe(false);
    expect(detectRuntimeCapabilities({ webgl2: true, wasm64: true, crossOriginIsolated: true, SharedArrayBuffer: SharedArrayBuffer, Atomics: {} }).threadedWasm).toBe(true);
    expect(selectRuntimeArtifact({ webgl2: true, wasm64: true, threadedWasm: false })).toBe('serial');
  });

  it('rejects unsupported capabilities before launch', () => {
    expect(selectRuntimeArtifact({ webgl2: false, wasm64: true, threadedWasm: true })).toBe('unsupported');
    expect(selectRuntimeArtifact({ webgl2: true, wasm64: false, threadedWasm: true })).toBe('unsupported');
  });

  it.each([
    ['https://host.test/', 'https://host.test/wasm/serial/orca.js'],
    ['https://host.test/app/', 'https://host.test/app/wasm/serial/orca.js'],
    ['file:///C:/app/', 'file:///C:/app/wasm/serial/orca.js'],
  ])('resolves assets under %s', (base, expected) => {
    expect(resolveRuntimeAsset('wasm/serial/orca.js', base)).toBe(expected);
  });
});
