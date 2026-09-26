import type { ModelMeshResult, ModelPaintGeometry } from '@slicer/client';
import { GLVolume } from './GLVolume';

/** Build the complete full-load projection before the caller publishes it. */
export function projectFullModelMesh(result: ModelMeshResult): GLVolume[] {
  if (!result.ok) throw new Error(result.error ?? 'model mesh load failed');

  const paintResources = new Map<string, ModelPaintGeometry>();
  for (const paint of result.paintGeometries ?? []) {
    if (!paint.paintGeometryKey || paintResources.has(paint.paintGeometryKey))
      throw new Error(`duplicate or invalid model paint geometry ${paint.paintGeometryKey}`);
    paintResources.set(paint.paintGeometryKey, paint);
  }

  const originalVolumeByKey = new Map<string, number>();
  const resolved = result.objects.map((object) => {
    if (!object.geometryKey) throw new Error('model mesh is missing its original geometry key');
    const originalVolumeId = originalVolumeByKey.get(object.geometryKey);
    if (originalVolumeId !== undefined && originalVolumeId !== object.volumeId)
      throw new Error(`model geometry ${object.geometryKey} belongs to another volume`);
    originalVolumeByKey.set(object.geometryKey, object.volumeId);

    if (object.paintGeometryKey === null) return { object, paint: undefined };
    if (!object.paintGeometryKey)
      throw new Error(`invalid model paint geometry reference for volume ${object.volumeId}`);
    const paint = paintResources.get(object.paintGeometryKey);
    if (!paint) throw new Error(`missing model paint geometry ${object.paintGeometryKey}`);
    if (paint.volumeId !== object.volumeId)
      throw new Error(`model paint geometry ${object.paintGeometryKey} belongs to another volume`);
    return { object, paint };
  });

  const created: GLVolume[] = [];
  try {
    for (const { object, paint } of resolved) {
      const volume = new GLVolume(object, { kind: 'shared', key: object.geometryKey },
        paint ? { key: object.paintGeometryKey!, buffer: paint } : undefined);
      created.push(volume);
    }
    return created;
  } catch (error) {
    created.forEach((volume) => volume.dispose());
    throw error;
  }
}
