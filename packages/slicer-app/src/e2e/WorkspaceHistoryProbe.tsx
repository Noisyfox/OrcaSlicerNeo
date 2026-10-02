import { useEffect } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { captureHistoryTransportDiagnostics, type HistoryObservabilitySnapshot, useHistoryDiagnosticsStore } from '../history/historyDiagnostics';
import { useHistoryNavigationStore } from '../stores/useHistoryNavigationStore';
import { registerOrcaE2eOwner } from './registerOrcaE2e';

const pendingProjectionReads = new WeakMap<object, Set<Promise<void>>>();

/** Count every outstanding read, including superseded reads whose diagnostics
 * are recorded when their RPC completes. This observer changes no admission. */
export function trackPrimeTowerProjectionRead(runtime: object, read: Promise<void>): void {
  let pending = pendingProjectionReads.get(runtime);
  if (!pending) pendingProjectionReads.set(runtime, pending = new Set());
  pending.add(read);
  const reads = pending;
  const settled = () => { reads.delete(read); };
  void read.then(settled, settled);
}

export function primeTowerProjectionPendingCount(runtime: object): number {
  return pendingProjectionReads.get(runtime)?.size ?? 0;
}

export function WorkspaceHistoryProbe() {
  const { runtime } = usePlatform();

  useEffect(() => registerOrcaE2eOwner('workspace-history-diagnostics', {
    // Painting open/commit/close and history navigation project their native
    // receipts here; an E2E read must not enqueue another project operation.
    historyNativeStatus: () => useHistoryNavigationStore.getState().status,
    primeTowerProjectionPendingCount: () => primeTowerProjectionPendingCount(runtime),
    historyDiagnostics: (): HistoryObservabilitySnapshot => {
      captureHistoryTransportDiagnostics(runtime);
      const { recordMutation: _mutation, recordQueue: _queue, recordRestore: _restore,
        recordFilamentRefresh: _filament, recordFilamentSnapshot: _filamentSnapshot,
        recordFilamentPreferencePersistence: _filamentPreferences,
        recordProjection: _projection, recordPrimeTowerProjectionRead: _projectionRead,
        recordPrimeTowerSetProjection: _setProjection, recordPrimeTowerReconcile: _reconcile,
        recordPrimeTowerEmit: _emit, recordPlateSessionSnapshot: _plateSession,
        recordPlateSessionTransforms: _plateTransforms,
        recordSelectionRestore: _selectionRestore,
        setTransport: _transport, reset: _reset, ...snapshot } = useHistoryDiagnosticsStore.getState();
      return snapshot;
    },
  }), [runtime]);

  return null;
}
