// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { Workspace } from './Workspace';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { usePlateSessionStore } from '../../stores/usePlateSessionStore';
import { useHistoryRestoreStore } from '../../stores/useHistoryRestoreStore';
import type { PlateSessionSnapshot } from '@slicer/client';
import type { HistoryRestoreCoordinator } from '../../history/restoreCoordinator';
import { useHistoryDiagnosticsStore } from '../../history/historyDiagnostics';

const sliceModelMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./actions/sliceActions', () => ({ sliceModel: sliceModelMock }));

const testMocks = vi.hoisted(() => ({
  viewportProps: [] as Array<Record<string, unknown>>,
}));

// The scene components are intentionally not part of this structural test.
// Mocks keep it focused on Workspace's ownership boundary.
vi.mock('./objectList/ObjectList', () => ({ ObjectList: () => <div data-testid="mock-object-list" /> }));
vi.mock('./settings/SettingsPanel', () => ({ SettingsPanel: () => <div data-testid="mock-settings-panel" /> }));
vi.mock('./viewport/Viewport', () => ({
  Viewport: (props: Record<string, unknown>) => {
    testMocks.viewportProps.push(props);
    return <div data-testid="mock-viewport" />;
  },
}));

const platform = {
  preferences: {
    load: vi.fn(async () => ({ version: 1 as const, selected: {}, ui: { sidebarWidth: 288 } })),
    save: vi.fn(async () => undefined),
  },
  runtime: undefined,
} as unknown as PlatformCapabilities;

