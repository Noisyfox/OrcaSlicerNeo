// The sidebar/scene split: owns the resizable divider between the settings
// sidebar and the 3D scene, and the scene interaction controller the two
// halves share. AppShell stacks this between the toolbar and status rows.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { usePlatform } from '@orca/platform-contract';
import { ObjectList } from './objectList/ObjectList';
import { SettingsPanel } from './settings/SettingsPanel';
import { Viewport } from './viewport/Viewport';
import { SceneInteractionController } from './viewport/SceneInteractionController';
import { glVolumeCollection } from './viewport/GLVolume';
import { useModelLoader } from './viewport/useModelLoader';
import { useSliceResult } from './viewport/useSliceResult';
import { hasEnteredPreview, isPreviewTab, type AppTab } from '../layout/appTabs';
import { createWorkspaceSliceCoordinator, type WorkspaceSliceCoordinator } from './sliceCoordinator';
import { sliceModel } from './actions/sliceActions';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { usePlateSessionStore } from '../../stores/usePlateSessionStore';
import { PreviewPlateList } from './PreviewPlateList';
import { selectPlateSessionAndClearSelection } from './plateSessionActions';
import { createHistoryRestoreCoordinator, type HistoryRestoreCoordinator } from '../../history/restoreCoordinator';
import { isHistoryContextProjectionReady, type PendingHistoryContext } from '../../history/historyContextProjection';

const DEFAULT_SIDEBAR_WIDTH = 288; // matches the previous `w-72` (18rem)
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 560;
export interface PreviewRenderTransition {
  begin(): void;
  cancel(): void;
}
function clampSidebarWidth(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value!));
}

