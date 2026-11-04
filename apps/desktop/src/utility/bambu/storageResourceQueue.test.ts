import { afterEach, expect, it, vi } from 'vitest';
import { StorageResourceQueue } from './storageResourceQueue';
const queues: StorageResourceQueue[] = [];
afterEach(async () => { await Promise.all(queues.splice(0).map(queue => queue.close())); vi.useRealTimers(); });
function fixture() { vi.useFakeTimers(); const queue = new StorageResourceQueue(); queues.push(queue); return queue; }
const request = (name: string) => ({ path: `/${name}.3mf`, resource: 'thumbnail' });
it('batches visible resources and deduplicates the same resource without sharing between devices', async () => {
  const queue = fixture(), read = vi.fn(async requests => requests.map(() => new Uint8Array([1])));
  const a = queue.read('printer-a', request('one'), read), duplicate = queue.read('printer-a', request('one'), read);
  const b = queue.read('printer-a', request('two'), read), other = queue.read('printer-b', request('one'), read);
  await vi.advanceTimersByTimeAsync(8);
  expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls.map(call => call[0].length)).toEqual([2, 1]);
  expect(await Promise.all([a, duplicate, b, other])).toEqual(Array.from({ length: 4 }, () => new Uint8Array([1])));
});
it('splits a large viewport into bounded batches on one device', async () => {
  const queue = fixture(), read = vi.fn(async requests => requests.map(() => null));
  const jobs = Array.from({ length: 12 }, (_, i) => queue.read('printer', request(String(i)), read));
  await vi.advanceTimersByTimeAsync(16); expect(await Promise.all(jobs)).toHaveLength(12);
  expect(read.mock.calls.map(call => call[0].length)).toEqual([8, 4]);
});
it('drops cancelled queued work before opening any connection', async () => {
  const queue = fixture(), abort = new AbortController(), read = vi.fn();
  const result = queue.read('printer', request('one'), read, abort.signal).catch(error => error);
  abort.abort(); await vi.advanceTimersByTimeAsync(8);
  expect((await result).detail.code).toBe('cancelled'); expect(read).not.toHaveBeenCalled();
});
it('cancels one active consumer without aborting the other, and joins shared shutdown', async () => {
  const queue = fixture(), abort = new AbortController(); let finish!: () => void, signal!: AbortSignal;
  const read = vi.fn(async (_requests, input) => { signal = input; await new Promise<void>(resolve => { finish = resolve; input.addEventListener('abort', () => resolve(), { once: true }); }); return [null, null]; });
  const first = queue.read('printer', request('one'), read, abort.signal).catch(error => error);
  const second = queue.read('printer', request('two'), read);
  await vi.advanceTimersByTimeAsync(8); abort.abort(); expect(signal.aborted).toBe(false);
  finish(); expect((await first).detail.code).toBe('cancelled'); expect(await second).toBeNull();
  const third = queue.read('printer', request('three'), read).catch(error => error);
  await vi.advanceTimersByTimeAsync(8); await queue.close(); expect(signal.aborted).toBe(true);
  expect((await third).detail.code).toBe('cancelled');
});

it('coalesces resources above the former batch budget and gives each consumer an independent copy', async () => {
  const queue = fixture(), value = new Uint8Array(17 * 1024 * 1024); value[value.length - 1] = 7;
  const read = vi.fn(async (_requests, _signal) => [value]);
  const a = queue.read('printer', request('one'), read), b = queue.read('printer', request('one'), read);
  await vi.advanceTimersByTimeAsync(8);
  expect(read).toHaveBeenCalledOnce(); expect(read.mock.calls[0][0]).toEqual([request('one')]);
  const first = (await a)!, second = (await b)!;
  expect(first.byteLength).toBe(value.byteLength); expect(second.byteLength).toBe(value.byteLength);
  expect(first[first.length - 1]).toBe(7); first[first.length - 1] = 9;
  expect(second[second.length - 1]).toBe(7); expect(value[value.length - 1]).toBe(7);
});
