import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule, type MockModuleOptions } from './testing/mock-module';
import type { MeshBooleanRequest } from './types';

async function setup(options: MockModuleOptions = {}) {
  const module = createMockModule({ volumeCount: 3, instanceCount: 2, ...options });
  const client = createClient(async () => module);
  await client.addModel(new Uint8Array(4), 'stl');
  const { objects } = await client.getModelStructure();
  const object = objects[0];
  const request: MeshBooleanRequest = { entry: 'gizmo', objectId: object.id,
    instanceId: object.instances[0].id, sourceVolumeId: object.volumes[2].id,
    toolVolumeId: object.volumes[0].id, operation: 'difference', deleteInput: false, keepPainting: false };
  return { client, module, object, request };
}

describe('Mesh Boolean typed protocol and structural semantics', () => {
  it.each(['union', 'difference', 'intersection'] as const)('preserves instance identities and replaces A for %s', async operation => {
    const { client, object, request } = await setup();
    const result = await client.meshBoolean({ ...request, operation });
    expect(result.ok && result.changed).toBe(true);
    if (!result.ok || !result.changed) throw new Error('Expected result');
    const changed = result.objects.find(item => item.id === object.id)!;
    expect(changed.instances).toEqual(object.instances);
    expect(changed.volumes.at(-1)?.id).toBe(result.volumeId);
    expect(changed.volumes.map(volume => volume.id)).toContain(object.volumes[1].id);
    expect(changed.volumes.map(volume => volume.id).includes(request.toolVolumeId)).toBe(operation !== 'union');
    expect(result.plateSession.nativeScopedConfig.kind).toBe('full');
  });

  it('deleteInput consumes B for Difference while retaining unrelated Parts', async () => {
    const { client, request, object } = await setup();
    const result = await client.meshBoolean({ ...request, deleteInput: true });
    expect(result.ok && result.changed && result.objects[0].volumes.map(volume => volume.id))
      .toEqual([object.volumes[1].id, expect.any(Number)]);
  });

  it('object entry consumes modifiers and keeps the shared object/instances', async () => {
    const { client, object } = await setup({ meshBooleanResult: 'positive-parts-only' });
    await client.setVolumeType(object.volumes[1].id, 'support_blocker');
    const result = await client.meshBoolean({ entry: 'object', objectId: object.id, keepPainting: false });
    expect(result.ok && result.changed).toBe(true);
    if (!result.ok || !result.changed) throw new Error('Expected result');
    expect(result.warning).toBe('positive_parts_only');
    expect(result.objects[0].instances).toEqual(object.instances);
    expect(result.objects[0].volumes).toEqual([expect.objectContaining({ id: result.volumeId, type: 'model_part' })]);
  });

  it('empty output is an explicit unchanged result without a mutation receipt', async () => {
    const { client, request } = await setup({ meshBooleanResult: 'empty' });
    const before = await client.getModelStructure();
    expect(await client.meshBoolean(request)).toEqual({ ok: true, changed: false, warning: 'empty_result' });
    expect(await client.getModelStructure()).toEqual(before);
  });

  it('rejects a stale operand before changing the model', async () => {
    const { client, request } = await setup();
    const before = await client.getModelStructure();
    expect(await client.meshBoolean({ ...request, sourceVolumeId: 999999 })).toEqual({ ok: false, error: expect.any(String) });
    expect(await client.getModelStructure()).toEqual(before);
  });

  it('rejects an unchanged response that carries a model invalidation receipt', async () => {
    const { client, module, request } = await setup({ meshBooleanResult: 'empty' });
    const call = module.ccall;
    module.ccall = (name, ret, types, args) => {
      const pointer = call(name, ret, types, args);
      if (name !== 'orc_mesh_boolean') return pointer;
      const value = JSON.parse(module.UTF8ToString(Number(pointer)));
      module._free(Number(pointer));
      const bytes = new TextEncoder().encode(JSON.stringify({ ...value, plate_session: {} }));
      const replacement = module._malloc(bytes.length + 1);
      module.HEAPU8.set(bytes, replacement); module.HEAPU8[replacement + bytes.length] = 0;
      return replacement;
    };
    expect(await client.meshBoolean(request)).toEqual({ ok: false, error: 'invalid empty Mesh Boolean response' });
  });
});
