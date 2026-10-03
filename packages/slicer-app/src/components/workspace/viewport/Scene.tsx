// packages/slicer-app/src/components/viewport/Scene.tsx
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { LoadedObject } from './useModelLoader';
import { BedPlate } from './BedPlate';
import { useBedModel } from './useBedModel';
import { useBedTexture } from './useBedTexture';
import { GLVolumeMesh } from './ModelMesh';
import type { ToolpathGeometry } from './useSliceResult';
import { ToolpathLines } from './ToolpathLines';
import { ToolpathMarker } from './ToolpathMarker';
import { TransformGizmo, type TransformGizmoMode } from './gizmo/TransformGizmo';
import { SceneInteractionController } from './SceneInteractionController';
import { SceneInteractionProvider, useSceneInteraction, useSceneInteractionVersion } from './SceneInteractionContext';
import { SelectionBoundsBox } from './SelectionBoundsBox';
import { hasEnteredPreview, isPreviewTab } from '@/components/layout/appTabs';
import type { ModelObjectStructure, PlateSessionSnapshot } from '@slicer/client';
import { currentPreviewPlate, previewVolumesForCurrentPlate } from './previewSceneProjection';
import { WipeTowerVolumes } from './WipeTowerVolumeMesh';
import type { WipeTowerVolumeCollection } from './WipeTowerVolume';
import { GizmoPivotProbe, SceneE2eProbe } from '@/e2e/SceneProbe';
import { usePaintingState } from './gizmo/painting/PaintingProvider';
import { FuzzyPaintingGizmo } from './gizmo/painting/FuzzyPaintingGizmo';
import { SeamPaintingGizmo } from './gizmo/painting/SeamPaintingGizmo';
import { SupportPaintingGizmo } from './gizmo/painting/SupportPaintingGizmo';
import { MmuPaintingGizmo } from './gizmo/painting/MmuPaintingGizmo';
import { glVolumeCollection } from './GLVolume';
import { PaintingVisualProbe } from '@/e2e/PaintingProbe';
declare const __ORCA_E2E__: boolean;

export function Scene({ activeTab, controller, wipeTowerVolumes, glVolumes, toolpath, plateSession, structure = [], onEmptyBedClick }: {
  activeTab: 'prepare' | 'preview';
  controller: SceneInteractionController;
  wipeTowerVolumes?: WipeTowerVolumeCollection;
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  plateSession?: PlateSessionSnapshot | null;
  structure?: readonly ModelObjectStructure[];
  onEmptyBedClick?: (plateId: string) => void;
}) {
  return (
    <SceneInteractionProvider controller={controller}>
      {__ORCA_E2E__ && <PaintingVisualProbe />}
      <SceneContents activeTab={activeTab} controller={controller} wipeTowerVolumes={wipeTowerVolumes} glVolumes={glVolumes} toolpath={toolpath} plateSession={plateSession} structure={structure} onEmptyBedClick={onEmptyBedClick} />
    </SceneInteractionProvider>
  );
}

