// packages/slicer-wasm/src/client/worker.ts
// ----------------------------------------------------------------
// Web Worker glue. startWorker() installs the message handler in a
// worker context (self); createWorkerClient() drives it from the
// main thread. All bridge work happens on the worker thread; binary
// buffers travel as transferable ArrayBuffers.
//
// Protocol:
//   main → worker: {type:'request', id, op, args}
//   worker → main: {type:'response', id, ok, result}
//   worker → main: {type:'progress', percent, text}   (no id)
// ----------------------------------------------------------------
import type { SlicerClient, OrcaModuleFactory, ProgressMailbox } from './types';
import type { HistoryDiagnosticLayer, HistoryTransportDiagnostics, HistoryTimingDiagnostic, RestoreResult } from './history';
import { createClient } from './client';

export type WorkerMessage =
  | { type: 'request'; id: number; op: string; args: unknown[] }
  | { type: 'response'; id: number; ok: boolean; result: unknown; error?: string }
  | { type: 'history-diagnostic'; diagnostic: HistoryWorkerDiagnostic }
  | { type: 'progress'; percent: number; text: string }
  | { type: 'progress-mailbox'; mailbox: ProgressMailbox };

export interface HistoryWorkerDiagnostic {
  readonly kind: 'mutation' | 'restore';
  readonly path?: 'direct' | 'full';
  readonly durationMs: number;
}

export interface WorkerTransport {
  post(msg: WorkerMessage, transfer?: Transferable[]): void;
  onMessage(fn: (msg: WorkerMessage) => void): void;
}

const historyMutationOperations = new Set([
  'selectFilamentSlotPreset', 'setFilamentSlotColour', 'addFilamentSlot',
  'deleteFilamentSlot', 'mergeFilamentSlots', 'assignFilament',
  'setFilamentRouting', 'movePrimeTower',
]);

function historyNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isRestoreOperation(operation: string): boolean {
  return operation === 'undoHistory' || operation === 'redoHistory' || operation === 'jumpHistory';
}

function restorePath(result: unknown): 'direct' | 'full' {
  const impact = (result as RestoreResult | undefined)?.ok
    ? (result as Extract<RestoreResult, { ok: true }>).impact : undefined;
  return impact?.model === 'none' ? 'direct' : 'full';
}

