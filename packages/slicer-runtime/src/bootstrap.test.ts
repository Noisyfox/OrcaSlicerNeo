import { describe, expect, it } from 'vitest';
import { createRuntimeBootstrap, detectRuntimeCapabilities, resolveRuntimeAsset, selectRuntimeArtifact, type WorkerTransport } from './bootstrap';

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

  it('exposes installing-profiles while the host hook is running', async () => {
    const transport: WorkerTransport = { post() {}, onMessage() {} };
    let release!: () => void;
    const profiles = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createRuntimeBootstrap({
      transport,
      capabilities: { webgl2: true, wasm64: true, threadedWasm: false },
      installProfiles: () => profiles,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.status?.phase).toBe('installing-profiles');
    release();
    await (runtime as typeof runtime & { ready: Promise<void> }).ready;
    expect(runtime.status?.phase).toBe('ready');
  });
});
