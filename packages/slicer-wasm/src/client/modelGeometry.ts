import type { ModelGeometry, ModelRenderable, ModelTransform, OrcaModule } from './types';

type NativeGeometry = {
  volume_id: number; vertex_ptr: number; vertex_count: number;
  index_ptr: number; index_count: number;
};
type NativeRenderable = {
  object_id: number; volume_id: number; instance_id: number;
  object_idx: number; volume_idx: number; instance_idx: number;
  offset: [number, number, number];
  instance_transform: ModelTransform; volume_transform: ModelTransform;
};

/** Own every allocation in a reply, including those following a malformed entry. */
export function decodeModelGeometry(module: OrcaModule, raw: unknown, session: string): {
  meshes: ModelRenderable[]; geometries: ModelGeometry[];
} {
  const value = raw as { ok?: boolean; error?: string; renderables?: NativeRenderable[]; geometries?: NativeGeometry[] };
  const allocations = new Set<number>();
  for (const entry of Array.isArray(value?.geometries) ? value.geometries : []) {
    for (const pointer of [entry.vertex_ptr, entry.index_ptr])
      if (Number.isSafeInteger(Number(pointer)) && Number(pointer) > 0) allocations.add(Number(pointer));
  }
  try {
    if (!value?.ok || !Array.isArray(value.renderables) || !Array.isArray(value.geometries))
      throw new Error(value?.error ?? 'invalid model geometry reply');
    const ids = new Set<number>();
    const copy = (pointer: number, count: number) => {
      const address = Number(pointer);
      const length = count * 4;
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(address) || address < 0 ||
          (length > 0 && address === 0) || address + length > module.HEAPU8.length)
        throw new Error('invalid model geometry buffer');
      return module.HEAPU8.slice(address, address + length).buffer;
    };
    const geometries = value.geometries.map((entry): ModelGeometry => {
      if (!Number.isSafeInteger(entry.volume_id) || entry.volume_id <= 0 || ids.has(entry.volume_id))
        throw new Error('invalid or duplicate model geometry identity');
      ids.add(entry.volume_id);
      return {
        geometryKey: `${session}:${entry.volume_id}`, volumeId: entry.volume_id,
        positions: new Float32Array(copy(entry.vertex_ptr, entry.vertex_count * 3)),
        indices: new Uint32Array(copy(entry.index_ptr, entry.index_count)),
        vertexCount: entry.vertex_count, indexCount: entry.index_count,
      };
    });
    const meshes = value.renderables.map((entry): ModelRenderable => {
      if (![entry.object_id, entry.volume_id, entry.instance_id].every((id) => Number.isSafeInteger(id) && id > 0))
        throw new Error('invalid model renderable identity');
      return {
        geometryKey: `${session}:${entry.volume_id}`,
        objectId: entry.object_id, volumeId: entry.volume_id, instanceId: entry.instance_id,
        objectIdx: entry.object_idx, volumeIdx: entry.volume_idx, instanceIdx: entry.instance_idx,
        offset: entry.offset, instanceTransform: entry.instance_transform, volumeTransform: entry.volume_transform,
      };
    });
    return { meshes, geometries };
  } finally {
    for (const pointer of allocations) module._free(pointer);
  }
}
