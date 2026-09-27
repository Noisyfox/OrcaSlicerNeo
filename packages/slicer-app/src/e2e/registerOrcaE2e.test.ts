import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryDiagnosticsStore } from '../history/historyDiagnostics';
import { registerOrcaE2eOwner, registerOrcaE2eOwnerAfterPassiveEffects } from './registerOrcaE2e';

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

  it('publishes after the current passive-effect flush and cleans up the deferred owner', () => {
    const microtasks: Array<() => void> = [];
    const events: string[] = [];
    vi.stubGlobal('queueMicrotask', (callback: VoidFunction) => {
      microtasks.push(() => {
        events.push('register');
        callback();
      });
    });
    const selectionBounds = vi.fn(() => 'selection');
    // Simulate SceneE2eProbe's child effect queuing before SceneContents reset.
    const unregister = registerOrcaE2eOwnerAfterPassiveEffects('scene', { selectionBounds });

    expect(target.__orcaE2e).toBeUndefined();
    events.push('reset');
    expect(target.__orcaE2e).toBeUndefined();
    microtasks.splice(0).forEach((run) => run());

    expect(events).toEqual(['reset', 'register']);
    expect(target.__orcaE2e).toEqual({ selectionBounds });
    unregister();
    expect(target.__orcaE2e).toBeUndefined();
  });

  it('cancels a deferred registration when its effect cleans up before the microtask', () => {
    const microtasks: Array<() => void> = [];
    vi.stubGlobal('queueMicrotask', (callback: VoidFunction) => microtasks.push(callback));
    const unregister = registerOrcaE2eOwnerAfterPassiveEffects('scene', { selectionBounds: () => 'selection' });

    unregister();
    microtasks.splice(0).forEach((run) => run());

    expect(target.__orcaE2e).toBeUndefined();
  });
});
