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
import type { SlicerClient, OrcaModuleFactory } from './types';
import { createClient } from './client';

export type WorkerMessage =
  | { type: 'request'; id: number; op: string; args: unknown[] }
  | { type: 'response'; id: number; ok: boolean; result: unknown; error?: string }
  | { type: 'progress'; percent: number; text: string };

export interface WorkerTransport {
  post(msg: WorkerMessage): void;
  onMessage(fn: (msg: WorkerMessage) => void): void;
}

export function startWorker(
  moduleFactory: OrcaModuleFactory,
  post: (msg: WorkerMessage) => void = (msg) => (self as unknown as { postMessage(m: WorkerMessage): void }).postMessage(msg),
  onMessage: (fn: (msg: WorkerMessage) => void) => void = (fn) => {
    (self as unknown as { onmessage: (e: MessageEvent<WorkerMessage>) => void }).onmessage = (e) => fn(e.data);
  },
): void {
  // The client registers the bridge's progress callback ONCE at module init
  // and never removeFunction's it (stale-slot trap discipline, bridge-smoke
  // Fix round 1); its sink forwards every event here as {type:'progress'}.
  const client = createClient(moduleFactory, (pct, text) => {
    post({ type: 'progress', percent: pct, text });
  });

  onMessage(async (msg) => {
    if (msg.type !== 'request') return;
    const { id, op, args } = msg;
    try {
      const method = (client as unknown as Record<string, (...a: unknown[]) => unknown>)[op];
      if (typeof method !== 'function') throw new Error(`unknown op: ${op}`);
      const result = await method(...(args ?? []));
      post({ type: 'response', id, ok: true, result });
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

  transport.onMessage((msg) => {
    if (msg.type === 'progress') {
      for (const l of progressListeners) l(msg.percent, msg.text);
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
      if (prop === 'slice') {
        return (config: Record<string, string>, onProgress?: (percent: number, text: string) => void) => {
          if (!onProgress) return call('slice', [config]);
          progressListeners.add(onProgress);
          return call('slice', [config]).finally(() => progressListeners.delete(onProgress));
        };
      }
      return (...args: unknown[]) => call(prop, args);
    },
  }) as SlicerClient;
}
