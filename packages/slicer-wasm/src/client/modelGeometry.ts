import type {
  ModelGeometry, ModelPaintDrawGroup, ModelPaintGeometry, ModelRenderable, ModelTransform, OrcaModule,
} from './types';

type NativeRenderable = Record<string, unknown>;
type NativeGeometry = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error(`invalid ${label}`);
  return value;
}

function collectPointers(value: unknown, allocations: Set<number>, heapLength: number): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    for (const field of ['vertex_ptr', 'index_ptr']) {
      const candidate = entry[field];
      if (typeof candidate !== 'number' && typeof candidate !== 'bigint' && typeof candidate !== 'string') continue;
      const address = Number(candidate);
      // Invalid addresses cannot name a live allocation in this WASM heap.
      // Retain every plausible pointer before validating any geometry entry.
      if (Number.isSafeInteger(address) && address > 0 && address < heapLength) allocations.add(address);
    }
  }
}

function copyBuffer(module: OrcaModule, pointer: unknown, elementCount: number): ArrayBuffer {
  const address = safeInteger(pointer, 'model geometry pointer');
  if (!Number.isSafeInteger(elementCount) || elementCount < 0 || !Number.isSafeInteger(elementCount * 4))
    throw new Error('invalid model geometry buffer');
  const byteLength = elementCount * 4;
  if ((byteLength > 0 && (address === 0 || address % 4 !== 0)) ||
      address + byteLength > module.HEAPU8.length)
    throw new Error('invalid model geometry buffer');
  return module.HEAPU8.slice(address, address + byteLength).buffer;
}

function decodeDrawGroups(value: unknown, indexCount: number): ModelPaintDrawGroup[] {
  if (!Array.isArray(value)) throw new Error('invalid model paint draw groups');
  const states = new Set<number>();
  let nextIndex = 0;
  const groups = value.map((group): ModelPaintDrawGroup => {
    if (!isRecord(group)) throw new Error('invalid model paint draw group');
    const stateId = safeInteger(group.state_id, 'model paint state');
    const startIndex = safeInteger(group.start_index, 'model paint group start');
    const count = safeInteger(group.index_count, 'model paint group count', 1);
    if (states.has(stateId) || startIndex !== nextIndex || count % 3 !== 0 ||
        startIndex > indexCount || count > indexCount - startIndex)
      throw new Error('invalid model paint draw group range');
    states.add(stateId);
    nextIndex += count;
    return { stateId, startIndex, indexCount: count };
  });
  if (nextIndex !== indexCount || !groups.some((group) => group.stateId > 0))
    throw new Error('invalid model paint draw group coverage');
  return groups;
}

function decodeTransform(value: unknown, label: string): ModelTransform {
  if (!isRecord(value)) throw new Error(`invalid model ${label}`);
  const vectorKeys = ['offset', 'rotation', 'scale', 'mirror'] as const;
  for (const key of vectorKeys) {
    const vector = value[key];
    if (!Array.isArray(vector) || vector.length !== 3 ||
        !vector.every((component) => typeof component === 'number' && Number.isFinite(component)))
      throw new Error(`invalid model ${label}`);
  }
  if (value.matrix !== undefined && (!Array.isArray(value.matrix) || value.matrix.length !== 16 ||
      !value.matrix.every((component) => typeof component === 'number' && Number.isFinite(component))))
    throw new Error(`invalid model ${label}`);
  return value as unknown as ModelTransform;
}

