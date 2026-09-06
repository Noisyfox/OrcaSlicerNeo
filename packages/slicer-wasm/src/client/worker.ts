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
import { createClient } from './client';

export type WorkerMessage =
  | { type: 'request'; id: number; op: string; args: unknown[] }
  | { type: 'response'; id: number; ok: boolean; result: unknown; error?: string }
  | { type: 'progress'; percent: number; text: string }
  | { type: 'progress-mailbox'; mailbox: ProgressMailbox };

export interface WorkerTransport {
  post(msg: WorkerMessage, transfer?: Transferable[]): void;
  onMessage(fn: (msg: WorkerMessage) => void): void;
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

  onMessage(async (msg) => {
    if (msg.type !== 'request') return;
    const { id, op, args } = msg;
    try {
      const method = (client as unknown as Record<string, (...a: unknown[]) => unknown>)[op];
      if (typeof method !== 'function') throw new Error(`unknown op: ${op}`);
      await beforeRequest?.(op, args ?? []);
      const result = await method(...(args ?? []));
      post({ type: 'response', id, ok: true, result }, collectTransferables(result));
    } catch (err) {
      post({ type: 'response', id, ok: false, result: undefined, error: String(err) });
    }
  });
}

export function createWorkerClient(transport: WorkerTransport): SlicerClient {
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();
  const progressListeners = new Set<(pct: number, text: string) => void>();
  let mailbox: ProgressMailbox | undefined;
  let mailboxTimer: ReturnType<typeof setInterval> | undefined;
  let lastMailboxSequence = -1;
  const decoder = new TextDecoder();

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
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'worker error'));
  });

  function call(op: string, args: unknown[]): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
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
      if (prop === 'loadProject' || prop === 'importProjectGeometry') {
        const progressIndex = prop === 'loadProject' ? 3 : 2;
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
