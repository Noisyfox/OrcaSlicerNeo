import type { SlicerClient } from '@slicer/client';
import type { GLVolume } from '../viewport/GLVolume';

type TransformableVolume = Pick<GLVolume, 'instanceTransform' | 'volumeTransform'> & {
  buffer: Pick<GLVolume['buffer'], 'objectIdx' | 'volumeIdx' | 'instanceIdx'>;
};

/** Synchronize every rendered CompositeID at the sole pre-slice boundary. */
export async function syncModelTransforms(
  client: Pick<SlicerClient, 'setModelTransform'>,
  volumes: readonly TransformableVolume[],
): Promise<{ ok: boolean; error?: string }> {
  for (const volume of volumes) {
    const result = await client.setModelTransform(
      volume.buffer.objectIdx,
      volume.buffer.volumeIdx,
      volume.buffer.instanceIdx,
      volume.instanceTransform,
      volume.volumeTransform,
    );
    if (!result.ok) return result;
  }
  return { ok: true };
}
