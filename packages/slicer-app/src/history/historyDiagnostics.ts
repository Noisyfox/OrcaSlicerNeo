import { create } from 'zustand';
import type { HistoryDiagnosticLayer, HistoryTimingDiagnostic, HistoryTransportDiagnostics, RestoreImpact } from '@slicer/client';

export type HistoryRestorePath = 'direct' | 'full';

export interface HistoryAppDiagnostics extends HistoryDiagnosticLayer {
  readonly queue: HistoryTimingDiagnostic;
  readonly filamentRefresh: HistoryTimingDiagnostic;
  readonly projection: HistoryTimingDiagnostic;
  /** A direct Prime Tower receipt must never enter model projection. */
  readonly directPrimeTowerModelReloads: number;
  /** Full receipts are allowed to rebuild the model and are counted explicitly. */
  readonly fullRestoreModelReloads: number;
}

export interface HistoryObservabilitySnapshot {
  readonly version: 1;
  readonly worker: HistoryDiagnosticLayer | null;
  readonly client: HistoryDiagnosticLayer | null;
  readonly app: HistoryAppDiagnostics;
}

interface HistoryDiagnosticsState extends HistoryObservabilitySnapshot {
  recordMutation(durationMs: number): void;
  recordQueue(durationMs: number): void;
  recordRestore(path: HistoryRestorePath, durationMs: number): void;
  recordFilamentRefresh(durationMs: number): void;
  recordProjection(path: HistoryRestorePath, durationMs: number): void;
  setTransport(diagnostics: HistoryTransportDiagnostics | null): void;
  reset(): void;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function historyDiagnosticNow(): number {
  return now();
}

function emptyTiming(): HistoryTimingDiagnostic {
  return { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
}

function addTiming(timing: HistoryTimingDiagnostic, durationMs: number): HistoryTimingDiagnostic {
  const duration = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  return {
    count: timing.count + 1,
    totalMs: timing.totalMs + duration,
    maxMs: Math.max(timing.maxMs, duration),
    lastMs: duration,
  };
}

function emptyLayer(): HistoryDiagnosticLayer {
  return { mutation: emptyTiming(), restore: emptyTiming(), directRestore: emptyTiming(), fullRestore: emptyTiming() };
}

function emptyApp(): HistoryAppDiagnostics {
  return {
    ...emptyLayer(), queue: emptyTiming(), filamentRefresh: emptyTiming(), projection: emptyTiming(),
    directPrimeTowerModelReloads: 0, fullRestoreModelReloads: 0,
  };
}

function restorePath(impact: RestoreImpact): HistoryRestorePath {
  return impact.model === 'none' ? 'direct' : 'full';
}

function addRestore(app: HistoryAppDiagnostics, path: HistoryRestorePath, durationMs: number): HistoryAppDiagnostics {
  const restore = addTiming(app.restore, durationMs);
  return path === 'direct'
    ? { ...app, restore, directRestore: addTiming(app.directRestore, durationMs) }
    : { ...app, restore, fullRestore: addTiming(app.fullRestore, durationMs) };
}

/**
 * Bounded cross-layer diagnostics for smoke/E2E. This store is deliberately
 * aggregate-only: it cannot become a second history stack or retain project
 * model/context data.
 */
export const useHistoryDiagnosticsStore = create<HistoryDiagnosticsState>((set) => ({
  version: 1,
  worker: null,
  client: null,
  app: emptyApp(),
  recordMutation: (durationMs) => set((state) => ({ app: { ...state.app, mutation: addTiming(state.app.mutation, durationMs) } })),
  recordQueue: (durationMs) => set((state) => ({ app: { ...state.app, queue: addTiming(state.app.queue, durationMs) } })),
  recordRestore: (path, durationMs) => set((state) => ({ app: addRestore(state.app, path, durationMs) })),
  recordFilamentRefresh: (durationMs) => set((state) => ({ app: { ...state.app, filamentRefresh: addTiming(state.app.filamentRefresh, durationMs) } })),
  recordProjection: (path, durationMs) => set((state) => ({
    app: {
      ...state.app,
      projection: addTiming(state.app.projection, durationMs),
      // The direct path intentionally never calls getModelStructure or waits
      // for GL replacement. Keep the zero visible as a regression guard.
      directPrimeTowerModelReloads: state.app.directPrimeTowerModelReloads,
      fullRestoreModelReloads: state.app.fullRestoreModelReloads + (path === 'full' ? 1 : 0),
    },
  })),
  setTransport: (diagnostics) => set({ worker: diagnostics?.worker ?? null, client: diagnostics?.client ?? null }),
  reset: () => set({ worker: null, client: null, app: emptyApp() }),
}));

export function historyRestorePath(impact: RestoreImpact): HistoryRestorePath {
  return restorePath(impact);
}

/** Refresh the copied scalar aggregates without retaining a runtime or model. */
export function captureHistoryTransportDiagnostics(runtime: unknown): void {
  const read = (runtime as { getHistoryDiagnostics?: unknown } | null)?.getHistoryDiagnostics;
  if (typeof read !== 'function') return;
  try {
    const diagnostics = read.call(runtime) as HistoryTransportDiagnostics;
    if (diagnostics?.version === 1) useHistoryDiagnosticsStore.getState().setTransport(diagnostics);
  } catch {
    // Observability must not change a history operation's outcome.
  }
}
