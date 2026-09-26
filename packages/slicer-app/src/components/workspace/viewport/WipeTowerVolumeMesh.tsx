import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLVolumeMesh } from './ModelMesh';
import { useSceneInteraction } from './SceneInteractionContext';
import { WipeTowerVolumeCollection, useWipeTowerVolumeRevision } from './WipeTowerVolume';

/** Maps tagged volumes into the ordinary GLVolumeMesh interaction wrapper. */
export function WipeTowerVolumes({ collection, selectionRevision, bodyDragEnabled }: {
  collection: WipeTowerVolumeCollection;
  selectionRevision: number;
  bodyDragEnabled: boolean;
}) {
  const dataRevision = useWipeTowerVolumeRevision(collection);
  const sceneInteraction = useSceneInteraction();
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    const env = import.meta.env as { MODE?: string; VITE_E2E?: string; VITE_USE_MOCK?: string };
    if (env.MODE !== 'e2e' && env.VITE_E2E !== '1' && env.VITE_USE_MOCK !== '1') return;
    const w = window as unknown as { __orcaE2e?: Record<string, unknown> };
    w.__orcaE2e = { ...w.__orcaE2e,
      primeTowerStates: () => collection.volumes.map((volume) => {
        const bounds = volume.getWorldBounds();
        const center = bounds.getCenter(new THREE.Vector3());
        const renderedObjects: THREE.Object3D[] = [];
        scene.traverse((object) => { if (object.userData.orcaVolume === volume) renderedObjects.push(object); });
        const renderedPosition = renderedObjects[0]?.getWorldPosition(new THREE.Vector3());
        return { plateId: volume.plateId, displayIndex: volume.projection.displayIndex, current: volume.plateId === collection.projection?.currentPlateId, eligible: true, empty: volume.projection.empty, selected: sceneInteraction.selectedWipeTower()?.plateId === volume.plateId, position: volume.position, renderedWorldPosition: renderedPosition?.toArray() ?? null, width: volume.projection.width, depth: volume.projection.depth, height: volume.projection.height, worldBounds: { min: bounds.min.toArray(), max: bounds.max.toArray(), center: center.toArray() }, bands: volume.projection.bands.length, colours: volume.projection.bands.map((band) => band.colour), opacity: volume.projection.bands.map((band) => band.opacity), footprint: { ...volume.projection.footprint }, buildArea: { ...volume.projection.buildArea }, outsideBoundaryWarning: volume.projection.outsideBoundaryWarning === true };
      }),
      primeTowerSelection: () => sceneInteraction.selectedWipeTower()?.plateId ?? null,
      primeTowerMoveCommands: () => collection.moveCommandCount,
      primeTowerCommitBusy: () => collection.busy,
      primeTowerProxyIds: () => { const ids = new Set<string>(); scene.traverse((object) => { if (object.userData.primeTower === true && typeof object.userData.plateId === 'string') ids.add(object.userData.plateId); }); return [...ids].sort(); },
    };
    return () => { if (!w.__orcaE2e) return; const { primeTowerStates: _a, primeTowerSelection: _b, primeTowerMoveCommands: _c, primeTowerCommitBusy: _d, primeTowerProxyIds: _e, ...rest } = w.__orcaE2e; w.__orcaE2e = rest; };
  }, [collection, scene, sceneInteraction]);
  // Prepare renders every eligible plate tower through the same interactive
  // GLVolumeMesh wrapper.  The volume's plateId remains the immutable target
  // identity while dragging; no current-plate switch is implied.
  return <>{collection.volumes.map((volume) => <GLVolumeMesh key={volume.plateId} data={volume} dataRevision={dataRevision} interactive
    selectionRevision={selectionRevision} bodyDragEnabled={bodyDragEnabled} />)}</>;
}