function SceneContents({ activeTab, controller, wipeTowerVolumes, glVolumes, toolpath, plateSession, structure = [], onEmptyBedClick }: {
  activeTab: 'prepare' | 'preview';
  controller: SceneInteractionController;
  wipeTowerVolumes?: WipeTowerVolumeCollection;
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  plateSession?: PlateSessionSnapshot | null;
  structure?: readonly ModelObjectStructure[];
  onEmptyBedClick?: (plateId: string) => void;
}) {
  const sceneInteraction = useSceneInteraction();
  const bedModel = useBedModel();
  const bedTexture = useBedTexture();
  const painting = usePaintingState();
  const paintingActive = activeTab === 'prepare' && painting != null && painting.phase !== 'closed';
  const previouslyPainting = useRef(false);
  const previewVolumes = useMemo(
    () => isPreviewTab(activeTab) ? previewVolumesForCurrentPlate(glVolumes, plateSession, structure) : glVolumes,
    [activeTab, glVolumes, plateSession, structure],
  );
  const previousActiveTabRef = useRef<'prepare' | 'preview' | null>(null);
  useEffect(() => {
    if (hasEnteredPreview(previousActiveTabRef.current, activeTab)) {
      // Preview retains the shared selection for sidebar use, but never an
      // armed viewport gizmo. Prepare will render that selection again.
      sceneInteraction.closeGizmo();
    }
    previousActiveTabRef.current = activeTab;
  }, [activeTab, sceneInteraction]);
  // A loader replacement is a new scene even if it reuses the prior model's
  // composite IDs. Clear interaction state before accepting selection input
  // for the new collection; otherwise a selection can land between this
  // effect and the reset and be cleared immediately afterwards.
  useEffect(() => {
    // A Prime Tower move can republish model meshes while its native commit
    // is still in flight. The tower keeps its stable selection ID across that
    // receipt; prune against the current collection instead of clearing it.
    if (paintingActive || previouslyPainting.current || wipeTowerVolumes?.busy) sceneInteraction.pruneSelection();
    else sceneInteraction.resetForModel();
    // Canvas and the DOM owner use separate React roots. The closed phase can
    // arrive before Canvas receives the committed collection. Keep the handoff
    // marker until this root observes that exact replacement, not just one render.
    if (paintingActive) previouslyPainting.current = true;
    else if (glVolumes.length === glVolumeCollection.volumes.length && glVolumes.every((v, i) => v === glVolumeCollection.volumes[i])) previouslyPainting.current = false;
  }, [glVolumes, sceneInteraction, wipeTowerVolumes, paintingActive]);

  const PaintingGizmo = painting?.channel === 'support' ? SupportPaintingGizmo : painting?.channel === 'seam' ? SeamPaintingGizmo : painting?.channel === 'fuzzy' ? FuzzyPaintingGizmo : MmuPaintingGizmo;
  if (paintingActive) return <PaintingGizmo volumes={glVolumes} openingVisual={<>
    {plateSession?.plates?.length ? plateSession.plates.map((plate) => <BedPlate bedModel={bedModel} bedTexture={bedTexture} key={plate.plateId} plate={plate} current={plate.plateId === plateSession.currentPlateId} />) : <BedPlate bedModel={bedModel} bedTexture={bedTexture} />}
    <SceneContentTree glVolumes={glVolumes} toolpath={null} interactive={false} structure={structure} plateSession={plateSession}
      controller={controller} wipeTowerVolumes={wipeTowerVolumes} selectionRevision={controller.selection.revision} bodyDragEnabled={false} />
  </>} />;

  return (
    <>
      {__ORCA_E2E__ && <SceneE2eProbe activeTab={activeTab} sceneInteraction={sceneInteraction} glVolumes={glVolumes}
        previewVolumes={previewVolumes} plateSession={plateSession} toolpath={toolpath} />}
      <ambientLight intensity={0.6} />
      {/* height along Z — scene is Z-up slicer convention */}
      <directionalLight position={[100, 150, 200]} intensity={1.2} />
      {!isPreviewTab(activeTab) && plateSession?.plates?.length
        ? plateSession.plates.map((plate) => (
          <BedPlate bedModel={bedModel} bedTexture={bedTexture}
            key={plate.plateId}
            plate={plate}
            current={plate.plateId === plateSession.currentPlateId}
            onEmptyBedClick={onEmptyBedClick}
          />
        ))
        : isPreviewTab(activeTab) && currentPreviewPlate(plateSession)
          ? <BedPlate bedModel={bedModel} bedTexture={bedTexture} plate={currentPreviewPlate(plateSession)!} current />
          : <BedPlate bedModel={bedModel} bedTexture={bedTexture} />}
      {isPreviewTab(activeTab) ? (
        <PreviewScene
          controller={controller}
          wipeTowerVolumes={wipeTowerVolumes}
          glVolumes={previewVolumes}
          toolpath={toolpath}
          structure={structure}
          plateSession={plateSession}
        />
      ) : (
        <PrepareScene glVolumes={glVolumes} toolpath={toolpath} structure={structure} plateSession={plateSession} controller={controller} wipeTowerVolumes={wipeTowerVolumes} />
      )}
    </>
  );
}

/**
 * Explicit content-tree seams for the two Workspace modes. The trees share
 * the persistent Canvas, camera, controller, loaded volumes and toolpath;
 * mode-specific rendering/interaction policy is intentionally layered here
 * by the later Preview implementation step.
 */
function PrepareScene({ glVolumes, toolpath, structure, plateSession, controller, wipeTowerVolumes }: {
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  structure: readonly ModelObjectStructure[];
  plateSession?: PlateSessionSnapshot | null;
  controller: SceneInteractionController;
  wipeTowerVolumes?: WipeTowerVolumeCollection;
}) {
  const subscribeSelection = useCallback((listener: () => void) => controller.selection.subscribe(listener), [controller]);
  const subscribeScene = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const selectionRevision = useSyncExternalStore(subscribeSelection, () => controller.selection.revision);
  const bodyDragEnabled = useSyncExternalStore(subscribeScene, () => controller.bodyDragEnabled);
  return <SceneContentTree glVolumes={glVolumes} toolpath={null} interactive structure={structure} plateSession={plateSession}
    controller={controller} wipeTowerVolumes={wipeTowerVolumes} selectionRevision={selectionRevision} bodyDragEnabled={bodyDragEnabled} />;
}

