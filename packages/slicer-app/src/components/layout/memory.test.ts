// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleMemoryIndicator } from './memory';

function platform(overrides: {
  platform?: { totalBytes?: number; entries: Array<{ id: string; label: string; bytes: number }> };
  worker?: { jsHeapUsedBytes?: number; wasmLinearMemoryBytes: number };
} = {}) {
  return {
    memory: { sample: vi.fn(async () => overrides.platform ?? { entries: [] }) },
    runtime: { getRuntimeMemory: vi.fn(async () => overrides.worker ?? { jsHeapUsedBytes: 7, wasmLinearMemoryBytes: 11 }) },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('memory indicator sampling', () => {
  it('estimates Web total from renderer and Worker JS heaps plus WASM capacity', async () => {
    vi.stubGlobal('performance', { memory: { usedJSHeapSize: 5 } });
    const result = await sampleMemoryIndicator(platform());
    expect(result.totalKind).toBe('total-estimate');
    expect(result.totalBytes).toBe(23);
    expect(result.sharedRuntime).toEqual([
      { id: 'renderer-js-heap', label: 'Renderer JS heap', bytes: 5, includedInTotal: true },
      { id: 'worker-js-heap', label: 'Slicer Worker JS heap', bytes: 7, includedInTotal: true },
      { id: 'wasm-linear-memory', label: 'WASM linear-memory capacity', bytes: 11, includedInTotal: true },
    ]);
  });

  it('labels the combined JavaScript and WASM total as an estimate', async () => {
    vi.stubGlobal('performance', { memory: { usedJSHeapSize: 5 } });
    const result = await sampleMemoryIndicator(platform());
    expect(result.totalKind).toBe('total-estimate');
    expect(result.totalBytes).toBe(23);
    expect(result.sharedRuntime.find((entry) => entry.id === 'wasm-linear-memory'))
      .toMatchObject({ includedInTotal: true });
  });

  it('prefers the host total and preserves generic platform detail items', async () => {
    vi.stubGlobal('performance', { memory: { usedJSHeapSize: 5 } });
    const result = await sampleMemoryIndicator(platform({
      platform: { totalBytes: 80, entries: [{ id: 'desktop:gpu', label: 'GPU process', bytes: 30 }] },
    }));
    expect(result.totalKind).toBe('platform');
    expect(result.totalBytes).toBe(80);
    expect(result.platform.entries).toEqual([{ id: 'desktop:gpu', label: 'GPU process', bytes: 30 }]);
  });

  it('reports unavailable when no JavaScript heap measurement is available', async () => {
    vi.stubGlobal('performance', {});
    await expect(sampleMemoryIndicator(platform({ worker: { wasmLinearMemoryBytes: 11 } })))
      .rejects.toThrow('JavaScript heap measurement is unavailable');
  });
});
