// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { Workspace } from './Workspace';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { usePlateSessionStore } from '../../stores/usePlateSessionStore';
import { useHistoryRestoreStore } from '../../stores/useHistoryRestoreStore';
import type { PlateSessionSnapshot, PrimeTowerProjection } from '@slicer/client';
import type { WipeTowerVolumeCollection } from './viewport/WipeTowerVolume';
import { applySettledTransformSyncResult } from './actions/persistModelTransforms';
import type { HistoryRestoreCoordinator } from '../../history/restoreCoordinator';
import { useHistoryDiagnosticsStore } from '../../history/historyDiagnostics';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const sliceModelMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./actions/sliceActions', () => ({ sliceModel: sliceModelMock }));

const testMocks = vi.hoisted(() => ({
  viewportProps: [] as Array<Record<string, unknown>>,
}));

// The scene components are intentionally not part of this structural test.
// Mocks keep it focused on Workspace's ownership boundary.
vi.mock('./objectList/ObjectList', () => ({ ObjectList: () => <div data-testid="mock-object-list" /> }));
vi.mock('./settings/SettingsPanel', () => ({
  SettingsPanel: (props: { onEditPrinter?: (canonicalName: string) => void }) => <>
    <div data-testid="mock-settings-panel" />
    <button data-testid="mock-printer-edit" onClick={() => props.onEditPrinter?.('Printer A')}>Edit Printer</button>
  </>,
}));
vi.mock('./FilamentRack', () => ({
  FilamentRack: (props: { onEditPreset?: (canonicalName: string) => void }) =>
    <button data-testid="mock-filament-edit" onClick={() => props.onEditPreset?.('PLA')}>Edit Filament</button>,
}));
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
  instances: [],
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
    useProjectStore.setState({ projectMutationPendingCount: 0 });
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

  it('owns one preset dialog and ignores a second edit request while it is open', async () => {
    const runtime = {
      getPresetDraft: vi.fn(async (kind: 'printer' | 'filament', canonicalName: string) => ({
        ok: true as const,
        version: 1 as const,
        kind,
        canonicalName: `${canonicalName} canonical`,
        draftExists: false,
        modified: false,
        overrides: {},
        sourceValues: {},
        effectiveValues: {},
        optionMetadata: {},
        revision: 3,
      })),
    };
    platform.runtime = runtime as unknown as PlatformCapabilities['runtime'];
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace /></PlatformProvider>);
    });

    await act(async () => {
      (container.querySelector('[data-testid="mock-printer-edit"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(runtime.getPresetDraft).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('[data-testid="preset-editor-dialog"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe('Printer A');

    await act(async () => {
      (container.querySelector('[data-testid="mock-filament-edit"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(runtime.getPresetDraft).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('[data-testid="preset-editor-dialog"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe('Printer A');
  });

  it('refreshes an open preset editor from the restored native draft after Undo or Redo', async () => {
    let reads = 0;
    const runtime = {
      getPresetDraft: vi.fn(async (kind: 'printer' | 'filament', canonicalName: string) => {
        reads += 1;
        const height = reads === 1 ? '260' : '256';
        return {
          ok: true as const,
          version: 1 as const,
          kind,
          canonicalName,
          draftExists: reads === 1,
          modified: reads === 1,
          overrides: reads === 1 ? { printable_height: height } : {},
          sourceValues: { printable_height: '256' },
          effectiveValues: { printable_height: height },
          optionMetadata: { printable_height: { type: 'float' as const, min: 0, max: 256 } },
          revision: reads,
        };
      }),
    };
    platform.runtime = runtime as unknown as PlatformCapabilities['runtime'];
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace /></PlatformProvider>);
    });

    await act(async () => {
      (container.querySelector('[data-testid="mock-printer-edit"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(runtime.getPresetDraft).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="preset-editor-effective-printable_height"]')?.textContent).toBe('260');

    await act(async () => {
      useHistoryRestoreStore.setState({ phase: 'restoring', revision: 4 });
      useHistoryRestoreStore.setState({ phase: 'idle', revision: 4 });
      await Promise.resolve();
    });
    expect(runtime.getPresetDraft).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="preset-editor-effective-printable_height"]')?.textContent).toBe('256');
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

  it('threads the committed model-add callback to the viewport action surfaces', async () => {
    const onModelAdded = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace activeTab="prepare" onModelAdded={onModelAdded} /></PlatformProvider>);
    });

    expect(testMocks.viewportProps.at(-1)?.onModelAdded).toBe(onModelAdded);
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

  it('projects ordinary history through one targeted SceneDelta read and never uses the full model route', async () => {
    const getModelStructure = vi.fn(async () => ({ ok: true as const, objects: [] }));
    const getModelMesh = vi.fn(async () => ({ ok: true as const, objects: [] }));
    const getModelScenePatch = vi.fn(async () => ({
      ok: true as const, objectOrder: [], objects: [], meshes: [], geometries: [],
    }));
    const restore = {
      ok: true as const,
      context: { selection: { mode: 'object' as const, objectIds: [], partIds: [], instanceIds: [] }, activePlateId: 'plate-a', gizmo: null, nativeScopedConfig: {}, plateSession: twoPlateSnapshot },
      status: { canUndo: false, canRedo: false, undoEntries: [], redoEntries: [], cursor: 0, savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: false, bytesUsed: 0, byteBudget: 1, evictedEntryCount: 0, lastEvictedEntryId: null, oldestRetainedEntryId: null, oversizedEntryRetained: false, disabled: false, activeTransactionId: null, revision: 1 },
      sceneDelta: { version: 1 as const, objectIds: [], volumeIds: [], instanceIds: [], plateIds: ['plate-a', 'plate-b'], objectOrder: [] },
      impact: { version: 1 as const, model: 'delta' as const, plateSession: true, filamentRack: false, presetDrafts: false, nativeScopedConfig: true, selectionContext: true, primeTower: true, preview: 'all' as const },
    };
    const runtime = {
      undoHistory: vi.fn(async () => restore), redoHistory: vi.fn(), jumpHistory: vi.fn(), cancel: vi.fn(),
      getModelStructure, getModelMesh, getModelScenePatch,
      getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, error: 'unused' })),
      getPlateSessionSnapshot: vi.fn(async () => ({ ...twoPlateSnapshot, inputRevisions: { ...twoPlateSnapshot.inputRevisions } })),
      getPrimeTowerProjection: vi.fn(async () => ({
        ok: true as const, version: 1 as const, currentPlateId: 'plate-a',
        buildArea: { minX: 0, maxX: 220, minY: 0, maxY: 220, maxZ: 250 },
        plates: [{ plateId: 'plate-a', displayIndex: 0, eligible: true, forced: false, empty: false, usedSlots: [0], brimMargin: 0,
          position: { x: 20, y: 30 }, width: 20, depth: 16, height: 40, rotation: 0,
          footprint: { minX: 20, maxX: 40, minY: 30, maxY: 46 },
          buildArea: { minX: 0, maxX: 220, minY: 0, maxY: 220, maxZ: 250 }, bands: [] }],
      })),
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
    expect(getModelScenePatch).toHaveBeenCalledOnce();
    expect(getModelScenePatch).toHaveBeenCalledWith([], []);
    expect(getModelStructure).not.toHaveBeenCalled();
    expect(getModelMesh).not.toHaveBeenCalled();
    expect(runtime.getPlateSessionSnapshot).toHaveBeenCalledTimes(plateReadsBeforeRestore);
    expect(runtime.getPrimeTowerProjection).toHaveBeenCalledTimes(projectionReadsBeforeRestore + 1);
    expect(useHistoryDiagnosticsStore.getState().app).toMatchObject({
      directRestore: { count: 1 }, projection: { count: 1 },
    });
  });

  it('refreshes tower visibility from committed transform stamps without reloading scene geometry', async () => {
    const buildArea = { minX: 0, maxX: 220, minY: 0, maxY: 220, maxZ: 250 };
    const projected: PrimeTowerProjection = {
      ok: true, version: 1, currentPlateId: 'plate-a', buildArea,
      plates: [{
        plateId: 'plate-a', displayIndex: 0, eligible: true, forced: true, empty: false, usedSlots: [1],
        width: 20, depth: 16, height: 20, position: { x: 20, y: 30 }, rotation: 0, brimMargin: 0,
        footprint: { minX: 20, maxX: 40, minY: 30, maxY: 46 }, buildArea,
        bands: [{ slot: 1, colour: '#ff0000', opacity: 0.66, startDepth: 0, endDepth: 16 }],
      }],
    };
    let currentProjection = projected;
    const runtime = { getPrimeTowerProjection: vi.fn(async () => currentProjection) };
    platform.runtime = runtime as unknown as PlatformCapabilities['runtime'];
    usePlateSessionStore.getState().setSnapshot(twoPlateSnapshot);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><Workspace activeTab="prepare" /></PlatformProvider>);
    });
    const scene = testMocks.viewportProps.at(-1)?.glVolumes;
    const towers = testMocks.viewportProps.at(-1)?.wipeTowerVolumes as WipeTowerVolumeCollection;
    expect(towers.volumes).toHaveLength(1);
    expect(runtime.getPrimeTowerProjection).toHaveBeenCalledOnce();

    currentProjection = { ...projected, plates: [{ ...projected.plates[0]!, eligible: false, empty: true,
      width: 0, depth: 0, height: 0, bands: [], usedSlots: [] }] };
    await act(async () => {
      useProjectStore.getState().beginProjectMutation();
      applySettledTransformSyncResult({ ok: true, plateSession: { ...twoPlateSnapshot,
        instanceTransforms: [],
        inputRevisions: { 'plate-a': 2, 'plate-b': 1 }, affectedPlateIds: ['plate-a'], dirtyReasons: ['model-transform'],
      } });
    });
    // A mutation receipt precedes the native history commit. Keep the previous
    // projection until the same project transaction finishes publication.
    expect(towers.volumes).toHaveLength(1);
    expect(runtime.getPrimeTowerProjection).toHaveBeenCalledOnce();
    await act(async () => { useProjectStore.getState().endProjectMutation(); });
    expect(towers.volumes).toHaveLength(0);
    expect(runtime.getPrimeTowerProjection).toHaveBeenCalledTimes(2);
    expect(testMocks.viewportProps.at(-1)?.glVolumes).toBe(scene);

    currentProjection = projected;
    await act(async () => {
      applySettledTransformSyncResult({ ok: true, plateSession: { ...twoPlateSnapshot,
        instanceTransforms: [],
        inputRevisions: { 'plate-a': 3, 'plate-b': 1 }, affectedPlateIds: ['plate-a'], dirtyReasons: ['model-transform'],
      } });
    });
    expect(towers.volumes).toHaveLength(1);
    expect(runtime.getPrimeTowerProjection).toHaveBeenCalledTimes(3);
    expect(testMocks.viewportProps.at(-1)?.glVolumes).toBe(scene);

    await act(async () => {
      const snapshot = usePlateSessionStore.getState().snapshot!;
      usePlateSessionStore.getState().setSnapshot({ ...snapshot, currentPlateId: 'plate-b' });
    });
    expect(runtime.getPrimeTowerProjection).toHaveBeenCalledTimes(3);
  });
});
