// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useHistoryNavigationStore } from '../../stores/useHistoryNavigationStore';
import { useHistoryRestoreStore } from '../../stores/useHistoryRestoreStore';
import type { HistoryStatus } from '@slicer/client';
vi.mock('../workspace/actions/sliceActions', () => ({ exportGcode: vi.fn(), sliceModel: vi.fn() }));
vi.mock('../send/SendGcodeDialog', () => ({
  SendGcodeDialog: ({ onNavigateToDevice }: { onNavigateToDevice?: () => void }) => (
    <button type="button" data-testid="mock-send-navigate" onClick={onNavigateToDevice}>Trigger send navigation</button>
  ),
}));
import { Toolbar } from './Toolbar';

if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });

function makePlatform() {
  return {
    platform: {
      printers: {
        configuration: {
          load: vi.fn(async () => ({
            version: 1 as const,
            printers: [{
              id: 'p1', displayName: 'Workshop', driverId: 'moonraker',
              consoleUrl: 'http://console.local/', apiBaseUrl: 'http://printer.local:7125/', apiKey: '',
            }],
          })),
          save: vi.fn(async () => undefined),
        },
        transport: {
          request: vi.fn(async () => ({ status: 200, json: async () => ({ result: { item: { path: 'gcodes/output.gcode' } } }) })),
        },
      },
      runtime: { exportGcode: vi.fn(async () => ({ ok: true, path: '/tmp/output.gcode', bytes: new Uint8Array([1, 2, 3]) })) },
    } as unknown as PlatformCapabilities,
  };
}

const navigationStatus: HistoryStatus = {
  canUndo: true, canRedo: true, undoLabel: 'Move', redoLabel: 'Delete',
  undoEntries: [
    { id: 'undo-context', label: 'Selection', category: 'context' },
    { id: 'undo-move', label: 'Move', category: 'project' },
  ],
  redoEntries: [
    { id: 'redo-delete', label: 'Delete', category: 'project' },
    { id: 'redo-context', label: 'Active Plate', category: 'context' },
  ],
  cursor: 2, savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: true,
  bytesUsed: 1, byteBudget: 256, optionalBytesReleased: 0, evictedEntryCount: 0,
  lastEvictedEntryId: null, oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false,
  disabled: false, activeTransactionId: null, revision: 2,
};

describe('Toolbar send navigation', () => {
  let root: Root | undefined;

  afterEach(() => {
    vi.useRealTimers();
    root?.unmount();
    root = undefined;
    document.body.innerHTML = '';
    useSettingsStore.setState({ modelLoaded: false });
    useSlicerStore.setState({ status: 'idle', progress: 0, error: null, resultExported: false });
    useHistoryNavigationStore.getState().reset();
    useHistoryRestoreStore.getState().reset();
  });

  it('passes the app-level Device callback through to the send dialog', async () => {
    useSlicerStore.setState({ status: 'done' });
    const { platform } = makePlatform();
    const navigateToDevice = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Toolbar activeTab="prepare" onNavigateToDevice={navigateToDevice} /></PlatformProvider>);
    });
    await act(async () => { (container.querySelector('[data-testid="mock-send-navigate"]') as HTMLElement).click(); });

    expect(navigateToDevice).toHaveBeenCalledOnce();
  });

  it.each(['home', 'device'] as const)('hides slice/export/send actions on %s', async (activeTab) => {
    const { platform } = makePlatform();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Toolbar activeTab={activeTab} /></PlatformProvider>);
    });

    expect(container.querySelector('[data-testid="toolbar-actions"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-slice"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-export"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-send"]')).toBeNull();
    expect(container.querySelector('[data-testid="btn-send-and-print"]')).toBeNull();
  });

  it.each(['prepare', 'preview'] as const)('shows slice/export/send actions on %s', async (activeTab) => {
    const { platform } = makePlatform();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Toolbar activeTab={activeTab} /></PlatformProvider>);
    });

    expect(container.querySelector('[data-testid="toolbar-actions"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="btn-slice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="btn-export"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="btn-send"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="btn-send-and-print"]')).not.toBeNull();
  });

  it('disables Slice after a valid result while keeping export and send available', async () => {
    useSettingsStore.setState({ modelLoaded: true });
    useSlicerStore.setState({ status: 'done' });
    const { platform } = makePlatform();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Toolbar activeTab="prepare" /></PlatformProvider>);
    });

    expect((container.querySelector('[data-testid="btn-slice"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="btn-export"]') as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector('[data-testid="btn-send"]') as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector('[data-testid="btn-send-and-print"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders Worker-derived next-operation labels and accessible disabled state', async () => {
    const { platform } = makePlatform();
    const coordinator = { restore: vi.fn(async () => true), currentRevision: () => 0 };
    useHistoryNavigationStore.getState().setStatus(navigationStatus);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Toolbar historyRestoreCoordinator={coordinator} /></PlatformProvider>);
    });
    const undo = container.querySelector('[data-testid="history-undo"]') as HTMLButtonElement;
    expect(undo.textContent).toContain('Undo Move');
    expect(undo.getAttribute('aria-label')).toBe('Undo Move');
    expect(undo.disabled).toBe(false);
    expect((container.querySelector('[data-testid="history-redo"]') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { undo.click(); });
    expect(coordinator.restore).toHaveBeenCalledWith('undo');
  });

  it('disables both buttons while the restore lifecycle is active', async () => {
    const { platform } = makePlatform();
    const coordinator = { restore: vi.fn(async () => true), currentRevision: () => 0 };
    useHistoryNavigationStore.getState().setStatus(navigationStatus);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Toolbar historyRestoreCoordinator={coordinator} /></PlatformProvider>);
    });
    await act(async () => { useHistoryRestoreStore.getState().setPhase('restoring'); });
    expect((container.querySelector('[data-testid="history-undo"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="history-redo"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens directional project-only menus and jumps directly to the Worker entry', async () => {
    const { platform } = makePlatform();
    const coordinator = { restore: vi.fn(async () => true), currentRevision: () => 0 };
    useHistoryNavigationStore.getState().setStatus(navigationStatus);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Toolbar historyRestoreCoordinator={coordinator} /></PlatformProvider>);
    });
    await act(async () => {
      (container.querySelector('[data-testid="history-undo-menu-trigger"]') as HTMLButtonElement).click();
    });
    expect(document.querySelector('[data-testid="history-undo-entry-undo-move"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="history-undo-entry-undo-context"]')).toBeNull();
    await act(async () => {
      (document.querySelector('[data-testid="history-undo-entry-undo-move"]') as HTMLElement).click();
    });
    expect(coordinator.restore).toHaveBeenCalledWith({ jump: 'undo-move' });
  });

  it('surfaces retryable restore errors without fabricating a history entry', async () => {
    const { platform } = makePlatform();
    useHistoryRestoreStore.getState().setError('invalid staged model');
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Toolbar /></PlatformProvider>);
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('invalid staged model');
  });
});
