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
import type { SlicerClient, OrcaModuleFactory, PlateSessionMutation, ProjectClosedCallback } from './types';
import type {
  HistoryDiagnosticLayer,
  HistoryReadDiagnosticLayer,
  HistoryTransportDiagnostics,
  HistoryTimingDiagnostic,
  RestoreResult,
} from './history';
import { createClient, dispatchClientRequest } from './client';

const REAL_PROJECT_PROFILE_BUILD = import.meta.env.VITE_REAL_PROJECT_PROFILE === '1';

export type WorkerMessage =
  | { type: 'request'; id: number; op: string; args: unknown[]; serialTerminalEpoch?: string }
  | { type: 'response'; id: number; ok: boolean; result: unknown; error?: string }
  | { type: 'history-diagnostic'; diagnostic: HistoryWorkerDiagnostic }
  | { type: 'project-closed'; plateSession: PlateSessionMutation }
  | { type: 'progress'; percent: number; text: string }
  | { type: 'runtime-state'; threaded: boolean; serialTerminalEpoch: string };

export interface HistoryWorkerDiagnostic {
  readonly kind: 'mutation' | 'restore' | 'read';
  readonly path?: 'direct' | 'full';
  readonly read?: keyof HistoryReadDiagnosticLayer;
  readonly durationMs: number;
}

export interface WorkerTransport {
  post(msg: WorkerMessage, transfer?: Transferable[]): void;
  onMessage(fn: (msg: WorkerMessage) => void): void;
}

const historyMutationOperations = new Set([
  'selectFilamentSlotPreset', 'setFilamentSlotColour', 'addFilamentSlot',
  'deleteFilamentSlot', 'mergeFilamentSlots', 'assignFilament',
  'setFilamentRouting', 'movePrimeTower', 'setNativeScopedConfig', 'mutateNativeScopedConfig',
  'mutatePresetDraft',
]);