function PreviewScene({ glVolumes, toolpath, structure, plateSession, controller, wipeTowerVolumes }: {
  controller: SceneInteractionController;
  wipeTowerVolumes?: WipeTowerVolumeCollection;
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  structure?: readonly ModelObjectStructure[];
  plateSession?: PlateSessionSnapshot | null;
}) {
  return <SceneContentTree glVolumes={glVolumes} toolpath={toolpath} interactive={false} preview structure={structure} plateSession={plateSession}
    controller={controller} wipeTowerVolumes={wipeTowerVolumes} selectionRevision={0} bodyDragEnabled={false} />;
}

function SceneContentTree({ glVolumes, toolpath, interactive, preview = false, structure = [], plateSession, controller, wipeTowerVolumes, selectionRevision, bodyDragEnabled }: {
  glVolumes: LoadedObject[];
  toolpath: ToolpathGeometry | null;
  interactive: boolean;
  preview?: boolean;
  structure?: readonly ModelObjectStructure[];
  plateSession?: PlateSessionSnapshot | null;
  controller: SceneInteractionController;
  wipeTowerVolumes?: WipeTowerVolumeCollection;
  selectionRevision: number;
  bodyDragEnabled: boolean;
}) {
  return (
    <>
      {!preview && wipeTowerVolumes && <WipeTowerVolumes collection={wipeTowerVolumes} interactive={interactive}
        selectionRevision={selectionRevision} bodyDragEnabled={bodyDragEnabled} />}
      {glVolumes.map((volume) => (
        <GLVolumeMesh key={volume.id} data={volume} interactive={interactive} preview={preview} structure={structure} plateSession={plateSession}
          selectionRevision={selectionRevision} bodyDragEnabled={bodyDragEnabled} />
      ))}
      {interactive && <SelectionBoundsBox />}
      {interactive && <SelectionTransformGizmo />}
      {/* The slicing bridge publishes world-space preview moves. The separate
          source G-code remains printer-local for export/send, so this render
          group deliberately has no plate translation. */}
      {toolpath && preview && <group name="preview-toolpath-world"><ToolpathLines data={toolpath} /><ToolpathMarker data={toolpath} /></group>}
      {toolpath && !preview && <ToolpathLines data={toolpath} />}
      {toolpath && !preview && <ToolpathMarker data={toolpath} />}
    </>
  );
}

function SelectionTransformGizmo() {
  const sceneInteraction = useSceneInteraction();
  useSceneInteractionVersion();
  const invalidate = useThree((s) => s.invalidate);
  const pivotRef = useRef<THREE.Group>(null);
  const [target, setTarget] = useState<THREE.Group | null>(null);
  const attachPivot = useCallback((group: THREE.Group | null) => {
    pivotRef.current = group;
    setTarget((current) => current === group ? current : group);
  }, []);
  const syncPivot = useCallback(() => {
    const pivot = sceneInteraction.selectionPivot();
    const group = pivotRef.current;
    if (!group || !pivot) return;
    group.position.copy(pivot);
    // Between gestures the pivot is a clean starting state: identity
    // orientation/scale, except the scale gizmo's local mode, which aligns
    // the handles to the single selected instance's axes. During an active
    // gesture TransformControls owns quaternion/scale — only position is
    // synced so the drag delta stays relative to its captured start.
    if (sceneInteraction.owner === 'none') {
      group.rotation.set(0, 0, 0);
      group.scale.set(1, 1, 1);
      if (sceneInteraction.gizmo === 'scale' && sceneInteraction.scaleSpace === 'local') {
        const orientation = sceneInteraction.selectionOrientation();
        if (orientation) group.quaternion.copy(orientation);
      }
    }
    // TransformControls reads its attached target during pointer processing;
    // make the pivot matrix current before the next drag event, not after a
    // React layout pass.
    group.updateMatrix();
    invalidate();
  }, [invalidate, sceneInteraction]);

  useLayoutEffect(() => {
    sceneInteraction.attachPivot(pivotRef.current);
    syncPivot();
    const unsubscribe = sceneInteraction.subscribe(syncPivot);
    return () => {
      unsubscribe();
      sceneInteraction.attachPivot(null);
    };
  }, [sceneInteraction, syncPivot]);

  const mode: TransformGizmoMode | null =
    sceneInteraction.gizmo === 'move' ? 'translate'
      : sceneInteraction.gizmo === 'rotate' ? 'rotate'
        : sceneInteraction.gizmo === 'scale' ? 'scale' : null;

  return (
    <>
      {__ORCA_E2E__ && <GizmoPivotProbe pivotRef={pivotRef} />}
      <group ref={attachPivot} />
      {target && mode && <TransformGizmo target={target} mode={mode} />}
    </>
  );
}
