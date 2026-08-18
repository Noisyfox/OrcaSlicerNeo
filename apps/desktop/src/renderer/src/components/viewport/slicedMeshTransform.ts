export type InstanceOffset = readonly [number, number, number];

/**
 * Sliced-layer polygons are emitted with their slicer Z already applied.
 * Their missing plate-space component is the instance's XY placement.
 */
export function slicedMeshPosition(offset?: InstanceOffset): [number, number, number] {
  return [offset?.[0] ?? 0, offset?.[1] ?? 0, 0];
}
