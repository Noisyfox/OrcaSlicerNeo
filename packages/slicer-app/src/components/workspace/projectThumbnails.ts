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
  signal: AbortSignal,
  expectedRevision: number,
): Promise<ExportProjectRequest> {
  signal.throwIfAborted();
  const session = await runtime.getPlateSessionSnapshot();
  if ('error' in session) throw new Error(session.error);
  const structure = useObjectListStore.getState().structure;
  if (structure.length) await waitForGLVolumeRevision(useSettingsStore.getState().modelRevision, signal);
  signal.throwIfAborted();
  const renderer = createThumbnailRenderer();
  const thumbnails: ExportProjectRequest['thumbnails'] = [];
  try {
    for (const plate of session.plates) {
      // One GPU target at a time; yield to progress/cancel UI between plates.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      signal.throwIfAborted();
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