/** Own every allocation in a reply, including those following a malformed entry. */
export function decodeModelGeometry(
  module: OrcaModule,
  raw: unknown,
  session: string,
  retainedGeometryKeys: readonly string[] = [],
  retainedPaintGeometryKeys: readonly string[] = [],
): {
  meshes: ModelRenderable[];
  geometries: ModelGeometry[];
  paintGeometries: ModelPaintGeometry[];
} {
  const allocations = new Set<number>();
  let decoded: ReturnType<typeof decodeModelGeometry> | undefined;
  let decodeError: unknown;
  try {
    if (!isRecord(raw)) throw new Error('invalid model geometry reply');
    // Collect both resource families first so a later validation failure still
    // frees buffers listed after the malformed record.
    collectPointers(raw.geometries, allocations, module.HEAPU8.length);
    collectPointers(raw.paint_geometries, allocations, module.HEAPU8.length);

    if (raw.ok !== true || !Array.isArray(raw.renderables) || !Array.isArray(raw.geometries) ||
        !Array.isArray(raw.paint_geometries))
      throw new Error(typeof raw.error === 'string' ? raw.error : 'invalid model geometry reply');
    const originalByVolume = new Map<number, ModelGeometry>();
    const geometries = raw.geometries.map((entry): ModelGeometry => {
      if (!isRecord(entry)) throw new Error('invalid model geometry record');
      const volumeId = safeInteger(entry.volume_id, 'model geometry identity', 1);
      if (originalByVolume.has(volumeId)) throw new Error('invalid or duplicate model geometry identity');
      const vertexCount = safeInteger(entry.vertex_count, 'model geometry vertex count');
      const indexCount = safeInteger(entry.index_count, 'model geometry index count');
      if (vertexCount === 0 || indexCount === 0 || indexCount % 3 !== 0 ||
          !Number.isSafeInteger(vertexCount * 3))
        throw new Error('invalid model geometry counts');
      const positions = new Float32Array(copyBuffer(module, entry.vertex_ptr, vertexCount * 3));
      const indices = new Uint32Array(copyBuffer(module, entry.index_ptr, indexCount));
      if (indices.some((index) => index >= vertexCount)) throw new Error('invalid model geometry index');
      const geometry: ModelGeometry = {
        geometryKey: `${session}:${volumeId}`, volumeId, positions, indices, vertexCount, indexCount,
      };
      originalByVolume.set(volumeId, geometry);
      return geometry;
    });

    const nativePaint = raw.paint_geometries;
    const paintByKey = new Map<string, ModelPaintGeometry>();
    const paintGeometries = nativePaint.map((entry): ModelPaintGeometry => {
      if (!isRecord(entry) || typeof entry.paint_key !== 'string' || entry.paint_key.length === 0)
        throw new Error('invalid model paint geometry identity');
      const volumeId = safeInteger(entry.volume_id, 'model paint geometry volume identity', 1);
      const paintGeometryKey = `${session}:paint:${entry.paint_key}`;
      if (paintByKey.has(paintGeometryKey)) throw new Error('duplicate model paint geometry identity');
      const vertexCount = safeInteger(entry.vertex_count, 'model paint vertex count');
      const indexCount = safeInteger(entry.index_count, 'model paint index count');
      if (vertexCount === 0 || indexCount === 0 || indexCount % 3 !== 0 ||
          !Number.isSafeInteger(vertexCount * 3))
        throw new Error('invalid model paint geometry counts');
      const positions = new Float32Array(copyBuffer(module, entry.vertex_ptr, vertexCount * 3));
      const indices = new Uint32Array(copyBuffer(module, entry.index_ptr, indexCount));
      if (indices.some((index) => index >= vertexCount)) throw new Error('invalid model paint geometry index');
      const drawGroups = decodeDrawGroups(entry.draw_groups, indexCount);
      const geometry: ModelPaintGeometry = {
        paintGeometryKey, volumeId, positions, indices, vertexCount, indexCount, drawGroups,
      };
      paintByKey.set(paintGeometryKey, geometry);
      return geometry;
    });

    const knownOriginal = new Set(retainedGeometryKeys);
    const knownPaint = new Set(retainedPaintGeometryKeys);
    const referencedPaint = new Set<string>();
    const meshes = raw.renderables.map((entry): ModelRenderable => {
      if (!isRecord(entry)) throw new Error('invalid model renderable');
      const objectId = safeInteger(entry.object_id, 'model renderable object identity', 1);
      const volumeId = safeInteger(entry.volume_id, 'model renderable volume identity', 1);
      const instanceId = safeInteger(entry.instance_id, 'model renderable instance identity', 1);
      const objectIdx = safeInteger(entry.object_idx, 'model renderable object index');
      const volumeIdx = safeInteger(entry.volume_idx, 'model renderable volume index');
      const instanceIdx = safeInteger(entry.instance_idx, 'model renderable instance index');
      const offset = entry.offset;
      if (!Array.isArray(offset) || offset.length !== 3 ||
          !offset.every((component) => typeof component === 'number' && Number.isFinite(component)))
        throw new Error('invalid model renderable offset');
      const geometryKey = `${session}:${volumeId}`;
      if (!originalByVolume.has(volumeId) && !knownOriginal.has(geometryKey))
        throw new Error(`missing model geometry reference ${geometryKey}`);

      let paintGeometryKey: string | null = null;
      const nativePaintKey = entry.paint_key;
      if (nativePaintKey === undefined) throw new Error('missing model paint reference');
      if (nativePaintKey !== null) {
        if (typeof nativePaintKey !== 'string' || nativePaintKey.length === 0)
          throw new Error('invalid model paint reference');
        paintGeometryKey = `${session}:paint:${nativePaintKey}`;
        const returnedPaint = paintByKey.get(paintGeometryKey);
        if ((!returnedPaint && !knownPaint.has(paintGeometryKey)) ||
            (returnedPaint && returnedPaint.volumeId !== volumeId))
          throw new Error(`missing model paint geometry reference ${paintGeometryKey}`);
        referencedPaint.add(paintGeometryKey);
      }
      return {
        geometryKey, paintGeometryKey,
        objectId, volumeId, instanceId, objectIdx, volumeIdx, instanceIdx,
        offset: offset as [number, number, number],
        instanceTransform: decodeTransform(entry.instance_transform, 'instance transform'),
        volumeTransform: decodeTransform(entry.volume_transform, 'volume transform'),
      };
    });
    for (const key of paintByKey.keys())
      if (!referencedPaint.has(key)) throw new Error(`unreferenced model paint geometry ${key}`);

    decoded = { meshes, geometries, paintGeometries };
  } catch (error) {
    decodeError = error;
  }

  const freeErrors: unknown[] = [];
  for (const pointer of allocations) {
    try { module._free(pointer); }
    catch (error) { freeErrors.push(error); }
  }
  if (decodeError !== undefined) throw decodeError;
  if (freeErrors.length > 0) throw freeErrors[0];
  return decoded!;
}
