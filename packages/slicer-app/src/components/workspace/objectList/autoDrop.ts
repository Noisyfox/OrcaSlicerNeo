import type { ModelObjectStructure } from '@slicer/client';
import type { SelectionProjection } from './projection';

/** Resolve object-level Auto Drop targets from any selected row granularity. */
export function selectedAutoDropObjects(
  structure: readonly ModelObjectStructure[], projection: SelectionProjection,
): ModelObjectStructure[] {
  return structure.filter((object) => projection.objectIds.has(object.id) ||
    object.instances.some((instance) => projection.instanceIds.has(instance.id)) ||
    object.volumes.some((volume) => projection.volumeIds.has(volume.id)));
}
