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

  it('preserves the typed plate-session contract through the runtime worker boundary', async () => {
    let receive!: (message: import('../../slicer-wasm/src/client').WorkerMessage) => void;
    const transport: WorkerTransport = {
      post(message) {
        if (message.type === 'request' && message.op === 'getPlateSessionSnapshot') {
          receive({
            type: 'response', id: message.id, ok: true,
            result: {
              ok: true, version: 1, currentPlateId: 'plate-session-1-plate-1',
              plates: [{ plateId: 'plate-session-1-plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' }],
            },
          });
        }
      },
      onMessage(listener) { receive = listener; },
    };
    const runtime = createRuntimeBootstrap({
      transport,
      capabilities: { webgl2: true, wasm64: true, threadedWasm: false },
    });
    const snapshot = await runtime.getPlateSessionSnapshot();
    expect(snapshot).toEqual({
      ok: true, version: 1, currentPlateId: 'plate-session-1-plate-1',
      plates: [{ plateId: 'plate-session-1-plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' }],
    });
  });

  it('preserves the typed filament-session projection through the runtime worker boundary', async () => {
    let receive!: (message: import('../../slicer-wasm/src/client').WorkerMessage) => void;
    const transport: WorkerTransport = {
      post(message) {
        if (message.type === 'request' && message.op === 'getFilamentSessionSnapshot') {
          receive({ type: 'response', id: message.id, ok: true, result: {
            ok: true, version: 1,
            slots: [{ slot: 1, preset: { id: 'Generic PLA', name: 'Generic PLA' },
              colour: { effective: '#F2754E', provenance: 'preset' } }],
            mappings: { filament: [1], volume: [0], nozzle: [0], filament2: [0], physicalExtruder: [0] },
            flushing: { matrix: [0], vector: [], matrixDimension: 1, source: 'native' },
            capabilities: { minSlots: 1, maxSlots: 64, nozzleCount: 1, canAdd: true, canDelete: false, canMerge: false },
            assignments: { objects: [], parts: [], modifiers: [] },
            revisions: { session: 0, project: 0, result: 0, plates: {} },
            status: { state: 'ready', error: null },
          } });
        }
      },
      onMessage(listener) { receive = listener; },
    };
    const runtime = createRuntimeBootstrap({
      transport,
      capabilities: { webgl2: true, wasm64: true, threadedWasm: false },
    });
    await expect(runtime.getFilamentSessionSnapshot()).resolves.toMatchObject({
      ok: true, version: 1, slots: [{ slot: 1, preset: { id: 'Generic PLA' } }],
      mappings: { physicalExtruder: [0] }, flushing: { matrixDimension: 1 },
    });
  });
});
