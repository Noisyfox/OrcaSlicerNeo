import type { ExportProjectRequest, SlicerClient } from '@slicer/client';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useFilamentSessionStore } from '../../stores/useFilamentSessionStore';
import { useObjectListStore } from './objectList/useObjectListStore';
import { glVolumeCollection, waitForGLVolumeRevision } from './viewport/GLVolume';
import { projectPlateThumbnail } from './plateThumbnailScene';
import { createThumbnailRenderer } from './plateThumbnailService';

/** Called under the project save lease, after settling any active painting. */
export async function captureProjectThumbnails(
  runtime: Pick<SlicerClient, 'getPlateSessionSnapshot'>,
  expectedRevision: number,
): Promise<ExportProjectRequest> {
  const session = await runtime.getPlateSessionSnapshot();
  if ('error' in session) throw new Error(session.error);
  const structure = useObjectListStore.getState().structure;
  if (structure.length) await waitForGLVolumeRevision(useSettingsStore.getState().modelRevision);
  const renderer = createThumbnailRenderer();
  const thumbnails: ExportProjectRequest['thumbnails'] = [];
  try {
    for (const plate of session.plates) {
      // One GPU target at a time; yield to the progress UI between plates.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const { parts } = projectPlateThumbnail(plate.plateId, glVolumeCollection.volumes,
        structure, session, useFilamentSessionStore.getState().snapshot);
      thumbnails.push({ plateId: plate.plateId, width: 512, height: 512,
        rgba: renderer.renderPixels(parts, 512) });
    }
    return { expectedRevision, thumbnails };
  } finally {
    renderer.dispose();
  }
}
