import type { HistoryStatus, SlicerClient } from '@slicer/client';
import type { HistoryObservabilitySnapshot } from '../history/historyDiagnostics';
import type { HistoryRestorePhase } from '../stores/useHistoryRestoreStore';

export interface HistoryRestoreProbe {
  historyNativeStatus(): HistoryStatus | null;
  runtimeMemoryForAcceptance(): ReturnType<SlicerClient['getRuntimeMemory']>;
  historyRestoreLifecycle(): { phase: HistoryRestorePhase; revision: number; error: string | null };
  historyDiagnostics(): HistoryObservabilitySnapshot;
}
