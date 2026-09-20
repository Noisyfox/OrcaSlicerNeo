import type { PlateSessionSnapshot } from '@slicer/client';
import type { LoadedObject } from './useModelLoader';

export interface PreviewVolumeIdentity {
  readonly buffer: Pick<LoadedObject['buffer'], 'objectIdx' | 'instanceIdx'>;
}
/** Return the selected plate's world origin for the Preview scene. */
export function currentPreviewPlate(snapshot: PlateSessionSnapshot | null | undefined) {
  if (!snapshot) return null;
  return snapshot.plates.find((plate) => plate.plateId === snapshot.currentPlateId) ?? null;
}
function instanceKey(objectIndex: number, instanceIndex: number): string {
  return `${objectIndex}:${instanceIndex}`;
}

/**
 * Project the editing collection into Preview without changing the shared
 * GLVolume collection or its selection state. Membership is matched by the
 * authoritative object/instance indices in the plate-session snapshot.
 */
export function previewVolumesForCurrentPlate(
  volumes: readonly LoadedObject[],
  snapshot: PlateSessionSnapshot | null | undefined,
): LoadedObject[] {
  if (!snapshot) return [];
  const currentPlateId = snapshot.currentPlateId;
  const members = new Set(
    snapshot.instances
      .filter((instance) => instance.member && instance.plateId === currentPlateId)
      .map((instance) => instanceKey(instance.objectIndex, instance.instanceIndex)),
  );
  return volumes.filter((volume) => members.has(instanceKey(volume.buffer.objectIdx, volume.buffer.instanceIdx)));
}
