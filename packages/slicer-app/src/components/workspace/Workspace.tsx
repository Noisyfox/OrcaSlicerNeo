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
import { glVolumeCollection, waitForGLVolumeRevision } from './viewport/GLVolume';
import { useModelLoader } from './viewport/useModelLoader';
import { useSliceResult } from './viewport/useSliceResult';
import { hasEnteredPreview, isPreviewTab, type AppTab } from '../layout/appTabs';
import { createWorkspaceSliceCoordinator, type WorkspaceSliceCoordinator } from './sliceCoordinator';
import { sliceModel } from './actions/sliceActions';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { usePlateSessionStore } from '../../stores/usePlateSessionStore';
import { useObjectListStore } from './objectList/useObjectListStore';
import { PreviewPlateList } from './PreviewPlateList';
import { applyPlateSessionResponse, applyPrimeTowerMoveMutation, selectPlateSessionAndClearSelection } from './plateSessionActions';
import { createHistoryRestoreCoordinator, type HistoryRestoreCoordinator } from '../../history/restoreCoordinator';
import { TransformHistoryCoordinator } from './actions/transformHistory';
import { projectHistoryStatus } from './actions/historyMutation';
import { applyPlateSessionTransforms } from './actions/syncModelTransforms';
import { applyTransformRestoreReceipt, isTransformRestoreProjectionCompatible } from './actions/transformRestoreProjection';
import { moveRestoreSessionProofResult } from './actions/moveRestoreProjection';
import type { PlateSessionSnapshot, ProjectConfigOverlay } from '@slicer/client';
import { FilamentRack } from './FilamentRack';
import { useFilamentSessionStore } from '../../stores/useFilamentSessionStore';
import { publishRememberedFilamentRack } from '../../preferences';
import { useHistoryRestoreStore } from '../../stores/useHistoryRestoreStore';
import { WipeTowerVolumeCollection } from './viewport/WipeTowerVolume';
import type { PrimeTowerMoveResultOrError } from '@slicer/client';
import { captureHistoryTransportDiagnostics, historyDiagnosticNow, type HistoryObservabilitySnapshot, useHistoryDiagnosticsStore } from '../../history/historyDiagnostics';

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

/**
 * The reactive effect is intentionally broad: any of these renderer inputs
 * may make a Prime Tower projection stale.  A direct history restore also
 * reads the projection explicitly while the restore barrier is active.  Once
 * that read has been applied, the subsequent idle-phase effect sees this same
 * identity and must not issue the identical expensive Worker read again.
 */
function samePrimeTowerProjectionInputs(
  left: readonly unknown[] | null,
  right: readonly unknown[],
): boolean {
  return left !== null && left.length === right.length && left.every((value, index) => value === right[index]);
}

function primeTowerSessionInputs(): readonly unknown[] {
  const filamentSnapshot = useFilamentSessionStore.getState().snapshot;
  const plateSession = usePlateSessionStore.getState().snapshot;
  // Runtime snapshots are intentionally fresh immutable objects. Compare the
  // native revisions/content that influence the tower instead of object
  // identity, so republishing an equivalent filament or plate snapshot after
  // a direct history restore cannot invalidate an already-applied projection.
  return [
    JSON.stringify(filamentSnapshot?.revisions ?? null),
    JSON.stringify(plateSession ? {
      currentPlateId: plateSession.currentPlateId,
      inputRevisions: plateSession.inputRevisions,
    } : null),
    JSON.stringify(useSettingsStore.getState().overlay),
  ];
}

function capturePrimeTowerProjectionInputs(glVolumes: ReadonlyArray<{ id: string }>): readonly unknown[] {
  const structure = useObjectListStore.getState().structure;
  return [
    useHistoryRestoreStore.getState().revision,
    ...primeTowerSessionInputs(),
    // The model loader and object list can republish equivalent arrays while
    // React flushes store updates from one restore. Their stable IDs express
    // the geometry/structure change relevant to tower eligibility without
    // converting those harmless fresh array identities into Worker work.
    glVolumes.map((volume) => volume.id).join(','),
    structure.map((object) => [
      object.id,
      object.volumes.map((volume) => volume.id).join(','),
      object.instances.map((instance) => instance.id).join(','),
    ].join(':')).join('|'),
  ];
}

