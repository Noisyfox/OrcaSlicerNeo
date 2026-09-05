import type { PlateSessionMutation, SlicerClient } from '@slicer/client';
import type { GLVolume } from '../viewport/GLVolume';

type TransformableVolume = Pick<GLVolume, 'instanceTransform' | 'volumeTransform'> & {
  buffer: Pick<GLVolume['buffer'], 'objectIdx' | 'volumeIdx' | 'instanceIdx'>;
};

/** Synchronize a stable snapshot of every rendered CompositeID. */
export async function syncModelTransforms(
  client: Pick<SlicerClient, 'setModelTransform'> & Partial<Pick<SlicerClient, 'recomputePlateMembership'>>,
  volumes: readonly TransformableVolume[],
): Promise<{ ok: boolean; error?: string; plateSession?: PlateSessionMutation }> {
  const snapshot = volumes.map((volume) => ({
    objectIdx: volume.buffer.objectIdx,
    volumeIdx: volume.buffer.volumeIdx,
    instanceIdx: volume.buffer.instanceIdx,
    instanceTransform: structuredClone(volume.instanceTransform),
    volumeTransform: structuredClone(volume.volumeTransform),
  }));
  for (const volume of snapshot) {
    const result = await client.setModelTransform(
      volume.objectIdx,
      volume.volumeIdx,
      volume.instanceIdx,
      volume.instanceTransform,
      volume.volumeTransform,
    );
    if (!result.ok) return result;
  }
  if (client.recomputePlateMembership) {
    const result = await client.recomputePlateMembership();
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, plateSession: result };
  }
  return { ok: true };
}

/** Apply authoritative world transforms returned by a plate mutation.
 * Membership is global, so updates are matched by the stable positional
 * identity in the bridge response and never filtered to the current selection.
 */
export function applyPlateSessionTransforms(
  mutation: Pick<PlateSessionMutation, 'instanceTransforms'> | undefined,
  volumes: readonly TransformableVolume[],
): void {
  for (const changed of mutation?.instanceTransforms ?? []) {
    for (const volume of volumes) {
      if (volume.buffer.objectIdx === changed.objectIndex &&
          volume.buffer.instanceIdx === changed.instanceIndex) {
        volume.instanceTransform = structuredClone(changed.worldTransform);
      }
    }
  }
}