// Serial Print::process() occupies the sole stateful Worker. These commands
// must fail before postMessage so no edit, history frame, Slice, or Export can
// wait behind the running task and execute against a later epoch.
const restrictedWhileSerialSlicing = new Set([
  'selectFilamentSlotPreset', 'setFilamentSlotColour', 'addFilamentSlot',
  'deleteFilamentSlot', 'mergeFilamentSlots', 'applyRememberedFilamentRack',
  'assignFilament', 'setFilamentRouting', 'beginHistory', 'commitHistory',
  'abortHistory', 'undoHistory', 'redoHistory', 'jumpHistory', 'markHistorySaved',
  'resetHistory', 'movePrimeTower', 'resetPlateSession',
  'selectPlate', 'addPlate', 'deletePlate', 'recomputePlateMembership',
  'markSharedConfigurationMutation', 'setNativeScopedConfig', 'mutateNativeScopedConfig',
  'mutatePresetDraft', 'revalidateNativeScopedConfig', 'selectProfile', 'addModel', 'closeProject',
  'loadProject', 'importProjectGeometry', 'addShape', 'clearModel',
  'setInstanceOffset', 'setModelTransform', 'setModelTransforms', 'deleteObjects',
  'deleteVolumes', 'cloneObjects', 'reorderObjects', 'reorderVolumes',
  'splitVolumeToParts', 'splitObjectToObjects', 'mergeObjectsToMultipart',
  'separateInstances', 'addInstance', 'removeInstance', 'renameObject',
  'renameVolume', 'setVolumeType', 'setObjectPrintable', 'setInstancePrintable',
  'slice', 'slicePlate', 'exportGcodePlate', 'exportProject', 'cancel',
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
  return impact?.model === 'delta' || impact?.model === 'none' ? 'direct' : 'full';
}

function historyReadForOperation(operation: string): keyof HistoryReadDiagnosticLayer | null {
  switch (operation) {
    case 'getPlateSessionSnapshot': return 'plateSessionSnapshot';
    case 'getPrimeTowerProjection': return 'primeTowerProjection';
    case 'getFilamentSessionSnapshot': return 'filamentSessionSnapshot';
    default: return null;
  }
}

function emptyTiming(): HistoryTimingDiagnostic {
  return { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
}

function emptyLayer(): HistoryDiagnosticLayer {
  return {
    mutation: emptyTiming(), restore: emptyTiming(), directRestore: emptyTiming(), fullRestore: emptyTiming(),
    reads: { plateSessionSnapshot: emptyTiming(), primeTowerProjection: emptyTiming(), filamentSessionSnapshot: emptyTiming() },
  };
}

function addTiming(current: HistoryTimingDiagnostic, durationMs: number): HistoryTimingDiagnostic {
  const duration = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  return { count: current.count + 1, totalMs: current.totalMs + duration,
    maxMs: Math.max(current.maxMs, duration), lastMs: duration };
}

function recordTiming(
  layer: HistoryDiagnosticLayer,
  key: Exclude<keyof HistoryDiagnosticLayer, 'reads'>,
  durationMs: number,
): HistoryDiagnosticLayer {
  return { ...layer, [key]: addTiming(layer[key], durationMs) };
}

function copyLayer(layer: HistoryDiagnosticLayer): HistoryDiagnosticLayer {
  return {
    mutation: { ...layer.mutation }, restore: { ...layer.restore },
    directRestore: { ...layer.directRestore }, fullRestore: { ...layer.fullRestore },
    reads: layer.reads && {
      plateSessionSnapshot: { ...layer.reads.plateSessionSnapshot },
      primeTowerProjection: { ...layer.reads.primeTowerProjection },
      filamentSessionSnapshot: { ...layer.reads.filamentSessionSnapshot },
    },
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
  const client = createClient(moduleFactory, (pct, text) => {
    post({ type: 'progress', percent: pct, text });
  }, beforeInit, (plateSession) => {
    post({ type: 'project-closed', plateSession });
  }, (runtimeState) => {
    post({ type: 'runtime-state', ...runtimeState });
  });

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
      // Preserve the client receiver for composed operations. The dispatcher
      // previously invoked a detached method and made `this` undefined in the
      // worker even though the public client contract was otherwise valid.
      const result = await dispatchClientRequest(
        client, op, callArgs, msg.serialTerminalEpoch ?? '0',
        restrictedWhileSerialSlicing.has(op),
      );
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
      } else {
        const read = historyReadForOperation(op);
        if (read) post({ type: 'history-diagnostic', diagnostic: {
          kind: 'read', read, durationMs: historyNow() - startedAt,
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
  const projectClosedListeners = new Set<ProjectClosedCallback>();
  let runtimeThreaded: boolean | undefined;
  let activeSliceRequests = 0;
  let serialSliceActive = false;
  let serialTerminalEpoch = '0';
  let profileLastRestoreSliceActive: boolean | null = null;
  let diagnostics: HistoryTransportDiagnostics = { version: 1, worker: emptyLayer(), client: emptyLayer() };

  function recordLayer(layer: 'worker' | 'client', diagnostic: HistoryWorkerDiagnostic): void {
    if (diagnostic.kind === 'read') {
      if (!diagnostic.read) return;
      const reads = diagnostics[layer].reads;
      if (!reads) return;
      diagnostics = {
        ...diagnostics,
        [layer]: { ...diagnostics[layer], reads: { ...reads, [diagnostic.read]: addTiming(reads[diagnostic.read], diagnostic.durationMs) } },
      };
      return;
    }
    let next = recordTiming(diagnostics[layer], diagnostic.kind === 'mutation' ? 'mutation' : 'restore', diagnostic.durationMs);
    if (diagnostic.kind === 'restore')
      next = recordTiming(next, diagnostic.path === 'direct' ? 'directRestore' : 'fullRestore', diagnostic.durationMs);
    diagnostics = { ...diagnostics, [layer]: next };
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
    if (msg.type === 'runtime-state') {
      runtimeThreaded = msg.threaded;
      serialTerminalEpoch = msg.serialTerminalEpoch;
      if (!msg.threaded) serialSliceActive = false;
      return;
    }
    if (msg.type === 'project-closed') {
      for (const listener of projectClosedListeners) listener(msg.plateSession);
      return;
    }
    if (msg.type !== 'response') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (REAL_PROJECT_PROFILE_BUILD && isRestoreOperation(p.op))
      profileLastRestoreSliceActive = activeSliceRequests > 0;
    if (p.op === 'slice' || p.op === 'slicePlate') activeSliceRequests -= 1;
    if (!runtimeThreaded && (p.op === 'slice' || p.op === 'slicePlate'))
      serialSliceActive = false;
    if (msg.ok) {
      if (isRestoreOperation(p.op))
        recordLayer('client', { kind: 'restore', path: restorePath(msg.result), durationMs: historyNow() - p.startedAt });
      else if (historyMutationOperations.has(p.op))
        recordLayer('client', { kind: 'mutation', durationMs: historyNow() - p.startedAt });
      else {
        const read = historyReadForOperation(p.op);
        if (read) recordLayer('client', { kind: 'read', read, durationMs: historyNow() - p.startedAt });
      }
      p.resolve(msg.result);
    }
    else p.reject(new Error(msg.error ?? 'worker error'));
  });

  function call(op: string, args: unknown[]): Promise<unknown> {
    const id = nextId++;
    if (runtimeThreaded !== true && serialSliceActive && restrictedWhileSerialSlicing.has(op))
      return Promise.resolve({ error: 'slice_busy' });
    if (op === 'slice' || op === 'slicePlate') {
      activeSliceRequests += 1;
      if (runtimeThreaded !== true) serialSliceActive = true;
    }
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, op, startedAt: historyNow() });
      transport.post({ type: 'request', id, op, args, serialTerminalEpoch });
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
      if (prop === 'getRuntimeExecutionState') {
        return () => ({
          threaded: runtimeThreaded ?? null,
          sliceActive: activeSliceRequests > 0,
          serialSliceActive: runtimeThreaded === false && serialSliceActive,
          serialTerminalEpoch,
        });
      }
      if (REAL_PROJECT_PROFILE_BUILD && prop === 'realProjectProfileLastRestoreSliceActive')
        return () => profileLastRestoreSliceActive;
      if (prop === 'runProjectHistoryTransaction') {
        return async (
          label: string, category: 'project', beforeContext: unknown,
          mutation: (transactionId: string) => Promise<unknown>,
          afterContext: unknown | (() => unknown | Promise<unknown>),
        ) => {
          const startedAt = historyNow();
          const transactionId = await call('beginHistory', [label, category, beforeContext]);
          try {
            const result = await mutation(String(transactionId));
            const context = typeof afterContext === 'function'
              ? await (afterContext as () => unknown | Promise<unknown>)() : afterContext;
            const receipt = await call('commitHistory', [transactionId, context]) as import('./history').HistoryCommitResult;
            return { result, ...receipt };
          } catch (error) {
            try { await call('abortHistory', [transactionId]); } catch { /* preserve mutation error */ }
            throw error;
          } finally {
            recordLayer('client', { kind: 'mutation', durationMs: historyNow() - startedAt });
          }
        };
      }
      if (prop === 'loadProject') {
        return (...args: unknown[]) => {
          const onProgress = args[3];
          const onProjectClosed = args[4];
          const progressListener = typeof onProgress === 'function'
            ? onProgress as (pct: number, text: string) => void : undefined;
          const closedListener = typeof onProjectClosed === 'function'
            ? onProjectClosed as ProjectClosedCallback : undefined;
          if (progressListener) progressListeners.add(progressListener);
          if (closedListener) projectClosedListeners.add(closedListener);
          return call(prop, args.slice(0, 3)).finally(() => {
            if (progressListener) progressListeners.delete(progressListener);
            if (closedListener) projectClosedListeners.delete(closedListener);
          });
        };
      }
      if (prop === 'importProjectGeometry') {
        return (...args: unknown[]) => {
          const onProgress = args[2];
          if (typeof onProgress !== 'function') return call(prop, args);
          const listener = onProgress as (pct: number, text: string) => void;
          progressListeners.add(listener);
          return call(prop, args.slice(0, 2)).finally(() => {
            progressListeners.delete(listener);
          });
        };
      }
      if (prop === 'slice' || prop === 'slicePlate') {
        if (prop === 'slicePlate') {
          return (target: unknown, config: Record<string, string>, onProgress?: (percent: number, text: string) => void) => {
            if (!onProgress) return call('slicePlate', [target, config]);
            progressListeners.add(onProgress);
            return call('slicePlate', [target, config]).finally(() => {
              progressListeners.delete(onProgress);
            });
          };
        }
        return (config: Record<string, string>, onProgress?: (percent: number, text: string) => void) => {
          if (!onProgress) return call('slice', [config]);
          progressListeners.add(onProgress);
          return call('slice', [config]).finally(() => {
            progressListeners.delete(onProgress);
          });
        };
      }
      return (...args: unknown[]) => call(prop, args);
    },
  }) as SlicerClient;
}