export function Workspace({
  activeTab = 'prepare',
  onSceneInteractionChange,
  onSliceCoordinatorChange,
  onHistoryRestoreCoordinatorChange,
  onRequestPreview,
  onModelAdded,
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
  // Shared model actions call this only after the scene mutation commits.
  onModelAdded?: () => void;
  // Home/Device → Preview first renders the Preview tree while this persistent
  // workspace panel is still hidden, then App reveals the panel on this signal.
  onPreviewRenderReady?: () => void;
  onPreviewTransitionChange?: (transition: PreviewRenderTransition | null) => void;
}) {
  const platform = usePlatform();
  const plateSession = usePlateSessionStore((s) => s.snapshot);
  const structure = useObjectListStore((s) => s.structure);
  const currentPlateId = usePlateSessionStore((s) => s.snapshot?.currentPlateId ?? null);
  const setPlateSnapshot = usePlateSessionStore((s) => s.setSnapshot);
  const settingsOverlay = useSettingsStore((s) => s.overlay);
  const filamentSnapshot = useFilamentSessionStore((s) => s.snapshot);
  const historyRestorePhase = useHistoryRestoreStore((s) => s.phase);
  const historyRestoreRevision = useHistoryRestoreStore((s) => s.revision);
  const glVolumes = useModelLoader();
  const sliceResult = useSliceResult();
  const primeTowerRefreshRef = useRef<((forceDuringRestore?: boolean, forceRead?: boolean) => Promise<void>) | null>(null);
  const primeTowerRefreshGenerationRef = useRef(0);
  const primeTowerProjectionInputsRef = useRef<readonly unknown[] | null>(null);
  const primeTowerProjectionReadRef = useRef<{
    inputs: readonly unknown[];
    promise: Promise<void>;
  } | null>(null);
  const primeTowerGlVolumesRef = useRef(glVolumes);
  primeTowerGlVolumesRef.current = glVolumes;
  const wipeTowerVolumesRef = useRef<WipeTowerVolumeCollection | null>(null);
  if (!wipeTowerVolumesRef.current) {
    wipeTowerVolumesRef.current = new WipeTowerVolumeCollection({
      move: async (request): Promise<PrimeTowerMoveResultOrError> => {
        // Invalidate reads started by a preceding filament/structure refresh.
        // Without this fence a late pre-move projection can overwrite the
        // authoritative result below and make the released tower snap back.
        primeTowerRefreshGenerationRef.current += 1;
        const result = await platform.runtime.movePrimeTower(request);
        if (result.ok) {
          applyPrimeTowerMoveMutation(platform, result.result.mutation);
          // WipeTowerVolumeCollection applies the same authoritative move
          // receipt (position and footprint) immediately after this command
          // returns, within this one commit turn.
          // The accompanying plate-revision publication must therefore not
          // schedule a redundant full projection read that can overlap Undo.
          primeTowerProjectionInputsRef.current = capturePrimeTowerProjectionInputs(primeTowerGlVolumesRef.current);
        }
        return result;
      },
      reconcile: async () => { await primeTowerRefreshRef.current?.(false, true); },
      revision: (plateId) => usePlateSessionStore.getState().snapshot?.inputRevisions?.[plateId] ?? -1,
      publishHistoryStatus: async (status) => {
        projectHistoryStatus(status);
      },
    }, {
      recordSetProjection: (durationMs) => useHistoryDiagnosticsStore.getState().recordPrimeTowerSetProjection(durationMs),
      recordReconcile: (durationMs) => useHistoryDiagnosticsStore.getState().recordPrimeTowerReconcile(durationMs),
      recordEmit: (durationMs) => useHistoryDiagnosticsStore.getState().recordPrimeTowerEmit(durationMs),
    });
  }
  const wipeTowerVolumes = wipeTowerVolumesRef.current;
  // Workspace is kept mounted by AppShell.  The shared controller sees both
  // native model GLVolumes and scene-only wipe-tower GLVolumes, exactly like
  // Orca's GLVolumeCollection.
  const sceneInteractionRef = useRef<SceneInteractionController | null>(null);
  if (!sceneInteractionRef.current) {
    sceneInteractionRef.current = new SceneInteractionController(() => [...glVolumeCollection.volumes, ...wipeTowerVolumes.volumes]);
    sceneInteractionRef.current.setSceneEntityCommitPort({ commit: (volume) => wipeTowerVolumes.commit(volume), busy: () => wipeTowerVolumes.busy });
  }
  const sceneInteraction = sceneInteractionRef.current;
  const refreshPrimeTowerProjection = useCallback((forceDuringRestore = false, forceRead = false): Promise<void> => {
    // A projection read started before a history restore may complete after
    // native Undo/Redo and otherwise re-publish the pre-restore coordinates.
    // The restore callback explicitly opts in once the native operation has
    // committed; ordinary reactive refreshes stay out of that window.
    if (!forceDuringRestore && useHistoryRestoreStore.getState().phase !== 'idle') return Promise.resolve();
    // Deliberately exclude restore phase: the explicit read happens while
    // restoring and the reactive effect happens after it becomes idle.  They
    // are one projection when every actual renderer input below is identical.
    const inputs = capturePrimeTowerProjectionInputs(primeTowerGlVolumesRef.current);
    if (!forceRead && samePrimeTowerProjectionInputs(primeTowerProjectionInputsRef.current, inputs)) return Promise.resolve();
    const activeRead = primeTowerProjectionReadRef.current;
    if (activeRead && samePrimeTowerProjectionInputs(activeRead.inputs, inputs)) return activeRead.promise;
    const generation = ++primeTowerRefreshGenerationRef.current;
    const historyRevision = inputs[0];
    const projectionReadStartedAt = historyDiagnosticNow();
    const read = (async () => {
      let applied = false;
      try {
        const result = await platform.runtime.getPrimeTowerProjection();
        if (generation !== primeTowerRefreshGenerationRef.current ||
            historyRevision !== useHistoryRestoreStore.getState().revision) return;
        wipeTowerVolumes.setProjection(result.ok ? result : null, usePlateSessionStore.getState().snapshot);
        applied = true;
      } catch {
        if (generation !== primeTowerRefreshGenerationRef.current ||
            historyRevision !== useHistoryRestoreStore.getState().revision) return;
        wipeTowerVolumes.setProjection(null);
        applied = true;
      } finally {
        // Record only a projection that was actually published.  A later
        // input/revision can invalidate an in-flight read, and its result must
        // neither overwrite nor satisfy the newer reactive projection.
        if (applied) primeTowerProjectionInputsRef.current = inputs;
        useHistoryDiagnosticsStore.getState().recordPrimeTowerProjectionRead(
          historyDiagnosticNow() - projectionReadStartedAt,
        );
      }
    })();
    primeTowerProjectionReadRef.current = { inputs, promise: read };
    void read.then(
      () => {
        if (primeTowerProjectionReadRef.current?.promise === read) primeTowerProjectionReadRef.current = null;
      },
      () => {
        if (primeTowerProjectionReadRef.current?.promise === read) primeTowerProjectionReadRef.current = null;
      },
    );
    return read;
  }, [platform.runtime, wipeTowerVolumes]);
  primeTowerRefreshRef.current = refreshPrimeTowerProjection;
  useEffect(() => {
    // Effects queued by a render during restore may execute after a later
    // commit has switched the shared store back to idle.  Gate on this
    // render's phase before entering the callback, otherwise those obsolete
    // effects turn into full projections after the explicit restore read.
    if (historyRestorePhase !== 'idle') return;
    void refreshPrimeTowerProjection();
  }, [filamentSnapshot, glVolumes, historyRestorePhase, historyRestoreRevision,
    refreshPrimeTowerProjection, settingsOverlay, structure]);
  useEffect(() => {
    if (plateSession) wipeTowerVolumes.setCurrentPlate(plateSession.currentPlateId, plateSession);
  }, [plateSession?.currentPlateId, wipeTowerVolumes]);
  useEffect(() => wipeTowerVolumes.subscribe(() => {
    // Projection removal, eligibility and current-plate changes can replace
    // scene-only volumes; prune the one shared Selection immediately.
    sceneInteraction.pruneSelection();
  }), [sceneInteraction, wipeTowerVolumes]);
  // Structural edits replace the renderer collection asynchronously. Prune
  // only after the fresh stable-ID mesh is installed so deleted entities do
  // not remain selected through stale positional indices.
  useEffect(() => {
    sceneInteraction.pruneSelection();
  }, [glVolumes, sceneInteraction]);
  const transformHistoryRef = useRef<TransformHistoryCoordinator | null>(null);
  if (!transformHistoryRef.current) {
    transformHistoryRef.current = new TransformHistoryCoordinator(platform.runtime, sceneInteraction);
    sceneInteraction.setTransformHistoryPort(transformHistoryRef.current);
  }
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
  if (!historyRestoreRef.current) {
    historyRestoreRef.current = createHistoryRestoreCoordinator({
      runtime: platform.runtime,
      sceneInteraction,
      sliceCoordinator,
      refreshModel: async (context, impact, revision, primeTowerReceipt, instanceTransforms, transformReceipt) => {
        // Impact is atomically published by the Worker with the committed
        // cursor. A validated adjacent Move receipt can patch the retained
        // GL collection; missing/incompatible same-session descriptors use
        // the authoritative full structure read and mesh replacement below.
        const retainedStructure = { ok: true as const, objects: useObjectListStore.getState().structure };
        // Adjacent native Move restores retain the existing mesh collection.
        // Validate the complete receipt against stable IDs and indexes before
        // deciding to skip the full Worker structure/GL reload. A malformed,
        // stale, or incompatible receipt simply takes the authoritative path
        // below.
        const canApplyTransformReceipt = Boolean(transformReceipt &&
          isTransformRestoreProjectionCompatible(transformReceipt, retainedStructure, glVolumeCollection.volumes));
        const retainedPlateSession = usePlateSessionStore.getState().snapshot;
        // A direct Move is the only model restore allowed to reuse the
        // renderer's retained plate/session projection. The native context is
        // normalized by the client and compared field-for-field (membership,
        // current plate, parking/bounds, plate metadata, and revisions).
        // Instance transforms are the receipt's explicit delta and are the
        // sole omitted field.
        const moveProof = moveRestoreSessionProofResult(context, retainedPlateSession,
          useSettingsStore.getState().overlay, transformReceipt);
        if (transformReceipt && moveProof.failure)
          useHistoryDiagnosticsStore.getState().recordTransformReceiptProofFailure(moveProof.failure);
        else if (transformReceipt && !canApplyTransformReceipt)
          useHistoryDiagnosticsStore.getState().recordTransformReceiptProofFailure('renderer-receipt-incompatible');
        const canUseDirectMoveReceipt = Boolean(transformReceipt && canApplyTransformReceipt && moveProof.session);
        if (canUseDirectMoveReceipt && historyRestoreRef.current?.currentRevision() !== revision) return;
        const projectFullModel = async () => {
          const fullStructure = await platform.runtime.getModelStructure();
          if (!fullStructure.ok || !fullStructure.objects)
            throw new Error(fullStructure.error ?? 'getModelStructure failed during history restore');
          if (historyRestoreRef.current?.currentRevision() !== revision) return null;
          // A valid restore may legitimately land on the empty baseline. Keep
          // the loader's modelLoaded gate aligned with the Worker model before
          // its revision-fenced mesh request runs.
          useSettingsStore.getState().setModelLoaded(fullStructure.objects.length > 0);
          const modelRevision = useSettingsStore.getState().modelRevision;
          await waitForGLVolumeRevision(modelRevision);
          if (historyRestoreRef.current?.currentRevision() !== revision) return null;
          useObjectListStore.getState().setStructure(fullStructure.objects);
          useObjectListStore.getState().setLoaded(fullStructure.objects.length > 0);
          return fullStructure;
        };
        let structure;
        if (impact.model === 'full' && !canUseDirectMoveReceipt) {
          structure = await projectFullModel();
          if (!structure) return;
        } else {
          // Direct Prime Tower restoration has no model mutation. Reuse the
          // stable Worker-projected structure only for context ID resolution.
          structure = retainedStructure;
        }
        if (impact.projectOverlay) {
          const overlay = context.projectConfigOverlay;
          if (overlay && typeof overlay === 'object' && 'project' in overlay && 'objects' in overlay && 'parts' in overlay && 'plates' in overlay)
            useSettingsStore.getState().setOverlay(overlay as unknown as ProjectConfigOverlay);
        }

        let freshPlateSession: PlateSessionSnapshot | null = null;
        const getPlateSessionSnapshot = platform.runtime.getPlateSessionSnapshot;
        if (canUseDirectMoveReceipt && context.plateSession) {
          freshPlateSession = context.plateSession;
          usePlateSessionStore.getState().setSnapshot(freshPlateSession);
          // Keep the scene-only tower collection on the same native session
          // before applying the transform receipt. setCurrentPlate also
          // republishes the session when the active plate itself is unchanged.
          wipeTowerVolumes.setCurrentPlate(freshPlateSession.currentPlateId, freshPlateSession);
        } else if (impact.plateSession && typeof getPlateSessionSnapshot === 'function') {
          const plateSessionStartedAt = historyDiagnosticNow();
          let session;
          try {
            session = await getPlateSessionSnapshot.call(platform.runtime);
          } finally {
            useHistoryDiagnosticsStore.getState().recordPlateSessionSnapshot(
              historyDiagnosticNow() - plateSessionStartedAt,
            );
          }
          if (!session.ok) throw new Error(session.error ?? 'getPlateSessionSnapshot failed during history restore');
          if (historyRestoreRef.current?.currentRevision() !== revision) return;
          usePlateSessionStore.getState().setSnapshot(session);
          freshPlateSession = session;
          const transformsStartedAt = historyDiagnosticNow();
          if (session.instanceTransforms)
            applyPlateSessionTransforms({ instanceTransforms: session.instanceTransforms }, glVolumeCollection.volumes);
          if (instanceTransforms)
            applyPlateSessionTransforms({ instanceTransforms }, glVolumeCollection.volumes);
          useHistoryDiagnosticsStore.getState().recordPlateSessionTransforms(
            historyDiagnosticNow() - transformsStartedAt,
          );
        } else if (impact.plateSession) {
          const session = usePlateSessionStore.getState().snapshot;
          if (session && context.activePlateId && session.plates.some((plate) => plate.plateId === context.activePlateId))
            usePlateSessionStore.getState().setSnapshot({ ...session, currentPlateId: context.activePlateId });
        }
        let transformReceiptApplied = false;
        if (canUseDirectMoveReceipt && transformReceipt) {
          const receiptStartedAt = historyDiagnosticNow();
          transformReceiptApplied = applyTransformRestoreReceipt(transformReceipt, structure, glVolumeCollection.volumes);
          useHistoryDiagnosticsStore.getState().recordTransformReceiptApplication(
            historyDiagnosticNow() - receiptStartedAt,
          );
        }
        if (canUseDirectMoveReceipt && !transformReceiptApplied) {
          // The collection changed between validation and publication. The
          // same authoritative full projection is the safe recovery path.
          structure = await projectFullModel();
          if (!structure) return;
        }
        if (transformReceipt)
          useHistoryDiagnosticsStore.getState().recordTransformReceipt(transformReceiptApplied);
        if (impact.selectionContext) {
          const selectionStartedAt = historyDiagnosticNow();
          const contextSelectionEmpty = context.selection.objectIds.length === 0 &&
            context.selection.partIds.length === 0 && context.selection.instanceIds.length === 0;
          const fallbackSelectionIds = canUseDirectMoveReceipt && contextSelectionEmpty
            ? [...sceneInteraction.selection.ids] : [];
          sceneInteraction.restoreHistoryContext(context, structure, fallbackSelectionIds);
          useHistoryDiagnosticsStore.getState().recordSelectionRestore(
            historyDiagnosticNow() - selectionStartedAt,
          );
        }
        // A Prime Tower receipt is a separate narrow acceleration. It may
        // patch the retained all-plate projection only after the authoritative
        // plate session confirms the exact native plate revision. A direct
        // Move receipt uses a narrow authoritative read when its target
        // session can change tower semantics. Any absent/mismatched receipt,
        // full-model restore, stale generation, or collection state we cannot
        // prove safe falls through to the authoritative all-plate projection.
        let receiptApplied = false;
        if (impact.model === 'none' && impact.plateSession && primeTowerReceipt && freshPlateSession &&
            historyRestoreRef.current?.currentRevision() === revision) {
          try {
            receiptApplied = wipeTowerVolumes.applyRestoreReceipt(primeTowerReceipt, freshPlateSession);
          } catch {
            receiptApplied = false;
          }
        }
        if (receiptApplied) {
          // Invalidate any older read and make the following idle-phase effect
          // observe this native receipt as satisfying its exact inputs.
          primeTowerRefreshGenerationRef.current += 1;
          primeTowerProjectionInputsRef.current = capturePrimeTowerProjectionInputs(primeTowerGlVolumesRef.current);
        } else if (canUseDirectMoveReceipt && transformReceiptApplied) {
          // Move can change the model's printable/empty status when an
          // instance crosses a plate boundary (the real u1 fixture does this
          // through its out-of-bounds transition). Tower eligibility and its
          // derived footprint are therefore not receipt-independent. Read
          // only the narrow all-plate tower projection; never reload model
          // structure or replay the full plate-session transform list.
          await refreshPrimeTowerProjection(true);
          if (historyRestoreRef.current?.currentRevision() !== revision) return;
        } else if (impact.primeTower) {
          // History restores change native wipe_tower_x/y without necessarily
          // changing model structure or the settings overlay reference.
          await refreshPrimeTowerProjection(true);
        }
        return transformReceiptApplied ? 'direct' : impact.model === 'none' ? 'direct' : 'full';
      },
      publishRestoredFilamentRack: async (revision) => {
        if (useHistoryRestoreStore.getState().revision !== revision) return;
        const filamentSnapshotStartedAt = historyDiagnosticNow();
        let snapshot;
        try {
          snapshot = await platform.runtime.getFilamentSessionSnapshot();
        } finally {
          useHistoryDiagnosticsStore.getState().recordFilamentSnapshot(
            historyDiagnosticNow() - filamentSnapshotStartedAt,
          );
        }
        if (snapshot.ok && useHistoryRestoreStore.getState().revision === revision) {
          const preferencePersistenceStartedAt = historyDiagnosticNow();
          try {
            await publishRememberedFilamentRack(
              platform.preferences,
              useSettingsStore.getState().selectedPrinter,
              snapshot,
            );
          } finally {
            useHistoryDiagnosticsStore.getState().recordFilamentPreferencePersistence(
              historyDiagnosticNow() - preferencePersistenceStartedAt,
            );
          }
        }
      },
    });
  }
  const historyRestore = historyRestoreRef.current;
  useEffect(() => {
    const env = import.meta.env as { MODE?: string; VITE_E2E?: string };
    if (env.MODE !== 'e2e' && env.VITE_E2E !== '1') return;
    const w = window as unknown as {
      __orcaE2e?: { historyDiagnostics?: () => HistoryObservabilitySnapshot };
    };
    w.__orcaE2e = {
      ...w.__orcaE2e,
      historyDiagnostics: () => {
        captureHistoryTransportDiagnostics(platform.runtime);
        const { recordMutation: _mutation, recordQueue: _queue, recordRestore: _restore,
          recordFilamentRefresh: _filament, recordFilamentSnapshot: _filamentSnapshot,
          recordFilamentPreferencePersistence: _filamentPreferences,
          recordProjection: _projection, recordPrimeTowerProjectionRead: _projectionRead,
          recordPrimeTowerSetProjection: _setProjection, recordPrimeTowerReconcile: _reconcile,
          recordPrimeTowerEmit: _emit, recordPlateSessionSnapshot: _plateSession,
          recordPlateSessionTransforms: _plateTransforms, recordTransformReceiptApplication: _receiptApplication,
          recordSelectionRestore: _selectionRestore,
          recordTransformReceiptProofFailure: _proofFailure,
          recordTransformReceipt: _transformReceipt,
          setTransport: _transport, reset: _reset, ...snapshot } = useHistoryDiagnosticsStore.getState();
        return snapshot;
      },
    };
    return () => {
      if (!w.__orcaE2e) return;
      const { historyDiagnostics: _historyDiagnostics, ...rest } = w.__orcaE2e;
      w.__orcaE2e = rest;
    };
  }, [platform.runtime]);
  // A transform draft is renderer-local until its atomic Worker command
  // succeeds.  Rebuild every projection on cancellation or rejection so a
  // partial/obsolete draft can never survive an aborted history transaction.
  transformHistoryRef.current.setReconcile(async () => {
    const structure = await platform.runtime.getModelStructure();
    if (!structure.ok || !structure.objects)
      throw new Error(structure.error ?? 'getModelStructure failed while reconciling transforms');
    useSettingsStore.getState().setModelLoaded(structure.objects.length > 0);
    const modelRevision = useSettingsStore.getState().modelRevision;
    await waitForGLVolumeRevision(modelRevision);
    useObjectListStore.getState().setStructure(structure.objects);
    useObjectListStore.getState().setLoaded(structure.objects.length > 0);
    const plateSession = await platform.runtime.getPlateSessionSnapshot();
    if (!plateSession.ok)
      throw new Error(plateSession.error ?? 'getPlateSessionSnapshot failed while reconciling transforms');
    usePlateSessionStore.getState().setSnapshot(plateSession);
    if (plateSession.instanceTransforms)
      applyPlateSessionTransforms({ instanceTransforms: plateSession.instanceTransforms }, glVolumeCollection.volumes);
    sceneInteraction.pruneSelection();
  });
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
          {activeTab === 'prepare' && <FilamentRack />}
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
          wipeTowerVolumes={wipeTowerVolumes}
          activeTab={isPreviewTab(activeTab) || previewRenderPending ? 'preview' : 'prepare'}
          glVolumes={glVolumes}
          structure={structure}
          toolpath={sliceResult.toolpath}
          previewFrameRequest={previewFrameRequest}
          onModelAdded={onModelAdded}
          onSceneFrameRendered={handleSceneFrameRendered}
        />
      </main>
    </div>
  );
}
