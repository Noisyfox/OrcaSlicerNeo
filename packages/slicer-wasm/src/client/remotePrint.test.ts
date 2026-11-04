import { describe, expect, it, vi } from 'vitest';
import type { OrcaModule } from './types';
import { inspectRemotePrintBundle } from './remotePrint';

function fixture(reply = '{"ok":true,"configuration":{},"targets":[]}', capacity = 64) {
  return { _malloc: vi.fn(() => 16), _free: vi.fn(), HEAPU8: new Uint8Array(capacity),
    ccall: vi.fn(() => 32), UTF8ToString: vi.fn(() => reply) } as unknown as OrcaModule;
}
describe('isolated remote-print client', () => {
  it('copies exactly the selected view and frees both allocations without initializing a project', () => {
    const module = fixture();
    expect(inspectRemotePrintBundle(module, Uint8Array.of(0, 1, 2, 3).subarray(1, 3))).toEqual({ configuration: {}, targets: [] });
    expect(module.HEAPU8.slice(16, 18)).toEqual(Uint8Array.of(1, 2));
    expect(module.ccall).toHaveBeenCalledExactlyOnceWith('orc_inspect_remote_print', 'number', ['string'], ['{"pointer":16,"length":2}']);
    expect(module._free).toHaveBeenNthCalledWith(1, 32);
    expect(module._free).toHaveBeenNthCalledWith(2, 16);
  });
  it('releases input and output on parser errors and malformed replies', () => {
    for (const reply of ['{"ok":false,"error":"Invalid ZIP"}', 'invalid']) {
      const module = fixture(reply);
      expect(() => inspectRemotePrintBundle(module, Uint8Array.of(1))).toThrow();
      expect(module._free).toHaveBeenCalledTimes(2);
    }
  });
  it('delegates empty and larger-than-16-MiB inputs to the Orca parser', () => {
    for (const bytes of [new Uint8Array(), new Uint8Array(17 * 1024 * 1024)]) {
      const module = fixture(undefined, bytes.length + 64);
      expect(inspectRemotePrintBundle(module, bytes)).toEqual({ configuration: {}, targets: [] });
      expect(module.ccall).toHaveBeenCalledOnce();
      expect(module._free).toHaveBeenCalledTimes(2);
    }
  });
});
