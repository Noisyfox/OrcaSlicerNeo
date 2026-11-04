import { describe, expect, it, vi } from 'vitest';
import { TransferQueue, type TransferCompletion, type TransferSnapshot } from './transferQueue';

const done = { status: 'finished' } as const;
const blocked = { status: 'blocked', reason: { code: 'offline', message: 'Printer disconnected.' } } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe('physical printer transfer admission', () => {
  it('serializes download and playback in FIFO order while a different printer progresses', async () => {
    const queue = new TransferQueue(2), first = deferred<TransferCompletion>(), calls: string[] = [];
    const start = (key: string, label: string, wait = Promise.resolve(done)) => queue.enqueue({
      physicalPrinterKey: key, run: async () => { calls.push(label); return wait; },
    });
    const download1 = start('physical-a', 'download-route-a', first.promise as Promise<typeof done>);
    const download2 = start('physical-a', 'download-route-b');
    const playback = start('physical-a', 'playback');
    const other = start('physical-b', 'other');
    await tick(); expect(calls).toEqual(['download-route-a', 'other']);
    await other.finished;
    first.resolve(done); await Promise.all([download1.finished, download2.finished, playback.finished]);
    expect(calls).toEqual(['download-route-a', 'other', 'download-route-b', 'playback']);
  });

  it('bounds global active readers and does not starve earlier eligible printers', async () => {
    const queue = new TransferQueue(1), gate = deferred<TransferCompletion>(), calls: string[] = [];
    const first = queue.enqueue({ physicalPrinterKey: 'a', run: () => gate.promise });
    const second = queue.enqueue({ physicalPrinterKey: 'b', run: async () => { calls.push('b'); return done; } });
    const third = queue.enqueue({ physicalPrinterKey: 'a', run: async () => { calls.push('a'); return done; } });
    await tick(); expect(calls).toEqual([]);
    gate.resolve(done); await Promise.all([first.finished, second.finished, third.finished]);
    expect(calls).toEqual(['b', 'a']);
  });

  it('removes queued playback on cancellation without opening a reader or reordering downloads', async () => {
    const queue = new TransferQueue(1), gate = deferred<TransferCompletion>(), read = vi.fn(async () => done);
    const first = queue.enqueue({ physicalPrinterKey: 'a', run: () => gate.promise });
    const playback = queue.enqueue({ physicalPrinterKey: 'a', run: read });
    const last = queue.enqueue({ physicalPrinterKey: 'a', run: async () => done });
    playback.cancel(); await playback.finished;
    await tick(); expect(read).not.toHaveBeenCalled(); expect(last.snapshot().state).toBe('waiting');
    gate.resolve(done); await Promise.all([first.finished, last.finished]);
  });

  it('retains the active slot until canceled reading and cleanup settle', async () => {
    const queue = new TransferQueue(2), cleanup = deferred<TransferCompletion>();
    let signal!: AbortSignal;
    const first = queue.enqueue({ physicalPrinterKey: 'a', run: async context => { signal = context.signal; return cleanup.promise; } });
    const read = vi.fn(async () => done);
    const next = queue.enqueue({ physicalPrinterKey: 'a', run: read });
    await tick(); first.cancel();
    expect(signal.aborted).toBe(true); expect(first.snapshot().state).toBe('stopping');
    let finished = false; void first.finished.then(() => { finished = true; });
    await tick(); expect(read).not.toHaveBeenCalled(); expect(finished).toBe(false);
    cleanup.resolve(done); await next.finished; expect(finished).toBe(true);
  });

  it('keeps a disconnected head blocked, retries it in place, and does not block another printer', async () => {
    const queue = new TransferQueue(2), attempts: number[] = [], calls: string[] = [];
    const head = queue.enqueue({ physicalPrinterKey: 'a', run: async ({ attempt }) => {
      attempts.push(attempt); calls.push('head'); return attempt === 1 ? blocked : done;
    } });
    const tail = queue.enqueue({ physicalPrinterKey: 'a', run: async () => { calls.push('tail'); return done; } });
    const other = queue.enqueue({ physicalPrinterKey: 'b', run: async () => { calls.push('other'); return done; } });
    await other.finished; await tick();
    expect(head.snapshot()).toEqual({ state: 'blocked', attempt: 1, reason: blocked.reason });
    expect(tail.snapshot().state).toBe('waiting');
    expect(head.retry()).toBe(true); expect(head.retry()).toBe(false);
    await Promise.all([head.finished, tail.finished]);
    expect(attempts).toEqual([1, 2]); expect(calls).toEqual(['head', 'other', 'head', 'tail']);
  });

  it.each(['continue', 'cancel'] as const)('%s resolves only the blocked head and releases later work', async action => {
    const queue = new TransferQueue(1);
    const head = queue.enqueue({ physicalPrinterKey: 'a', run: async () => blocked });
    const tail = queue.enqueue({ physicalPrinterKey: 'a', run: async () => done });
    await tick(); head[action](); await Promise.all([head.finished, tail.finished]);
    expect(head.retry()).toBe(false); expect(head.continue()).toBe(false);
  });

  it('isolates observers and copied snapshots from scheduler state', async () => {
    const queue = new TransferQueue(1), snapshots: TransferSnapshot[] = [];
    const head = queue.enqueue({ physicalPrinterKey: 'a', run: async () => blocked, changed: snapshot => {
      snapshots.push(snapshot); snapshot.state = 'finished'; if (snapshot.reason) snapshot.reason.message = 'mutated';
      throw new Error('view failed');
    } });
    await tick(); expect(head.snapshot().state).toBe('blocked'); expect(head.snapshot().reason).toEqual(blocked.reason);
    const external = head.snapshot(); external.reason!.code = 'cancelled';
    expect(head.snapshot().reason!.code).toBe('offline');
    expect(snapshots.length).toBe(3); head.cancel(); await head.finished;
  });

  it('closes admission before shutdown callbacks and joins cancellation cleanup', async () => {
    const queue = new TransferQueue(1), cleanup = deferred<TransferCompletion>();
    const active = queue.enqueue({ physicalPrinterKey: 'a', run: async () => cleanup.promise });
    const queued = queue.enqueue({ physicalPrinterKey: 'b', run: vi.fn(async () => done) });
    await tick(); const stopped = queue.stop(); expect(queue.stop()).toBe(stopped);
    expect(() => queue.enqueue({ physicalPrinterKey: 'a', run: async () => done })).toThrow('closed');
    expect(queued.snapshot().state).toBe('finished'); expect(active.snapshot().state).toBe('stopping');
    let settled = false; void stopped.then(() => { settled = true; });
    await tick(); expect(settled).toBe(false);
    cleanup.resolve(done); await stopped; expect(settled).toBe(true);
  });

  it('handles reentrant cancellation before the reader is opened', async () => {
    const queue = new TransferQueue(1), read = vi.fn(async () => done);
    const ticket = queue.enqueue({ physicalPrinterKey: 'a', run: read,
      changed: snapshot => { if (snapshot.state === 'running') ticket.cancel(); } });
    await ticket.finished; expect(read).not.toHaveBeenCalled();
  });

  it('turns unexpected executor rejection into an acknowledged block without leaking details', async () => {
    const queue = new TransferQueue(1);
    const ticket = queue.enqueue({ physicalPrinterKey: 'a', run: async () => { throw new Error('/secret/path'); } });
    await tick(); expect(ticket.snapshot().reason?.message).toBe('The transfer executor failed.');
    expect(ticket.snapshot().state).toBe('blocked'); await queue.stop();
  });
});
