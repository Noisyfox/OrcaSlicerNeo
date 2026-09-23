import { describe, expect, it, vi } from 'vitest';
import { decodeModelGeometry } from './modelGeometry';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';
import type { OrcaModule } from './types';

describe('native geometry resource transport', () => {
  it('frees every allocation after a malformed early entry', () => {
    const free = vi.fn();
    const module = { HEAPU8: new Uint8Array(128), _free: free } as unknown as OrcaModule;
    expect(() => decodeModelGeometry(module, { ok: true, renderables: [], geometries: [
      { volume_id: 1, vertex_ptr: 8, vertex_count: -1, index_ptr: 16, index_count: 3 },
      { volume_id: 2, vertex_ptr: 32, vertex_count: 3, index_ptr: 80, index_count: 3 },
    ] }, 'session')).toThrow('invalid model geometry buffer');
    expect(free.mock.calls.map(([pointer]) => pointer)).toEqual([8, 16, 32, 80]);
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
    const other = createClient(async () => createMockModule());
    await other.addShape('Cube');
    const otherId = (await other.getModelStructure()).objects![0].id;
    const isolated = await other.getModelScenePatch([otherId], [first.geometries[0].geometryKey]);
    expect(isolated.geometries).toHaveLength(1);
    expect(isolated.meshes[0].geometryKey).not.toBe(first.meshes[0].geometryKey);
  });
});
