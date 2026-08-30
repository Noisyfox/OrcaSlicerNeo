import { describe, expect, it, vi } from 'vitest';
import { loadWasmArtifact } from './wasm-artifact';

describe('loadWasmArtifact', () => {
  it('uses the threaded artifact when it starts successfully', async () => {
    const load = vi.fn(async (variant: 'threaded' | 'serial') => ({ variant }));

    await expect(loadWasmArtifact('threaded', load)).resolves.toEqual({ module: { variant: 'threaded' }, variant: 'threaded' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('threaded');
  });

  it('recovers with serial when threaded module startup fails', async () => {
    const failure = new Error('malformed threaded wasm');
    const load = vi.fn(async (variant: 'threaded' | 'serial') => {
      if (variant === 'threaded') throw failure;
      return { variant };
    });
    const report = vi.fn();

    await expect(loadWasmArtifact('threaded', load, report)).resolves.toEqual({ module: { variant: 'serial' }, variant: 'serial' });
    expect(load.mock.calls).toEqual([['threaded'], ['serial']]);
    expect(report).toHaveBeenCalledWith(failure);
  });
});
