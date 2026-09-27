import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { WipeTowerVolumeCollection } from '../components/workspace/viewport/WipeTowerVolume';
import { useSceneInteraction } from '../components/workspace/viewport/SceneInteractionContext';
import { registerOrcaE2eOwner } from './registerOrcaE2e';

export function WipeTowerVolumeProbe({ collection }: { collection: WipeTowerVolumeCollection }) {
  const sceneInteraction = useSceneInteraction();
  const scene = useThree((state) => state.scene);

  useEffect(() => registerOrcaE2eOwner('wipe-tower-volumes', {
    primeTowerStates: () => collection.volumes.map((volume) => {
      const bounds = volume.getWorldBounds();
      const center = bounds.getCenter(new THREE.Vector3());
      const renderedObjects: THREE.Object3D[] = [];
      scene.traverse((object) => { if (object.userData.orcaVolume === volume) renderedObjects.push(object); });
      const renderedPosition = renderedObjects[0]?.getWorldPosition(new THREE.Vector3());
      return {
        plateId: volume.plateId,
        displayIndex: volume.projection.displayIndex,
        current: volume.plateId === collection.projection?.currentPlateId,
        eligible: true,
        empty: volume.projection.empty,
        selected: sceneInteraction.selectedWipeTower()?.plateId === volume.plateId,
        position: volume.position,
        renderedWorldPosition: renderedPosition?.toArray() ?? null,
        width: volume.projection.width,
        depth: volume.projection.depth,
        height: volume.projection.height,
        worldBounds: { min: bounds.min.toArray(), max: bounds.max.toArray(), center: center.toArray() },
        bands: volume.projection.bands.length,
        colours: volume.projection.bands.map((band) => band.colour),
        opacity: volume.projection.bands.map((band) => band.opacity),
        footprint: { ...volume.projection.footprint },
        buildArea: { ...volume.projection.buildArea },
        outsideBoundaryWarning: volume.projection.outsideBoundaryWarning === true,
      };
    }),
    primeTowerSelection: () => sceneInteraction.selectedWipeTower()?.plateId ?? null,
    primeTowerMoveCommands: () => collection.moveCommandCount,
    primeTowerCommitBusy: () => collection.busy,
    primeTowerProxyIds: () => {
      const ids = new Set<string>();
      scene.traverse((object) => {
        if (object.userData.primeTower === true && typeof object.userData.plateId === 'string') {
          ids.add(object.userData.plateId);
        }
      });
      return [...ids].sort();
    },
  }), [collection, scene, sceneInteraction]);

  return null;
}
