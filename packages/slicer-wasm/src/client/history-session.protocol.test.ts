import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';
import { createWorkerClient, startWorker, type WorkerMessage, type WorkerTransport } from './worker';
import type { HistoryContext } from './history';

const context: HistoryContext = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
class Channel implements WorkerTransport {
  listeners: Array<(message: WorkerMessage) => void> = [];
  onMessage(fn: (message: WorkerMessage) => void) { this.listeners.push(fn); }
  post(message: WorkerMessage) { for (const fn of this.listeners) fn(structuredClone(message)); }
}
function tamper(operation: string, mutate: (value: any) => void) {
  const module = createMockModule();
  const call = module.ccall.bind(module);
  module.ccall = ((name, ret, types, args) => {
    const pointer = call(name, ret, types, args);
    if (name !== operation) return pointer;
    const raw = JSON.parse(module.UTF8ToString(Number(pointer)));
    module._free(Number(pointer));
    mutate(raw);
    const bytes = new TextEncoder().encode(JSON.stringify(raw) + '\0');
    const replacement = Number(module._malloc(bytes.length));
    module.HEAPU8.set(bytes, replacement);
    return replacement;
  }) as typeof module.ccall;
  return createClient(async () => module);
}

function guardedWorker(beforeRequest: (op: string) => Promise<void> | void) {
  const module = createMockModule();
  const nativeCalls: string[] = [];
  const ccall = module.ccall.bind(module);
  module.ccall = ((name, ret, types, args) => {
    nativeCalls.push(name);
    return ccall(name, ret, types, args);
  }) as typeof module.ccall;
  const channel = new Channel();
  startWorker(async () => module, message => channel.post(message), listener => channel.onMessage(listener), undefined, beforeRequest);
  return { client: createWorkerClient(channel), nativeCalls };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('editing session history transport', () => {
  it('acquires the session guard before asynchronous module initialization', async () => {
    const ready = deferred(), entered = deferred();
    const channel = new Channel();
    const module = createMockModule();
    const calls: string[] = [];
    const ccall = module.ccall.bind(module);
    module.ccall = ((name, ret, types, args) => { calls.push(name); return ccall(name, ret, types, args); }) as typeof module.ccall;
    startWorker(async () => { entered.resolve(); await ready.promise; return module; },
      message => channel.post(message), listener => channel.onMessage(listener));
    const client = createWorkerClient(channel);
    const opening = client.openHistorySession();
    await entered.promise;
    await expect(client.closeHistorySession('hs-1')).rejects.toThrow('in progress');
    await expect(client.beginHistory('Edit', 'project', context)).rejects.toThrow('in progress');
    await expect(client.resetHistory(context)).rejects.toThrow('in progress');
    expect(calls).toEqual([]);
    ready.resolve();
    const opened = await opening;
    await client.closeHistorySession(opened.sessionId);
  });

  it('rejects session transitions during deferred Undo so close cannot remove its floor', async () => {
    const wait = deferred();
    let hold = false;
    const { client, nativeCalls } = guardedWorker(op => hold && op === 'undoHistory' ? wait.promise : undefined);
    await client.resetHistory(context);
    await client.runProjectHistoryTransaction('Before', 'project', context, () => client.addShape('Cube'), context);
    const session = await client.openHistorySession();
    hold = true;
    const undo = client.undoHistory();
    const nativeBefore = [...nativeCalls];
    await expect(client.closeHistorySession(session.sessionId)).rejects.toThrow('in progress');
    await expect(client.openHistorySession()).rejects.toThrow('in progress');
    expect(nativeCalls).toEqual(nativeBefore);
    wait.resolve();
    await expect(undo).rejects.toThrow('floor');
    expect((await client.getHistoryStatus()).cursor).toBe(session.status.cursor);
    await client.closeHistorySession(session.sessionId);
  });

  it.each(['openHistorySession', 'closeHistorySession'] as const)('guards conflicts while %s is deferred and releases after success/failure', async operation => {
    for (const fails of [false, true]) {
      const wait = deferred();
      let hold = false;
      const { client, nativeCalls } = guardedWorker(op => hold && op === operation ? wait.promise : undefined);
      await client.resetHistory(context);
      const session = operation === 'closeHistorySession' ? await client.openHistorySession() : null;
      hold = true;
      const pending = operation === 'openHistorySession' ? client.openHistorySession() : client.closeHistorySession(session!.sessionId);
      const nativeBefore = [...nativeCalls];
      for (const conflict of [
        () => client.openHistorySession(), () => client.closeHistorySession('hs-1'),
        () => client.beginHistory('Edit', 'project', context), () => client.undoHistory(),
        () => client.redoHistory(), () => client.jumpHistory('entry-1', 'undo'), () => client.resetHistory(context),
      ]) await expect(conflict()).rejects.toThrow('in progress');
      expect(nativeCalls).toEqual(nativeBefore);
      hold = false;
      if (fails) {
        const failed = expect(pending).rejects.toThrow('deferred failure');
        wait.reject(new Error('deferred failure'));
        await failed;
        expect(nativeCalls).toEqual(nativeBefore);
      } else { wait.resolve(); await pending; }
      // An idle editing session is not an exclusive transaction: ordinary edits work.
      await client.runProjectHistoryTransaction('Edit', 'project', context, () => client.addShape('Cube'), context);
      const current = await client.getHistoryStatus();
      expect(current.canUndo).toBe(true);
      if (current.editingSession) await client.closeHistorySession(current.editingSession.id);
      else await client.openHistorySession();
    }
  });

  it('retains the starting-transaction guard when a duplicate begin is rejected', async () => {
    const wait = deferred();
    let hold = true;
    const { client, nativeCalls } = guardedWorker(op => hold && op === 'beginHistory' ? wait.promise : undefined);
    const pending = client.beginHistory('Edit', 'project', context);
    const nativeBefore = [...nativeCalls];
    await expect(client.beginHistory('Duplicate', 'project', context)).rejects.toThrow('already active');
    await expect(client.openHistorySession()).rejects.toThrow('transaction is active');
    await expect(client.closeHistorySession('hs-1')).rejects.toThrow('transaction is active');
    expect(nativeCalls).toEqual(nativeBefore);
    hold = false; wait.resolve();
    const transaction = await pending;
    await expect(client.openHistorySession()).rejects.toThrow('transaction is active');
    await expect(client.closeHistorySession('hs-1')).rejects.toThrow('transaction is active');
    await client.abortHistory(transaction);
    await client.openHistorySession();
  });

  it('guards session transitions against deferred reset and releases after native rejection', async () => {
    const wait = deferred();
    let hold = true;
    const { client, nativeCalls } = guardedWorker(op => hold && op === 'resetHistory' ? wait.promise : undefined);
    const reset = client.resetHistory(context);
    const nativeBefore = [...nativeCalls];
    await expect(client.openHistorySession()).rejects.toThrow('in progress');
    await expect(client.closeHistorySession('hs-1')).rejects.toThrow('in progress');
    expect(nativeCalls).toEqual(nativeBefore);
    hold = false; wait.resolve(); await reset;
    await expect(client.closeHistorySession('hs-999')).rejects.toThrow('stale');
    const opened = await client.openHistorySession();
    await expect(client.openHistorySession()).rejects.toThrow('busy');
    await client.closeHistorySession(opened.sessionId);
  });

  it('round trips floor-filtered status, interleaved edits, stale handles and reset through the existing Worker', async () => {
    const channel = new Channel();
    startWorker(async () => createMockModule(), message => channel.post(message), listener => channel.onMessage(listener));
    const client = createWorkerClient(channel);
    await client.resetHistory(context);
    await client.runProjectHistoryTransaction('Before', 'project', context, () => client.addShape('Cube'), context);
    const before = await client.getHistoryStatus();
    const opened = await client.openHistorySession();
    expect(opened.status).toMatchObject({ dirty: before.dirty, cursor: before.cursor,
      activeTransactionId: null, navigationFloor: before.cursor, canUndo: false, undoEntries: [],
      editingSession: { id: opened.sessionId, hasEffectiveCommit: false } });
    await expect(client.openHistorySession()).rejects.toThrow('busy');
    await expect(client.undoHistory()).rejects.toThrow('floor');
    await client.runProjectHistoryTransaction('Inside', 'project', context, () => client.addShape('Cube'), context);
    expect(await client.getHistoryStatus()).toMatchObject({ canUndo: true,
      undoEntries: [{ label: 'Inside' }], editingSession: { hasEffectiveCommit: true } });
    const closed = await client.closeHistorySession(opened.sessionId);
    expect(closed.editingSession).toBeNull();
    expect(closed.navigationFloor).toBeNull();
    expect(closed.undoEntries.map(entry => entry.label)).toEqual(['Inside', 'Before']);
    await expect(client.closeHistorySession(opened.sessionId)).rejects.toThrow('stale');
    const next = await client.openHistorySession();
    expect(next.sessionId).not.toBe(opened.sessionId);
    expect(await client.resetHistory(context)).toMatchObject({ editingSession: null, navigationFloor: null });
    await expect(client.closeHistorySession(next.sessionId)).rejects.toThrow('stale');
    expect((await client.openHistorySession()).sessionId).not.toBe(next.sessionId);
  });


  it('permits Redo navigation without inventing an effective session commit', async () => {
    const client = createClient(async () => createMockModule());
    await client.resetHistory(context);
    await client.runProjectHistoryTransaction('Earlier', 'project', context, () => client.addShape('Cube'), context);
    await client.undoHistory();
    const opened = await client.openHistorySession();
    expect((await client.redoHistory()).ok).toBe(true);
    expect(await client.getHistoryStatus()).toMatchObject({ editingSession: { hasEffectiveCommit: false }, canUndo: true });
    await client.undoHistory();
    expect(await client.closeHistorySession(opened.sessionId)).toMatchObject({ canRedo: true });
  });

  it('invalidates a saved future checkpoint when effective-session close discards Redo', async () => {
    const client = createClient(async () => createMockModule());
    await client.resetHistory(context);
    const session = await client.openHistorySession();
    await client.runProjectHistoryTransaction('Edit', 'project', context, () => client.addShape('Cube'), context);
    await client.markHistorySaved();
    await client.undoHistory();
    const closed = await client.closeHistorySession(session.sessionId);
    expect(closed).toMatchObject({ savedCheckpoint: null, savedCheckpointEvicted: true, dirty: true, canRedo: false });
  });

  it.each([
    (s: any) => { delete s.editingSession; },
    (s: any) => { delete s.navigationFloor; },
    (s: any) => { s.navigationFloor = 0; },
    (s: any) => { s.canUndo = true; },
    (s: any) => { s.cursor = -1; },
    (s: any) => { s.revision = 0.5; },
    (s: any) => { s.savedCheckpoint = '0'; },
    (s: any) => { s.undoEntries = [{}]; },
    (s: any) => { delete s.dirty; },
  ])('rejects malformed or contradictory status %#', async mutate => {
    await expect(tamper('orc_history_status', mutate).getHistoryStatus()).rejects.toThrow('invalid history status');
  });

  it.each([
    (r: any) => { r.sessionId = 'hs-01'; },
    (r: any) => { r.sessionId = 'hs-18446744073709551616'; },
    (r: any) => { r.sessionId += '\0junk'; },
    (r: any) => { r.status.editingSession.id = 'hs-999'; },
    (r: any) => { r.status.editingSession.hasEffectiveCommit = true; },
    (r: any) => { r.status.editingSession.entryTimestamp = 1; },
    (r: any) => { r.status.navigationFloor = null; },
    (r: any) => { r.status.activeTransactionId = 'tx-1'; },
  ])('rejects malformed or contradictory open receipt %#', async mutate => {
    await expect(tamper('orc_history_session_open', mutate).openHistorySession()).rejects.toThrow('invalid history');
  });

  it('rejects contradictory close receipt and invalid request handles', async () => {
    const client = tamper('orc_history_session_close', r => { r.status.navigationFloor = 0; });
    const open = await client.openHistorySession();
    await expect(client.closeHistorySession(open.sessionId)).rejects.toThrow('invalid history');
    for (const id of ['hs-0', 'hs-01', 'hs-1x', 'hs-1\0', 'hs-18446744073709551616'])
      await expect(client.closeHistorySession(id)).rejects.toThrow('invalid history session close request');
  });

  it('rejects opening and closing before posting while serial slicing is busy', async () => {
    const posted: WorkerMessage[] = [];
    let receive!: (message: WorkerMessage) => void;
    const client = createWorkerClient({ post: message => posted.push(message), onMessage: listener => { receive = listener; } });
    receive({ type: 'runtime-state', threaded: false, serialTerminalEpoch: '0' });
    const slice = client.slice({});
    await expect(client.openHistorySession()).rejects.toThrow('slice_busy');
    await expect(client.closeHistorySession('hs-1')).rejects.toThrow('slice_busy');
    expect(posted).toHaveLength(1);
    const request = posted[0];
    if (request.type !== 'request') throw new Error('missing slice request');
    receive({ type: 'response', id: request.id, ok: true, result: { ok: false, error: 'cancelled' } });
    await slice;
  });
});
