import { describe, expect, it, vi } from 'vitest';
import { decodeModelGeometry } from './modelGeometry';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';
import type { OrcaModule } from './types';

const transform = { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] };

function renderable(instanceId: number, paintKey?: string | null) {
  return {
    object_id: 21, volume_id: 41, instance_id: instanceId,
    object_idx: 0, volume_idx: 0, instance_idx: instanceId - 22,
    offset: [0, 0, 0], instance_transform: transform, volume_transform: transform,
    ...(paintKey === undefined ? {} : { paint_key: paintKey }),
  };
}

function writeArray(heap: Uint8Array, pointer: number, values: number[], kind: 'float' | 'uint') {
  if (kind === 'float') new Float32Array(heap.buffer, pointer, values.length).set(values);
  else new Uint32Array(heap.buffer, pointer, values.length).set(values);
}

describe('native geometry resource transport', () => {
  it('copies split MMU facets into grouped paint geometry shared by model instances', () => {
    const free = vi.fn();
    const heap = new Uint8Array(256);
    writeArray(heap, 16, [0, 0, 0, 1, 0, 0, 0, 1, 0], 'float');
    writeArray(heap, 64, [0, 1, 2], 'uint');
    writeArray(heap, 80, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5, 0.5, 0], 'float');
    writeArray(heap, 144, [0, 1, 3, 0, 3, 2], 'uint');
    const module = { HEAPU8: heap, _free: free } as unknown as OrcaModule;
    const decoded = decodeModelGeometry(module, {
      ok: true,
      renderables: [renderable(22, '41:abc123'), renderable(23, '41:abc123')],
      geometries: [{ volume_id: 41, vertex_ptr: 16, vertex_count: 3, index_ptr: 64, index_count: 3 }],
      paint_geometries: [{ paint_key: '41:abc123', volume_id: 41,
        vertex_ptr: 80, vertex_count: 4, index_ptr: 144, index_count: 6,
        draw_groups: [
          { state_id: 0, start_index: 0, index_count: 3 },
          { state_id: 2, start_index: 3, index_count: 3 },
        ] }],
    }, 'session');

    expect(decoded.meshes.map((mesh) => mesh.geometryKey)).toEqual(['session:41', 'session:41']);
    expect(decoded.meshes.map((mesh) => mesh.paintGeometryKey)).toEqual([
      'session:paint:41:abc123', 'session:paint:41:abc123',
    ]);
    expect(decoded.paintGeometries).toHaveLength(1);
    expect([...decoded.paintGeometries[0].indices]).toEqual([0, 1, 3, 0, 3, 2]);
    expect(decoded.paintGeometries[0].drawGroups).toEqual([
      { stateId: 0, startIndex: 0, indexCount: 3 },
      { stateId: 2, startIndex: 3, indexCount: 3 },
    ]);
    expect(free.mock.calls.map(([pointer]) => pointer)).toEqual([16, 64, 80, 144]);
    expect([...decoded.paintGeometries[0].positions]).toHaveLength(12);
  });

  it('accepts legacy unpainted replies and makes the absence explicit', () => {
    const free = vi.fn();
    const heap = new Uint8Array(128);
    writeArray(heap, 16, [0, 0, 0, 1, 0, 0, 0, 1, 0], 'float');
    writeArray(heap, 64, [0, 1, 2], 'uint');
    const module = { HEAPU8: heap, _free: free } as unknown as OrcaModule;
    const decoded = decodeModelGeometry(module, {
      ok: true,
      renderables: [renderable(22)],
      geometries: [{ volume_id: 41, vertex_ptr: 16, vertex_count: 3, index_ptr: 64, index_count: 3 }],
    }, 'session');

    expect(decoded.meshes[0].paintGeometryKey).toBeNull();
    expect(decoded.paintGeometries).toEqual([]);
    expect(free.mock.calls.map(([pointer]) => pointer)).toEqual([16, 64]);
  });

  it('references independently retained original and paint resources', () => {
    const module = { HEAPU8: new Uint8Array(128), _free: vi.fn() } as unknown as OrcaModule;
    const decoded = decodeModelGeometry(module, {
      ok: true,
      renderables: [renderable(22, '41:version-two')],
      geometries: [], paint_geometries: [],
    }, 'session', ['session:41'], ['session:paint:41:version-two']);

    expect(decoded.meshes[0].geometryKey).toBe('session:41');
    expect(decoded.meshes[0].paintGeometryKey).toBe('session:paint:41:version-two');
    expect(decoded.geometries).toEqual([]);
    expect(decoded.paintGeometries).toEqual([]);
  });

  it('frees every original and paint allocation after an early malformed entry', () => {
    const free = vi.fn();
    const module = { HEAPU8: new Uint8Array(128), _free: free } as unknown as OrcaModule;
    expect(() => decodeModelGeometry(module, {
      ok: true, renderables: [], geometries: [
        { volume_id: 1, vertex_ptr: 8, vertex_count: -1, index_ptr: 16, index_count: 3 },
        null,
        { volume_id: 2, vertex_ptr: 32, vertex_count: 3, index_ptr: 48, index_count: 3 },
      ],
      paint_geometries: [
        { paint_key: '3:bad', volume_id: 3, vertex_ptr: 64, index_ptr: 80 },
        null,
      ],
    }, 'session')).toThrow(/invalid model geometry/);
    expect(free.mock.calls.map(([pointer]) => pointer)).toEqual([8, 16, 32, 48, 64, 80]);
  });

  it('rejects malformed facet groups after freeing their buffers', () => {
    const free = vi.fn();
    const module = { HEAPU8: new Uint8Array(128), _free: free } as unknown as OrcaModule;
    expect(() => decodeModelGeometry(module, {
      ok: true,
      renderables: [renderable(22, '41:bad')],
      geometries: [],
      paint_geometries: [{ paint_key: '41:bad', volume_id: 41,
        vertex_ptr: 16, vertex_count: 3, index_ptr: 64, index_count: 3,
        draw_groups: [{ state_id: 1, start_index: 1, index_count: 3 }] }],
    }, 'session', ['session:41'])).toThrow('invalid model paint draw group range');
    expect(free.mock.calls.map(([pointer]) => pointer)).toEqual([16, 64]);
  });

  it('shares one copied source per volume and scopes keys to the client session', async () => {
    const client = createClient(async () => createMockModule());
    await client.addShape('Cube');
    const objectId = (await client.getModelStructure()).objects![0].id;
    await client.addInstance(objectId);
    const first = await client.getModelScenePatch([objectId], []);
    expect(first.meshes).toHaveLength(2);
    expect(first.geometries).toHaveLength(1);
    expect(first.meshes[0].geometryKey).toBe(first.meshes[1].geometryKey);
    const reused = await client.getModelScenePatch([objectId], [first.geometries[0].geometryKey]);
    expect(reused.geometries).toEqual([]);
    const full = await client.getModelMesh();
    expect(full.objects[0].positions).toBe(full.objects[1].positions);
    expect(full.objects[0].indices).toBe(full.objects[1].indices);
    expect(full.paintGeometries).toEqual([]);
    expect(full.objects[0].paintGeometryKey).toBeNull();
    const other = createClient(async () => createMockModule());
    await other.addShape('Cube');
    const otherId = (await other.getModelStructure()).objects![0].id;
    const isolated = await other.getModelScenePatch([otherId], [first.geometries[0].geometryKey]);
    expect(isolated.geometries).toHaveLength(1);
    expect(isolated.meshes[0].geometryKey).not.toBe(first.meshes[0].geometryKey);
  });
});
