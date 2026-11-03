import { afterEach, expect, it, vi } from 'vitest';
import type { BambuStorageResourceReader } from '@orca/bambu-native';
import { StorageResourceConnections } from './storageResourceConnections';
const pools: StorageResourceConnections[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.close())); vi.useRealTimers(); });
const requests = [{ path: '/part.3mf', resource: 'thumbnail', maxBytes: 16 }];
function fixture() {
  vi.useFakeTimers(); const pool = new StorageResourceConnections(); pools.push(pool);
  const readers: { read: ReturnType<typeof vi.fn<BambuStorageResourceReader['read']>>; close: ReturnType<typeof vi.fn> }[] = [];
  const open = vi.fn(async (_signal: AbortSignal) => { const reader = { read: vi.fn<BambuStorageResourceReader['read']>(async input => input.map(() => null)), close: vi.fn(async () => {}) }; readers.push(reader); return reader; });
  const read = (key: string, signal = new AbortController().signal) => pool.read(key, requests, open, signal);
  return { pool, readers, open, read };
}
it('reuses one connection for sequential batches and closes it after the idle lease', async () => {
  const f = fixture(); await f.read('device'); await f.read('device');
  expect(f.open).toHaveBeenCalledTimes(1); expect(f.readers[0].read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000); expect(f.readers[0].close).toHaveBeenCalledOnce();
  await f.read('device'); expect(f.open).toHaveBeenCalledTimes(2);
});
it('evicts idle connections before opening a third device and discards changed configuration', async () => {
  const f = fixture(); await f.read('a'); await f.read('b'); await f.read('c');
  expect(f.readers[0].close).toHaveBeenCalledOnce(); expect(f.readers[1].close).not.toHaveBeenCalled();
  await f.pool.reconcile(async key => key === 'b'); expect(f.readers[2].close).toHaveBeenCalledOnce();
});
it('closes a failed reader rather than reusing its uncertain protocol state', async () => {
  const f = fixture(); await f.read('a'); f.readers[0].read.mockRejectedValueOnce(new Error('failed'));
  await expect(f.read('a')).rejects.toThrow('failed'); expect(f.readers[0].close).toHaveBeenCalledOnce();
  await f.read('a'); expect(f.open).toHaveBeenCalledTimes(2);
});
it('aborts a shared native read and joins its close on application shutdown', async () => {
  const f = fixture(); let resolveClose!: () => void;
  f.open.mockImplementationOnce(async signal => ({ read: vi.fn(async () => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); throw new Error('stopped'); }),
    close: vi.fn(async () => { await new Promise<void>(resolve => { resolveClose = resolve; }); }) }));
  const reading = f.read('a').catch(error => error);
  await Promise.resolve(); const closing = f.pool.close(); await Promise.resolve(); await Promise.resolve();
  expect(resolveClose).toBeTypeOf('function'); resolveClose(); await closing;
  expect((await reading).message).toBe('stopped');
});

it('does not create a replacement connection when shutdown races idle eviction', async () => {
  const f = fixture(); await f.read('a'); await f.read('b'); let finish!: () => void;
  f.readers[0].close.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); });
  const replacing = f.read('c').catch(error => error);
  await Promise.resolve(); const closing = f.pool.close(); finish(); await closing;
  expect((await replacing).detail.code).toBe('cancelled'); expect(f.open).toHaveBeenCalledTimes(2);
});
