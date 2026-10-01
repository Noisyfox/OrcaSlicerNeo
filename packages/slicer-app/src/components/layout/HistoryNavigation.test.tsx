// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import type { HistoryStatus } from '@slicer/client';
import { HistoryNavigation } from './HistoryNavigation';

if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });

function makePlatform() {
  return {
    platform: {
      runtime: {
        getRuntimeExecutionState: vi.fn(() => ({ threaded: true, sliceActive: false, serialSliceActive: false, serialTerminalEpoch: '0' })),
      },
    } as unknown as PlatformCapabilities,
  };
}

const navigationStatus: HistoryStatus = {
  editingSession: null, navigationFloor: null,
  canUndo: true, canRedo: true, undoLabel: 'Move', redoLabel: 'Delete',
  undoEntries: [
    { id: 'undo-move', label: 'Move', category: 'project' },
  ],
  redoEntries: [
    { id: 'redo-delete', label: 'Delete', category: 'project' },
  ],
  cursor: 2, savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: true,
  bytesUsed: 1, byteBudget: 256, evictedEntryCount: 0,
  lastEvictedEntryId: null, oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false,
  disabled: false, activeTransactionId: null, revision: 2,
};


Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('Titlebar history navigation', () => {
  let root: Root | undefined;

  afterEach(() => {
    vi.useRealTimers();
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = '';
    useSettingsStore.setState({ modelLoaded: false });
    useSlicerStore.setState({ status: 'idle', progress: 0, error: null, resultExported: false });
    useHistoryNavigationStore.getState().reset();
    useHistoryRestoreStore.getState().reset();
  });

  it('keeps icon-only buttons and Worker-derived accessible labels', async () => {
    const { platform } = makePlatform();
    const coordinator = { restore: vi.fn(async () => true), currentRevision: () => 0 };
    useHistoryNavigationStore.getState().setStatus(navigationStatus);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><HistoryNavigation activeTab="prepare" coordinator={coordinator} /></PlatformProvider>);
    });
    const undo = container.querySelector('[data-testid="history-undo"]') as HTMLButtonElement;
    expect(undo.textContent?.trim()).toBe('');
    expect(undo.getAttribute('aria-label')).toBe('Undo Move');
    expect(undo.disabled).toBe(false);
    expect((container.querySelector('[data-testid="history-redo"]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { undo.click(); });
    expect(coordinator.restore).toHaveBeenCalledWith('undo');
  });

  it('keeps navigation available while restoring so the coordinator can queue Worker-validated intents', async () => {
    const { platform } = makePlatform();
    const coordinator = { restore: vi.fn(async () => true), currentRevision: () => 0 };
    useHistoryNavigationStore.getState().setStatus(navigationStatus);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><HistoryNavigation activeTab="prepare" coordinator={coordinator} /></PlatformProvider>);
    });
    await act(async () => { useHistoryRestoreStore.getState().setPhase('restoring'); });
    expect((container.querySelector('[data-testid="history-undo"]') as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector('[data-testid="history-redo"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables buttons and history menus during a serial slice but keeps threaded history responsive', async () => {
    const coordinator = { restore: vi.fn(async () => true), currentRevision: () => 0 };
    useHistoryNavigationStore.getState().setStatus(navigationStatus);
    useSlicerStore.setState({ status: 'slicing' });
    const { platform } = makePlatform();
    const runtimeState = vi.mocked(platform.runtime.getRuntimeExecutionState);
    runtimeState.mockReturnValue({ threaded: false, sliceActive: true, serialSliceActive: true, serialTerminalEpoch: '0' });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><HistoryNavigation activeTab="prepare" coordinator={coordinator} /></PlatformProvider>);
    });
    for (const testId of ['history-undo', 'history-redo'])
      expect((container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).disabled).toBe(true);

    runtimeState.mockReturnValue({ threaded: true, sliceActive: true, serialSliceActive: false, serialTerminalEpoch: '0' });
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><HistoryNavigation activeTab="prepare" coordinator={coordinator} /></PlatformProvider>);
    });
    expect((container.querySelector('[data-testid="history-undo"]') as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector('[data-testid="history-redo"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['home', 'preview', 'device'] as const)('disables history controls outside Prepare on %s', async (activeTab) => {
    const { platform } = makePlatform();
    const coordinator = { restore: vi.fn(async () => true), currentRevision: () => 0 };
    useHistoryNavigationStore.getState().setStatus(navigationStatus);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><HistoryNavigation activeTab={activeTab} coordinator={coordinator} /></PlatformProvider>);
    });

    for (const testId of ['history-undo', 'history-redo'])
      expect((container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens directional menus and jumps directly to the Worker entry', async () => {
    const { platform } = makePlatform();
    const coordinator = { restore: vi.fn(async () => true), currentRevision: () => 0 };
    useHistoryNavigationStore.getState().setStatus(navigationStatus);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><HistoryNavigation activeTab="prepare" coordinator={coordinator} /></PlatformProvider>);
    });
    await act(async () => {
      (container.querySelector('[data-testid="history-undo"]') as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    expect(document.querySelector('[data-testid="history-undo-entry-undo-move"]')).not.toBeNull();
    await act(async () => {
      (document.querySelector('[data-testid="history-undo-entry-undo-move"]') as HTMLElement).click();
    });
    expect(coordinator.restore).toHaveBeenCalledWith({ jump: 'undo-move', direction: 'undo' });
  });

  it('surfaces retryable restore errors without fabricating a history entry', async () => {
    const { platform } = makePlatform();
    useHistoryRestoreStore.getState().setError('invalid staged model');
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><HistoryNavigation activeTab="prepare" /></PlatformProvider>);
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('invalid staged model');
  });
});