export function Workspace({
  activeTab = 'prepare',
  onSceneInteractionChange,
  onSliceCoordinatorChange,
  onHistoryRestoreCoordinatorChange,
  onRequestPreview,
  onPreviewRenderReady,
  onPreviewTransitionChange,
}: {
  activeTab?: AppTab;
  // The scene controller lives here, but the menu command dispatcher needs it
  // too; this hands it up without making the owner re-render on every change.
  onSceneInteractionChange?: (controller: SceneInteractionController | null) => void;
  onSliceCoordinatorChange?: (coordinator: WorkspaceSliceCoordinator | null) => void;
  onHistoryRestoreCoordinatorChange?: (coordinator: HistoryRestoreCoordinator | null) => void;
  onRequestPreview?: () => void;
  // Home/Device → Preview first renders the Preview tree while this persistent
  // workspace panel is still hidden, then App reveals the panel on this signal.
  onPreviewRenderReady?: () => void;
  onPreviewTransitionChange?: (transition: PreviewRenderTransition | null) => void;
}) {
  const platform = usePlatform();
  const plateSession = usePlateSessionStore((s) => s.snapshot);
  const currentPlateId = usePlateSessionStore((s) => s.snapshot?.currentPlateId ?? null);
  const setPlateSnapshot = usePlateSessionStore((s) => s.setSnapshot);
  const modelRevision = useSettingsStore((s) => s.modelRevision);
  const glVolumes = useModelLoader();
  const sliceResult = useSliceResult();
  // Workspace is kept mounted by AppShell. Keep the controller here, beside
  // the model/result hooks, so a Prepare↔Preview content-tree switch never
  // recreates the interaction state or its volume collection.
  const sceneInteractionRef = useRef<SceneInteractionController | null>(null);
  if (!sceneInteractionRef.current) {
    sceneInteractionRef.current = new SceneInteractionController(() => glVolumeCollection.volumes);
  }
  const sceneInteraction = sceneInteractionRef.current;
  useEffect(() => {
    const getSnapshot = platform.runtime?.getPlateSessionSnapshot;
    if (!getSnapshot) return;
    let active = true;
    void getSnapshot.call(platform.runtime).then((snapshot) => {
      if (active && snapshot.ok) setPlateSnapshot(snapshot);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [platform.runtime, setPlateSnapshot]);
  const sliceCoordinatorRef = useRef<WorkspaceSliceCoordinator | null>(null);
  if (!sliceCoordinatorRef.current) {
    sliceCoordinatorRef.current = createWorkspaceSliceCoordinator({
      isModelLoaded: () => useSettingsStore.getState().modelLoaded,
      getStatus: () => useSlicerStore.getState().status,
      slice: () => sliceModel(platform),
      requestPreview: () => onRequestPreview?.(),
      cancel: () => platform.runtime.cancel(),
    });
  }
  const sliceCoordinator = sliceCoordinatorRef.current;
  const historyRestoreRef = useRef<HistoryRestoreCoordinator | null>(null);
  const pendingHistoryContextRef = useRef<PendingHistoryContext | null>(null);
  const projectionInFlightRef = useRef<number | null>(null);
  if (!historyRestoreRef.current) {
    historyRestoreRef.current = createHistoryRestoreCoordinator({
      runtime: platform.runtime,
      sceneInteraction,
      sliceCoordinator,
      refreshModel: () => useSettingsStore.getState().refreshModel(),
      projectContext: async (context, revision) => {
        const structure = await platform.runtime.getModelStructure();
        if (!structure.ok || historyRestoreRef.current?.currentRevision() !== revision) return;
        // A valid restore may legitimately land on the empty baseline. Keep
        // the loader's modelLoaded gate aligned with the Worker model before
        // its revision-fenced mesh request runs.
        useSettingsStore.getState().setModelLoaded(structure.objects.length > 0);
        const modelRevision = useSettingsStore.getState().modelRevision;
        pendingHistoryContextRef.current = {
          context,
          historyRevision: revision,
          modelRevision,
          expectedObjectCount: structure.objects.length,
        };
        const session = usePlateSessionStore.getState().snapshot;
        if (session && context.activePlateId && session.plates.some((plate) => plate.plateId === context.activePlateId))
          usePlateSessionStore.getState().setSnapshot({ ...session, currentPlateId: context.activePlateId });
      },
    });
  }
  const historyRestore = historyRestoreRef.current;
  useEffect(() => {
    const pending = pendingHistoryContextRef.current;
    if (!pending) return;
    if (!isHistoryContextProjectionReady(
      pending,
      historyRestore.currentRevision(),
      modelRevision,
      glVolumeCollection.revision,
      glVolumes.length,
    ) || projectionInFlightRef.current === pending.historyRevision) return;
    projectionInFlightRef.current = pending.historyRevision;
    void platform.runtime.getModelStructure().then((structure) => {
      const current = pendingHistoryContextRef.current;
      if (structure.ok && current === pending && isHistoryContextProjectionReady(
        current,
        historyRestore.currentRevision(),
        modelRevision,
        glVolumeCollection.revision,
        glVolumes.length,
      )) {
        pendingHistoryContextRef.current = null;
        sceneInteraction.restoreHistoryContext(pending.context, structure);
      }
    }).catch(() => undefined).finally(() => {
      if (projectionInFlightRef.current === pending.historyRevision)
        projectionInFlightRef.current = null;
    });
  }, [glVolumes, historyRestore, modelRevision, platform.runtime, sceneInteraction]);
  const [previewRenderPending, setPreviewRenderPending] = useState(false);
  const [previewPlateSelectionPending, setPreviewPlateSelectionPending] = useState(false);
  const previewFrameTokenRef = useRef(0);
  const [previewFrameRequest, setPreviewFrameRequest] = useState<{ plateId: string; token: number } | null>(null);
  const previewRenderPendingRef = useRef(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const sidebarWidthRef = useRef(sidebarWidth);
  const resizeActiveRef = useRef(false);
  const stopResizeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onSceneInteractionChange?.(sceneInteraction);
    return () => onSceneInteractionChange?.(null);
  }, [onSceneInteractionChange, sceneInteraction]);

  useEffect(() => {
    onSliceCoordinatorChange?.(sliceCoordinator);
    return () => onSliceCoordinatorChange?.(null);
  }, [onSliceCoordinatorChange, sliceCoordinator]);
  useEffect(() => {
    onHistoryRestoreCoordinatorChange?.(historyRestore);
    return () => onHistoryRestoreCoordinatorChange?.(null);
  }, [historyRestore, onHistoryRestoreCoordinatorChange]);

  const beginPreviewRender = useCallback(() => {
    if (isPreviewTab(activeTab)) return;
    previewRenderPendingRef.current = true;
    setPreviewRenderPending(true);
  }, [activeTab]);
  const cancelPreviewRender = useCallback(() => {
    previewRenderPendingRef.current = false;
    setPreviewRenderPending(false);
  }, []);
  useEffect(() => {
    onPreviewTransitionChange?.({ begin: beginPreviewRender, cancel: cancelPreviewRender });
    return () => onPreviewTransitionChange?.(null);
  }, [beginPreviewRender, cancelPreviewRender, onPreviewTransitionChange]);
  useEffect(() => {
    if (!isPreviewTab(activeTab)) return;
    previewRenderPendingRef.current = false;
    setPreviewRenderPending(false);
  }, [activeTab]);
  const handleSceneFrameRendered = useCallback((mode: 'prepare' | 'preview') => {
    if (mode !== 'preview' || !previewRenderPendingRef.current) return;
    previewRenderPendingRef.current = false;
    onPreviewRenderReady?.();
  }, [onPreviewRenderReady]);

  const previousActiveTabRef = useRef<AppTab>(activeTab);
  useEffect(() => {
    const enteredPreview = hasEnteredPreview(previousActiveTabRef.current, activeTab);
    previousActiveTabRef.current = activeTab;
    if (enteredPreview) void sliceCoordinator.ensureSlice();
  }, [activeTab, sliceCoordinator]);

  // Orca Preview follows the selected plate. A retained result is activated
  // synchronously by the viewport; an otherwise valid unsliced plate starts
  // one job automatically when the selection changes in Preview.
  useEffect(() => {
    if (isPreviewTab(activeTab) && currentPlateId) void sliceCoordinator.ensureSlice();
  }, [activeTab, currentPlateId, sliceCoordinator]);

  const selectPreviewPlate = useCallback(async (plateId: string) => {
    if (previewPlateSelectionPending) return;
    const previousPlateId = usePlateSessionStore.getState().snapshot?.currentPlateId;
    setPreviewPlateSelectionPending(true);
    try {
      const selected = await selectPlateSessionAndClearSelection(platform, plateId, () => sceneInteraction.clearSelection());
      // Preview navigation recenters only after a successful switch to a
      // different plate. Clicking the current plate still clears selection,
      // but must not disturb the user's camera.
      if (selected && previousPlateId !== plateId) {
        previewFrameTokenRef.current += 1;
        setPreviewFrameRequest({ plateId, token: previewFrameTokenRef.current });
      }
    } catch (error) {
      useSlicerStore.getState().setError(String(error));
    } finally {
      setPreviewPlateSelectionPending(false);
    }
  }, [platform, previewPlateSelectionPending, sceneInteraction]);

  useEffect(() => {
    let active = true;
    void platform.preferences.load().then((prefs) => {
      if (active) {
        const width = clampSidebarWidth(prefs.ui.sidebarWidth);
        sidebarWidthRef.current = width;
        setSidebarWidth(width);
      }
    });
    return () => { active = false; stopResizeRef.current?.(); };
  }, [platform.preferences]);

  function persistSidebarWidth(width: number) {
    void platform.preferences.load().then((prefs) => platform.preferences.save({
      ...prefs,
      ui: { ...prefs.ui, sidebarWidth: width },
    })).catch(() => undefined);
  }

  function beginResize(clientX: number) {
    if (resizeActiveRef.current) return;
    resizeActiveRef.current = true;

    const startX = clientX;
    const startWidth = sidebarWidthRef.current;
    let active = true;

    const applyClientX = (nextClientX: number) => {
      if (!active) return;
      const nextWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + nextClientX - startX),
      );
      sidebarWidthRef.current = nextWidth;
      setSidebarWidth(nextWidth);
    };

    const onPointerMove = (moveEvent: PointerEvent) => applyClientX(moveEvent.clientX);
    const onMouseMove = (moveEvent: MouseEvent) => applyClientX(moveEvent.clientX);

    const stop = () => {
      if (!active) return;
      active = false;
      stopResizeRef.current = null;
      resizeActiveRef.current = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('pointercancel', stop);
      persistSidebarWidth(sidebarWidthRef.current);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    stopResizeRef.current = stop;

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('mouseup', stop);
    window.addEventListener('pointercancel', stop);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    if (typeof handle.setPointerCapture === 'function') {
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Some test/jsdom environments do not implement pointer capture.
      }
    }
    beginResize(event.clientX);
  }

  function handleResizeMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    beginResize(event.clientX);
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? -16 : 16;
    const nextWidth = Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, sidebarWidthRef.current + delta),
    );
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    persistSidebarWidth(nextWidth);
  }

  return (
    <div className="flex flex-1 min-h-0">
      <aside
        className="shrink-0 overflow-hidden rounded-md border bg-card"
        style={{
          width: `${sidebarWidth}px`,
          minWidth: `${MIN_SIDEBAR_WIDTH}px`,
          maxWidth: `${MAX_SIDEBAR_WIDTH}px`,
        }}
      >
        {/* The aside itself is overflow-hidden so its border-radius clips
            the inner scroller's custom webkit scrollbar (Chromium draws
            ::-webkit-scrollbar chrome as a rectangle, ignoring the
            scroller's rounded corners). */}
        <div className="h-full overflow-y-auto">
          {isPreviewTab(activeTab) && plateSession && (
            <PreviewPlateList
              snapshot={plateSession}
              pending={previewPlateSelectionPending}
              onSelect={selectPreviewPlate}
            />
          )}
          <ObjectList sceneInteraction={sceneInteraction} />
          <SettingsPanel sceneInteraction={sceneInteraction} />
        </div>
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={sidebarWidth}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        tabIndex={0}
        data-testid="sidebar-resizer"
        onPointerDown={handleResizePointerDown}
        onMouseDown={handleResizeMouseDown}
        onKeyDown={handleResizeKeyDown}
        className="w-1.5 shrink-0 cursor-ew-resize touch-none self-stretch rounded-full bg-clip-content px-px transition-colors hover:bg-accent/20 focus-visible:bg-accent/30 focus-visible:outline-none"
      />
      <main className="relative min-w-0 flex-1 overflow-hidden rounded-md border bg-card">
        <Viewport
          sceneInteraction={sceneInteraction}
          activeTab={isPreviewTab(activeTab) || previewRenderPending ? 'preview' : 'prepare'}
          glVolumes={glVolumes}
          toolpath={sliceResult.toolpath}
          previewFrameRequest={previewFrameRequest}
          onSceneFrameRendered={handleSceneFrameRendered}
        />
      </main>
    </div>
  );
}