const twoPlateSnapshot: PlateSessionSnapshot = {
  ok: true,
  version: 1,
  currentPlateId: 'plate-a',
  plates: [
    { plateId: 'plate-a', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1', instanceIds: [1], valid: true },
    { plateId: 'plate-b', displayIndex: 1, origin: [264, 0, 0], name: 'Plate 2', instanceIds: [2], valid: true },
  ],
  inputRevisions: { 'plate-a': 1, 'plate-b': 1 },
};

describe('Workspace ownership', () => {
  let root: Root | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    testMocks.viewportProps.length = 0;
    document.body.innerHTML = '';
    useSettingsStore.setState({ modelLoaded: false });
    useSlicerStore.setState({ status: 'idle', progress: 0, error: null });
    usePlateSessionStore.getState().reset();
    useHistoryRestoreStore.getState().reset();
    useHistoryDiagnosticsStore.getState().reset();
    (platform as unknown as { runtime?: PlatformCapabilities['runtime'] }).runtime = undefined;
    sliceModelMock.mockClear();
  });

  it('contains only the profile/settings sidebar and 3D scene', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace /></PlatformProvider>);
    });

    expect(container.querySelector('[data-testid="mock-object-list"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mock-settings-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mock-viewport"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="device-panel"]')).toBeNull();
    expect(container.querySelector('[role="tabpanel"]')).toBeNull();
  });

  it('keeps the controller and scene resources stable across a workspace tab switch', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace activeTab="prepare" /></PlatformProvider>);
    });
    const prepareProps = testMocks.viewportProps.at(-1);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace activeTab="preview" /></PlatformProvider>);
    });
    const previewProps = testMocks.viewportProps.at(-1);

    expect(prepareProps).toBeDefined();
    expect(previewProps).toBeDefined();
    expect(previewProps?.activeTab).toBe('preview');
    expect(prepareProps?.sceneInteraction).toBe(previewProps?.sceneInteraction);
    expect(prepareProps?.glVolumes).toBe(previewProps?.glVolumes);
    expect(prepareProps?.toolpath).toBe(previewProps?.toolpath);
  });

  it('automatically ensures a slice on an actual transition into Preview', async () => {
    useSettingsStore.setState({ modelLoaded: true });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace activeTab="prepare" /></PlatformProvider>);
    });
    expect(sliceModelMock).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace activeTab="preview" /></PlatformProvider>);
    });

    expect(sliceModelMock).toHaveBeenCalledOnce();
  });

  it('renders Preview while Home or Device is still active, then completes the navigation after that frame', async () => {
    const onPreviewRenderReady = vi.fn();
    let transition: { begin(): void } | null = null;
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <PlatformProvider value={platform}>
          <Workspace
            activeTab="home"
            onPreviewTransitionChange={(next) => { transition = next; }}
            onPreviewRenderReady={onPreviewRenderReady}
          />
        </PlatformProvider>,
      );
    });

    await act(async () => { transition?.begin(); });
    const previewProps = testMocks.viewportProps.at(-1);
    expect(previewProps?.activeTab).toBe('preview');

    await act(async () => {
      (previewProps?.onSceneFrameRendered as ((mode: 'prepare' | 'preview') => void) | undefined)?.('preview');
    });
    expect(onPreviewRenderReady).toHaveBeenCalledOnce();
  });

  it('clears object selection when switching plates from the Preview list', async () => {
    const switchedSnapshot = { ...twoPlateSnapshot, currentPlateId: 'plate-b' };
    const runtime = {
      selectPlate: vi.fn(async () => switchedSnapshot),
    };
    platform.runtime = runtime as unknown as PlatformCapabilities['runtime'];
    usePlateSessionStore.getState().setSnapshot(twoPlateSnapshot);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace activeTab="preview" /></PlatformProvider>);
    });
    expect(testMocks.viewportProps.at(-1)?.previewFrameRequest).toBeNull();
    const previewController = testMocks.viewportProps.at(-1)!.sceneInteraction as { clearSelection: () => boolean };
    const previewClear = vi.spyOn(previewController, 'clearSelection');
    await act(async () => {
      container.querySelector('[data-testid="preview-plate-plate-b"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(runtime.selectPlate).toHaveBeenCalledWith('plate-b');
    expect(previewClear).toHaveBeenCalledOnce();
    const frameRequest = testMocks.viewportProps.at(-1)?.previewFrameRequest as { plateId: string; token: number } | null;
    expect(frameRequest?.plateId).toBe('plate-b');
    expect(frameRequest?.token).toBe(1);

    await act(async () => {
      container.querySelector('[data-testid="preview-plate-plate-b"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(runtime.selectPlate).toHaveBeenCalledOnce();
    expect(previewClear).toHaveBeenCalledTimes(2);
    expect(testMocks.viewportProps.at(-1)?.previewFrameRequest).toEqual(frameRequest);
  });

  it('projects a direct Prime Tower restore once, then still refreshes for a real renderer input change', async () => {
    const getModelStructure = vi.fn(async () => ({ ok: true as const, objects: [] }));
    const restore = {
      ok: true as const,
      context: { selection: { mode: 'object' as const, objectIds: [], partIds: [], instanceIds: [] }, activePlateId: 'plate-a', gizmo: null, projectConfigOverlay: {} },
      status: { canUndo: false, canRedo: false, undoEntries: [], redoEntries: [], cursor: 0, savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: false, bytesUsed: 0, byteBudget: 1, optionalBytesReleased: 0, evictedEntryCount: 0, lastEvictedEntryId: null, oldestRetainedEntryId: null, oversizedEntryRetained: false, disabled: false, activeTransactionId: null, revision: 1 },
      impact: { version: 1 as const, model: 'none' as const, plateSession: true, filamentRack: false, projectOverlay: true, selectionContext: true, primeTower: true, preview: 'current-plate' as const },
    };
    const runtime = {
      undoHistory: vi.fn(async () => restore), redoHistory: vi.fn(), jumpHistory: vi.fn(), cancel: vi.fn(),
      getModelStructure, getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' })),
      getPlateSessionSnapshot: vi.fn(async () => ({ ...twoPlateSnapshot, inputRevisions: { ...twoPlateSnapshot.inputRevisions } })),
      getPrimeTowerProjection: vi.fn(async () => ({ ok: true, plates: [] })),
    };
    platform.runtime = runtime as unknown as PlatformCapabilities['runtime'];
    let coordinator: HistoryRestoreCoordinator | undefined;
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace onHistoryRestoreCoordinatorChange={(value) => { coordinator = value ?? undefined; }} /></PlatformProvider>);
    });
    // Mounting projects the empty shell, then the initial plate session and
    // overlay. Those are independent real inputs; settle them before taking
    // the direct-history baseline below.
    await vi.waitFor(() => expect(runtime.getPrimeTowerProjection.mock.calls.length).toBeGreaterThan(0));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const plateReadsBeforeRestore = runtime.getPlateSessionSnapshot.mock.calls.length;
    const projectionReadsBeforeRestore = runtime.getPrimeTowerProjection.mock.calls.length;
    await act(async () => { await coordinator?.restore('undo'); });
    expect(getModelStructure).not.toHaveBeenCalled();
    expect(runtime.getPlateSessionSnapshot).toHaveBeenCalledTimes(plateReadsBeforeRestore + 1);
    // The direct restore publishes an explicit projection before returning to
    // idle.  The idle-phase reactive effect sees that exact input identity and
    // does not send a second full Worker request.
    expect(runtime.getPrimeTowerProjection).toHaveBeenCalledTimes(projectionReadsBeforeRestore + 1);
    expect(useHistoryDiagnosticsStore.getState().app).toMatchObject({
      directRestore: { count: 1 }, projection: { count: 1 }, directPrimeTowerModelReloads: 0,
    });

    await act(async () => {
      useSettingsStore.getState().setOverlay({ project: { wipe_tower_x: '42' }, objects: {}, parts: {}, plates: {} });
    });
    await vi.waitFor(() => expect(runtime.getPrimeTowerProjection).toHaveBeenCalledTimes(projectionReadsBeforeRestore + 2));
  });
});
