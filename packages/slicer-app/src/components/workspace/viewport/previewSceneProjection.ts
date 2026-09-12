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
 *
 * A legacy snapshot without membership rows is kept renderable as a
 * compatibility fallback; the native bridge includes rows for all current
 * multi-plate projects.
 */
export function previewVolumesForCurrentPlate(
  volumes: readonly LoadedObject[],
  snapshot: PlateSessionSnapshot | null | undefined,
): LoadedObject[] {
  if (!snapshot?.instances) return [...volumes];
  const currentPlateId = snapshot.currentPlateId;
  const members = new Set(
    snapshot.instances
      .filter((instance) => instance.member && instance.plateId === currentPlateId)
      .map((instance) => instanceKey(instance.objectIndex, instance.instanceIndex)),
  );
  return volumes.filter((volume) => members.has(instanceKey(volume.buffer.objectIdx, volume.buffer.instanceIdx)));
}

/**
 * Slice results already contain world-space coordinates restored at the WASM
 * bridge boundary from the target Print's plate origin. Print emits
 * printer-local G-code by subtracting that origin for export. The Preview
 * scene therefore must not apply a second plate transform to the toolpath.
 */
export function previewToolpathOrigin(_snapshot: PlateSessionSnapshot | null | undefined): readonly [number, number, number] {
  return [0, 0, 0];
}
