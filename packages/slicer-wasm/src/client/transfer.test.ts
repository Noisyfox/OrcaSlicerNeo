import { describe, expect, it } from 'vitest';
import { collectTransferables } from './transfer';

describe('owned transport buffers', () => {
  it('preserves aliases and typed subranges when transferring a project message', () => {
    const buffer = new ArrayBuffer(64);
    const bytes = new Uint8Array(buffer, 8, 16);
    bytes[0] = 42;
    const value = { args: [bytes, new DataView(buffer, 12, 8), buffer] };
    const transfer = collectTransferables(value);
    expect(transfer).toEqual([buffer]);
    const received = structuredClone(value, { transfer });
    expect(buffer.byteLength).toBe(0);
    expect((received.args[0] as Uint8Array)[0]).toBe(42);
    expect((received.args[0] as Uint8Array).buffer).toBe(received.args[2]);
  });

  it('never transfers shared storage and tolerates repeated object references', () => {
    const value: { shared: Uint8Array; self?: unknown } = { shared: new Uint8Array(new SharedArrayBuffer(16)) };
    value.self = value;
    expect(collectTransferables(value)).toEqual([]);
  });
});
