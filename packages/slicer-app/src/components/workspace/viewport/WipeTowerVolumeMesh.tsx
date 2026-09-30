import { GLVolumeMesh } from './ModelMesh';
import { WipeTowerVolumeCollection, useWipeTowerVolumeRevision } from './WipeTowerVolume';
import { WipeTowerVolumeProbe } from '../../../e2e/WipeTowerVolumeProbe';

declare const __ORCA_E2E__: boolean;

/** Maps tagged volumes into the ordinary GLVolumeMesh interaction wrapper. */
export function WipeTowerVolumes({ collection, selectionRevision, bodyDragEnabled, interactive }: {
  collection: WipeTowerVolumeCollection;
  selectionRevision: number;
  bodyDragEnabled: boolean;
  interactive: boolean;
}) {
  const dataRevision = useWipeTowerVolumeRevision(collection);
  // Prepare renders every eligible plate tower through the same interactive
  // GLVolumeMesh wrapper.  The volume's plateId remains the immutable target
  // identity while dragging; no current-plate switch is implied.
  return (
    <>
      {collection.volumes.map((volume) => <GLVolumeMesh key={volume.plateId} data={volume} dataRevision={dataRevision} interactive={interactive}
        selectionRevision={selectionRevision} bodyDragEnabled={bodyDragEnabled} />)}
      {__ORCA_E2E__ && <WipeTowerVolumeProbe collection={collection} />}
    </>
  );
}
