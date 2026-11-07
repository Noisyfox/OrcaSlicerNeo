import { it, expect, vi } from 'vitest';
import { U1ObservationHub } from './monitor';
it('shares acquisition, stops after the last consumer and preserves independent operation retention', async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => 'state'), stale = vi.fn();
  const hub = new U1ObservationHub(read, stale, 10);
  try {
    const first = hub.retain(), second = hub.retain();
    await hub.refresh(); expect(read).toHaveBeenCalledTimes(1);
    first(); await vi.advanceTimersByTimeAsync(10); expect(read).toHaveBeenCalledTimes(2);
    second(); const count = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100); expect(read).toHaveBeenCalledTimes(count); expect(stale).toHaveBeenCalled();
    expect(hub.active).toBe(false);
  } finally { vi.useRealTimers(); }
});
it('bounds reconnect reads, retains stale data and only resumes after an explicit read', async () => {
  vi.useFakeTimers(); let fail = true;
  const read = vi.fn(async () => { if (fail) throw new Error('offline'); return 'state'; }), stale = vi.fn();
  const hub = new U1ObservationHub(read, stale, 10), release = hub.retain();
  try {
    await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(3); expect(stale).toHaveBeenCalledTimes(3);
    fail = false; await hub.refresh(); await vi.advanceTimersByTimeAsync(10); expect(read).toHaveBeenCalledTimes(5);
  } finally { release(); vi.useRealTimers(); }
});
it('aborting an observer releases only its lease while an operation continues', async () => {
  const hub = new U1ObservationHub(async () => 'state', () => {}, 10), release = hub.retain();
  const abort = new AbortController(), watcher = hub.watch(abort.signal)[Symbol.asyncIterator]();
  await watcher.next(); abort.abort(); await watcher.next(); expect(hub.active).toBe(true);
  release(); expect(hub.active).toBe(false);
});
