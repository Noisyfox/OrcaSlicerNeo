import { describe, expect, it, vi } from 'vitest';
import { inspectRemotePrintResources } from './remotePrint';

describe('remote metadata bundle admission', () => {
  it('rejects missing, duplicate, oversized and non-metadata resources before loading WASM', async () => {
    const load = vi.fn();
    const name = '_rels/.rels' as const;
    for (const input of [[], [{ name, bytes: new Uint8Array() }],
      [{ name, bytes: Uint8Array.of(1) }, { name, bytes: Uint8Array.of(2) }],
      [{ name, bytes: new Uint8Array(8 * 1024 * 1024 + 1) }],
      [{ name: 'Metadata/plate_1.gcode' as typeof name, bytes: Uint8Array.of(1) }]])
      await expect(inspectRemotePrintResources(input, load)).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  });
});