function emptyTiming(): HistoryTimingDiagnostic {
  return { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
}

function emptyLayer(): HistoryDiagnosticLayer {
  return { mutation: emptyTiming(), restore: emptyTiming(), directRestore: emptyTiming(), fullRestore: emptyTiming() };
}

function recordTiming(layer: HistoryDiagnosticLayer, key: keyof HistoryDiagnosticLayer, durationMs: number): HistoryDiagnosticLayer {
  const duration = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  const current = layer[key];
  const next = { count: current.count + 1, totalMs: current.totalMs + duration,
    maxMs: Math.max(current.maxMs, duration), lastMs: duration };
  return { ...layer, [key]: next };
}

function copyLayer(layer: HistoryDiagnosticLayer): HistoryDiagnosticLayer {
  return {
    mutation: { ...layer.mutation }, restore: { ...layer.restore },
    directRestore: { ...layer.directRestore }, fullRestore: { ...layer.fullRestore },
  };
}

function copyDiagnostics(diagnostics: HistoryTransportDiagnostics): HistoryTransportDiagnostics {
  return { version: 1, worker: copyLayer(diagnostics.worker), client: copyLayer(diagnostics.client) };
}

function collectTransferables(value: unknown): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  const visit = (item: unknown): void => {
    if (ArrayBuffer.isView(item)) {
      const buffer = item.buffer;
      // SharedArrayBuffer cannot be transferred; preview result arrays are
      // ordinary copied ArrayBuffers, while progress mailbox is only sent in
      // its dedicated message and is intentionally shared.
      if (buffer instanceof ArrayBuffer) buffers.add(buffer);
      return;
    }
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (item && typeof item === 'object')
      Object.values(item as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return [...buffers];
}

export function startWorker(
  moduleFactory: OrcaModuleFactory,
  post: (msg: WorkerMessage, transfer?: Transferable[]) => void = (msg, transfer) =>
    (self as unknown as { postMessage(m: WorkerMessage, t?: Transferable[]): void }).postMessage(msg, transfer),
  onMessage: (fn: (msg: WorkerMessage) => void) => void = (fn) => {
    (self as unknown as { onmessage: (e: MessageEvent<WorkerMessage>) => void }).onmessage = (e) => fn(e.data);
  },
  beforeInit?: (module: import('./types').OrcaModule) => Promise<void>,
  beforeRequest?: (op: string, args: unknown[]) => Promise<void> | void,
): void {
  // Serial builds forward their permanent bridge callback. Threaded builds
  // send a SharedArrayBuffer mailbox; the renderer polls it independently
  // while this worker is synchronously executing a long native operation.
  const client = createClient(moduleFactory, (pct, text) => {
    post({ type: 'progress', percent: pct, text });
  }, (mailbox) => {
    post({ type: 'progress-mailbox', mailbox });
  }, beforeInit);

  // The default remains one writer.  A coalesced child may be nested under
  // the active writer and is popped only after its commit/abort.
  const activeTransactionIds: string[] = [];
  let transactionStarting = false;
  let restoreInFlight = false;
  const historyTransactionStartedAts: number[] = [];

  onMessage(async (msg) => {
    if (msg.type !== 'request') return;
    const { id, op, args } = msg;
    const startedAt = historyNow();
    const isRestore = op === 'undoHistory' || op === 'redoHistory' || op === 'jumpHistory';
    if (isRestore && restoreInFlight) {
      post({ type: 'response', id, ok: false, result: undefined, error: 'history restore is already in progress' });
      return;
    }
    if (isRestore) restoreInFlight = true;
    try {
      const method = (client as unknown as Record<string, (...a: unknown[]) => unknown>)[op];
      if (typeof method !== 'function') throw new Error(`unknown op: ${op}`);
      const callArgs = args ?? [];
      if (op === 'beginHistory') {
        const nested = activeTransactionIds.length > 0;
        if (transactionStarting || (!nested && activeTransactionIds.length > 0))
          throw new Error('history transaction is already active');
        if ((callArgs.length !== 3 && callArgs.length !== 4) || typeof callArgs[0] !== 'string' ||
            (callArgs[1] !== 'project' && callArgs[1] !== 'context') ||
            !callArgs[2] || typeof callArgs[2] !== 'object')
          throw new Error('malformed history begin request');
        if (nested && (!callArgs[3] || typeof callArgs[3] !== 'object' ||
            (callArgs[3] as Record<string, unknown>).coalesce !== true ||
            (callArgs[3] as Record<string, unknown>).parentTransactionId !== activeTransactionIds[activeTransactionIds.length - 1]))
          throw new Error('history transaction is already active');
        transactionStarting = true;
      } else if (op === 'commitHistory' || op === 'abortHistory') {
        if (callArgs.length < 1 || typeof callArgs[0] !== 'string' ||
            activeTransactionIds.length === 0 || callArgs[0] !== activeTransactionIds[activeTransactionIds.length - 1])
          throw new Error('history transaction is stale or belongs to another writer');
        if (op === 'commitHistory' && (callArgs.length !== 2 || !callArgs[1] || typeof callArgs[1] !== 'object'))
          throw new Error('malformed history commit request');
      } else if (op === 'undoHistory' || op === 'redoHistory' || op === 'jumpHistory') {
        if (activeTransactionIds.length > 0 || transactionStarting)
          throw new Error('history transaction is active');
        if (op === 'jumpHistory' && (callArgs.length !== 2 || typeof callArgs[0] !== 'string' ||
            (callArgs[1] !== 'undo' && callArgs[1] !== 'redo')))
          throw new Error('malformed history jump request');
      }
      await beforeRequest?.(op, callArgs);
      // Preserve the client receiver for composed operations such as
      // preflightProject(), which delegates to this.loadProject(). The
      // dispatcher previously invoked a detached method and made `this`
      // undefined in the worker even though the public client contract was
      // otherwise valid.
      const result = await method.apply(client, callArgs);
      if (op === 'beginHistory') {
        if (typeof result !== 'string' || result.length === 0) throw new Error('malformed history transaction id');
        activeTransactionIds.push(result);
        transactionStarting = false;
        historyTransactionStartedAts.push(startedAt);
      } else if (op === 'commitHistory' || op === 'abortHistory') {
        activeTransactionIds.pop();
      }
      if (isRestore) {
        post({ type: 'history-diagnostic', diagnostic: {
          kind: 'restore', path: restorePath(result), durationMs: historyNow() - startedAt,
        } });
      } else if (op === 'commitHistory' || op === 'abortHistory') {
        const mutationStartedAt = historyTransactionStartedAts.pop() ?? startedAt;
        post({ type: 'history-diagnostic', diagnostic: {
          kind: 'mutation', durationMs: historyNow() - mutationStartedAt,
        } });
      } else if (historyMutationOperations.has(op)) {
        post({ type: 'history-diagnostic', diagnostic: {
          kind: 'mutation', durationMs: historyNow() - startedAt,
        } });
      }
      post({ type: 'response', id, ok: true, result }, collectTransferables(result));
    } catch (err) {
      if (op === 'beginHistory') transactionStarting = false;
      post({ type: 'response', id, ok: false, result: undefined, error: String(err) });
    } finally {
      if (isRestore) restoreInFlight = false;
    }
  });
}

export function createWorkerClient(transport: WorkerTransport): SlicerClient {
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    op: string;
    startedAt: number;
  }>();
  const progressListeners = new Set<(pct: number, text: string) => void>();
  let mailbox: ProgressMailbox | undefined;
  let mailboxTimer: ReturnType<typeof setInterval> | undefined;
  let lastMailboxSequence = -1;
  const decoder = new TextDecoder();
  let diagnostics: HistoryTransportDiagnostics = { version: 1, worker: emptyLayer(), client: emptyLayer() };

  function recordLayer(layer: 'worker' | 'client', diagnostic: HistoryWorkerDiagnostic): void {
    let next = recordTiming(diagnostics[layer], diagnostic.kind === 'mutation' ? 'mutation' : 'restore', diagnostic.durationMs);
    if (diagnostic.kind === 'restore')
      next = recordTiming(next, diagnostic.path === 'direct' ? 'directRestore' : 'fullRestore', diagnostic.durationMs);
    diagnostics = { ...diagnostics, [layer]: next };
  }

  function emitMailboxProgress(): void {
    if (!mailbox) return;
    const words = new Int32Array(mailbox.buffer, mailbox.byteOffset, 4);
    const before = Atomics.load(words, 0);
    if ((before & 1) !== 0 || before === lastMailboxSequence) return;
    const percent = Atomics.load(words, 1);
    const length = Math.min(Atomics.load(words, 2), mailbox.textCapacity);
    // Chromium intentionally rejects SharedArrayBuffer-backed views in
    // TextDecoder. Copy this tiny (<=512 byte) status payload after the
    // sequence read; the second sequence check below rejects a torn copy.
    const textBytes = new Uint8Array(length);
    textBytes.set(new Uint8Array(mailbox.buffer, mailbox.byteOffset + 16, length));
    const text = decoder.decode(textBytes);
    // A writer may have begun while the bytes were copied. Discard that read
    // rather than emitting a torn status string.
    if (before !== Atomics.load(words, 0)) return;
    lastMailboxSequence = before;
    for (const listener of progressListeners) listener(percent, text);
  }

  function updateMailboxPolling(): void {
    if (progressListeners.size > 0 && mailbox && !mailboxTimer) {
      mailboxTimer = setInterval(emitMailboxProgress, 40);
      emitMailboxProgress();
    } else if (progressListeners.size === 0 && mailboxTimer) {
      clearInterval(mailboxTimer);
      mailboxTimer = undefined;
    }
  }

  transport.onMessage((msg) => {
    if (msg.type === 'history-diagnostic') {
      recordLayer('worker', msg.diagnostic);
      return;
    }
    if (msg.type === 'progress') {
      for (const l of progressListeners) l(msg.percent, msg.text);
      return;
    }
    if (msg.type === 'progress-mailbox') {
      mailbox = msg.mailbox;
      lastMailboxSequence = -1;
      updateMailboxPolling();
      return;
    }
    if (msg.type !== 'response') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) {
      if (isRestoreOperation(p.op))
        recordLayer('client', { kind: 'restore', path: restorePath(msg.result), durationMs: historyNow() - p.startedAt });
      else if (historyMutationOperations.has(p.op))
        recordLayer('client', { kind: 'mutation', durationMs: historyNow() - p.startedAt });
      p.resolve(msg.result);
    }
    else p.reject(new Error(msg.error ?? 'worker error'));
  });

  function call(op: string, args: unknown[]): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, op, startedAt: historyNow() });
      transport.post({ type: 'request', id, op, args });
    });
  }

  // Proxy dispatch (controller ruling 2026-08-13, M1): any string property
  // access returns a call(op, args)-bound function, so unknown ops (e.g.
  // nope) reach the worker and reject from its {ok:false} response instead
  // of a synchronous TypeError. 'then' and symbols return undefined so the
  // client object is never treated as a thenable. slice is special-cased to
  // keep the progress protocol: the caller's callback is subscribed HERE
  // (bare {type:'progress'} messages, add/delete around the call) and never
  // forwarded through postMessage — a function arg would DataCloneError in
  // a real worker.
  return new Proxy({} as SlicerClient, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop === 'getHistoryDiagnostics') {
        return () => copyDiagnostics(diagnostics);
      }
      if (prop === 'runProjectHistoryTransaction') {
        return async (
          label: string, category: 'project' | 'context', beforeContext: unknown,
          mutation: (transactionId: string) => Promise<unknown>,
          afterContext: unknown | (() => unknown | Promise<unknown>),
        ) => {
          const startedAt = historyNow();
          const transactionId = await call('beginHistory', [label, category, beforeContext]);
          try {
            const result = await mutation(String(transactionId));
            const context = typeof afterContext === 'function'
              ? await (afterContext as () => unknown | Promise<unknown>)() : afterContext;
            const status = await call('commitHistory', [transactionId, context]);
            return { result, status };
          } catch (error) {
            try { await call('abortHistory', [transactionId]); } catch { /* preserve mutation error */ }
            throw error;
          } finally {
            recordLayer('client', { kind: 'mutation', durationMs: historyNow() - startedAt });
          }
        };
      }
      if (prop === 'loadProject' || prop === 'importProjectGeometry' || prop === 'preflightProject' || prop === 'commitProjectPreflight') {
        const progressIndex = prop === 'loadProject' ? 3 : prop === 'commitProjectPreflight' ? 1 : 2;
        return (...args: unknown[]) => {
          const onProgress = args[progressIndex];
          const callArgs = typeof onProgress === 'function' ? args.slice(0, progressIndex) : args;
          if (typeof onProgress !== 'function') return call(prop, callArgs);
          const listener = onProgress as (pct: number, text: string) => void;
          progressListeners.add(listener);
          updateMailboxPolling();
          return call(prop, callArgs).finally(() => {
            emitMailboxProgress();
            progressListeners.delete(listener);
            updateMailboxPolling();
          });
        };
      }
      if (prop === 'slice' || prop === 'slicePlate') {
        if (prop === 'slicePlate') {
          return (target: unknown, config: Record<string, string>, onProgress?: (percent: number, text: string) => void) => {
            if (!onProgress) return call('slicePlate', [target, config]);
            progressListeners.add(onProgress);
            updateMailboxPolling();
            return call('slicePlate', [target, config]).finally(() => {
              emitMailboxProgress();
              progressListeners.delete(onProgress);
              updateMailboxPolling();
            });
          };
        }
        return (config: Record<string, string>, onProgress?: (percent: number, text: string) => void) => {
          if (!onProgress) return call('slice', [config]);
          progressListeners.add(onProgress);
          updateMailboxPolling();
          return call('slice', [config]).finally(() => {
            // Catch the terminal status in same-thread/mock tests too. In the
            // real app the interval delivers intermediate statuses while the
            // module worker is busy.
            emitMailboxProgress();
            progressListeners.delete(onProgress);
            updateMailboxPolling();
          });
        };
      }
      return (...args: unknown[]) => call(prop, args);
    },
  }) as SlicerClient;
}
