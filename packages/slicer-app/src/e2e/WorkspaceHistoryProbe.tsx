import { useEffect } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { captureHistoryTransportDiagnostics, type HistoryObservabilitySnapshot, useHistoryDiagnosticsStore } from '../history/historyDiagnostics';
import { useHistoryNavigationStore } from '../stores/useHistoryNavigationStore';
import { registerOrcaE2eOwner } from './registerOrcaE2e';

export function WorkspaceHistoryProbe() {
  const { runtime } = usePlatform();

  useEffect(() => registerOrcaE2eOwner('workspace-history-diagnostics', {
    // Painting open/commit/close and history navigation project their native
    // receipts here; an E2E read must not enqueue another project operation.
    historyNativeStatus: () => useHistoryNavigationStore.getState().status,
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
