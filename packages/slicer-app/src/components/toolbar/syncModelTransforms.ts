import type { SlicerClient } from '@slicer/client';
import type { GLVolume } from '../workspace/viewport/GLVolume';

type TransformableVolume = Pick<GLVolume, 'instanceTransform' | 'volumeTransform'> & {
  buffer: Pick<GLVolume['buffer'], 'objectIdx' | 'volumeIdx' | 'instanceIdx'>;
};

/** Synchronize a stable snapshot of every rendered CompositeID. */
export async function syncModelTransforms(
  client: Pick<SlicerClient, 'setModelTransform'>,
  volumes: readonly TransformableVolume[],
): Promise<{ ok: boolean; error?: string }> {
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
  return { ok: true };
}
