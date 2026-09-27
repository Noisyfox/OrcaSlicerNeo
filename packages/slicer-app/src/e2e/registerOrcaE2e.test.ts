import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryDiagnosticsStore } from '../history/historyDiagnostics';
import { registerOrcaE2eOwner } from './registerOrcaE2e';

describe('registerOrcaE2eOwner', () => {
  let target: Window;

  beforeEach(() => {
    target = {} as Window;
    vi.stubGlobal('window', target);
  });

  afterEach(() => {
    delete target.__orcaE2e;
    vi.unstubAllGlobals();
  });

  it('removes only the hooks owned by the cleaned up component', () => {
    const historyDiagnostics = vi.fn(() => useHistoryDiagnosticsStore.getState());
    const selectionBounds = vi.fn(() => 'selection');
    const unregisterHistory = registerOrcaE2eOwner('workspace-history', { historyDiagnostics });
    const unregisterScene = registerOrcaE2eOwner('scene', { selectionBounds });

    unregisterHistory();

    expect(target.__orcaE2e).toEqual({ selectionBounds });
    unregisterScene();
    expect(target.__orcaE2e).toBeUndefined();
  });

  it('replaces a prior registration for the same owner and tolerates its stale cleanup', () => {
    const unregisterFirst = registerOrcaE2eOwner('workspace-history', {
      historyDiagnostics: () => useHistoryDiagnosticsStore.getState(),
    });
    const currentHistoryDiagnostics = () => useHistoryDiagnosticsStore.getState();
    const unregisterCurrent = registerOrcaE2eOwner('workspace-history', { historyDiagnostics: currentHistoryDiagnostics });

    unregisterFirst();

    expect(target.__orcaE2e?.historyDiagnostics).toBe(currentHistoryDiagnostics);
    unregisterCurrent();
    expect(target.__orcaE2e).toBeUndefined();
  });
});
