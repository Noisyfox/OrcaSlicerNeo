import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { GLVolumeMesh } from './ModelMesh';
import { useSceneInteraction } from './SceneInteractionContext';
import { WipeTowerVolumeCollection, useWipeTowerVolumeVersion } from './WipeTowerVolume';

/** Maps tagged volumes into the ordinary GLVolumeMesh interaction wrapper. */
export function WipeTowerVolumes({ collection }: { collection: WipeTowerVolumeCollection }) {
  useWipeTowerVolumeVersion(collection);
  const sceneInteraction = useSceneInteraction();
  const scene = useThree((state) => state.scene);
  const currentPlateId = collection.projection?.currentPlateId;
  useEffect(() => {
    const env = import.meta.env as { MODE?: string; VITE_E2E?: string; VITE_USE_MOCK?: string };
    if (env.MODE !== 'e2e' && env.VITE_E2E !== '1' && env.VITE_USE_MOCK !== '1') return;
    const w = window as unknown as { __orcaE2e?: Record<string, unknown> };
    w.__orcaE2e = { ...w.__orcaE2e,
      primeTowerStates: () => collection.volumes.map((volume) => ({ plateId: volume.plateId, current: volume.plateId === currentPlateId, eligible: true, empty: volume.projection.empty, selected: sceneInteraction.selectedWipeTower()?.plateId === volume.plateId, position: volume.position, bands: volume.projection.bands.length, colours: volume.projection.bands.map((band) => band.colour), opacity: volume.projection.bands.map((band) => band.opacity), footprint: { ...volume.projection.footprint }, buildArea: { ...volume.projection.buildArea }, outsideBoundaryWarning: volume.projection.outsideBoundaryWarning === true })),
      primeTowerSelection: () => sceneInteraction.selectedWipeTower()?.plateId ?? null,
      primeTowerMoveCommands: () => collection.moveCommandCount,
      primeTowerProxyIds: () => { const ids = new Set<string>(); scene.traverse((object) => { if (object.userData.primeTower === true && typeof object.userData.plateId === 'string') ids.add(object.userData.plateId); }); return [...ids].sort(); },
    };
    return () => { if (!w.__orcaE2e) return; const { primeTowerStates: _a, primeTowerSelection: _b, primeTowerMoveCommands: _c, primeTowerProxyIds: _d, ...rest } = w.__orcaE2e; w.__orcaE2e = rest; };
  }, [collection, currentPlateId, scene, sceneInteraction]);
  return <>{collection.volumes.map((volume) => <GLVolumeMesh key={volume.plateId} data={volume} interactive={volume.plateId === currentPlateId} />)}</>;
}
