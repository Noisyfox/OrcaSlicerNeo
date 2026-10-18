import { expect, it, vi } from 'vitest';
import { CommittedEditorRefreshError, EditorSnapshotController } from './editorSnapshotController';

const snapshot = (revision: number) => ({ ok: true as const, revision, value: revision });
function harness() {
  let context = { owner: 'A', revision: 1, base: {} };
  const queued: Array<() => Promise<void>> = [];
  const read = vi.fn(async (stamp: typeof context) => snapshot(stamp.revision));
  const controller = new EditorSnapshotController({ context: () => context,
    same: (a, b) => a.owner === b.owner && a.revision === b.revision && a.base === b.base,
    sameOwner: (a, b) => a.owner === b.owner, readable: () => true, revision: stamp => stamp.revision,
    read, schedule: operation => new Promise<void>((resolve, reject) => queued.push(() => operation().then(resolve, reject))),
  });
  const advance = (owner = context.owner) => { context = { owner, revision: context.revision + 1, base: {} }; };
  const drain = async () => { const pending = controller.refresh(); await queued.shift()?.(); await pending; };
  return { controller, read, queued, advance, drain, context: () => context };
}

it('coalesces invalidations and reads the final context at FIFO execution', async () => {
  const h = harness(); h.controller.start();
  h.advance(); void h.controller.refresh(); h.advance(); void h.controller.refresh();
  expect(h.queued).toHaveLength(1); expect(h.read).not.toHaveBeenCalled();
  await h.drain();
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(h.controller.get().loaded?.snapshot.revision).toBe(3);
  await h.controller.refresh(); expect(h.queued).toHaveLength(0);
});

it('publishes an owned receipt inside the mutation reservation without scheduling another read', async () => {
  const h = harness(); h.controller.start(); await h.drain();
  await h.controller.mutate(async publish => {
    h.advance(); void h.controller.refresh(); h.advance(); void h.controller.refresh();
    expect(h.queued).toHaveLength(0);
    publish(snapshot(h.context().revision));
    // Still inside the command: a subscribed caller already has the final stamp.
    expect(h.controller.get().loaded?.context).toBe(h.context());
    expect(h.controller.get().pending).toBe(true);
    return snapshot(h.context().revision);
  });
  expect(h.read).toHaveBeenCalledTimes(1); expect(h.queued).toHaveLength(0);
  expect(h.controller.get().pending).toBe(false);
});

it('rejects late read publication after a target change and schedules the current owner once', async () => {
  const h = harness(); let finish!: (value: ReturnType<typeof snapshot>) => void;
  h.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  h.controller.start(); const first = h.controller.refresh(); const executing = h.queued.shift()!();
  h.advance('B'); void h.controller.refresh(); finish(snapshot(1)); await executing; await first;
  expect(h.controller.get().loaded).toBeNull(); expect(h.queued).toHaveLength(1);
  await h.drain(); expect(h.controller.get().loaded?.context.owner).toBe('B');
  expect(h.read).toHaveBeenCalledTimes(2);
});

it('keeps an accepted edit locked after refresh failure and does not retry the write or read automatically', async () => {
  const h = harness(); h.controller.start(); await h.drain();
  const operation = vi.fn(async () => { h.advance(); throw new CommittedEditorRefreshError(new Error('read failed')); });
  await expect(h.controller.mutate(operation)).rejects.toThrow('committed');
  await h.controller.refresh();
  expect(h.controller.get().error).toContain('read failed'); expect(h.queued).toHaveLength(0);
  expect(operation).toHaveBeenCalledTimes(1); expect(h.read).toHaveBeenCalledTimes(1);
  await expect(h.controller.mutate(operation)).rejects.toThrow('not ready'); expect(operation).toHaveBeenCalledTimes(1);
});

it('does not send queued native reads for an unmounted session', async () => {
  const h = harness(); h.controller.start(); const pending = h.controller.refresh(); h.controller.stop();
  await h.queued.shift()!(); await pending; expect(h.read).not.toHaveBeenCalled();
});

it('coalesces StrictMode effect replay without duplicating the native read', async () => {
  const h = harness(); h.controller.start(); h.controller.stop(); h.controller.start();
  expect(h.queued).toHaveLength(1); await h.drain(); expect(h.read).toHaveBeenCalledTimes(1);
});

it('reports a failed FIFO reservation instead of leaving an empty editor silently loading', async () => {
  const context = { revision: 1 };
  const read = vi.fn(async () => snapshot(1));
  const controller = new EditorSnapshotController({ context: () => context, same: (a, b) => a === b,
    sameOwner: (a, b) => a === b, readable: () => true, revision: stamp => stamp.revision, read,
    schedule: async () => { throw new Error('reservation rejected'); },
  });
  controller.start(); await controller.refresh();
  expect(controller.get().error).toContain('reservation rejected');
  expect(controller.get().refreshing).toBe(false); expect(read).not.toHaveBeenCalled();
});

it('accepts a current external read after geometry advances history beyond the configuration mirror', async () => {
  const h = harness(); h.read.mockResolvedValueOnce(snapshot(9));
  h.controller.start(); await h.drain();
  expect(h.controller.get().loaded?.snapshot.revision).toBe(9);
  expect(h.controller.get().loaded?.context.revision).toBe(1);
  expect(h.controller.get().error).toBeNull();
  await h.controller.refresh(); expect(h.read).toHaveBeenCalledTimes(1);
});
