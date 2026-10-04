import { describe, it, expect } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';
import type { VolumeType } from './types';

describe('Add native object volumes', () => {
  it.each(['model_part', 'negative_volume', 'parameter_modifier', 'support_blocker', 'support_enforcer'] as VolumeType[])(
    'adds a %s to the same object and shares it across instances', async (volumeType) => {
      const client = createClient(async () => createMockModule());
      await client.addShape('Cube');
      const object = (await client.getModelStructure()).objects![0];
      await client.addInstance(object.id);
      const added = await client.addVolume({ objectId: object.id, instanceId: object.instances[0].id, volumeType, shape: 'Sphere' });
      expect(added.ok).toBe(true);
      const structure = (await client.getModelStructure()).objects!;
      expect(structure).toHaveLength(1);
      expect(structure[0]).toMatchObject({ id: object.id, instanceCount: 2 });
      expect(structure[0].volumes).toContainEqual(expect.objectContaining({ id: added.volumeId, type: volumeType, name: 'Generic-Sphere' }));
      expect(added.plateSession?.affectedPlateIds).not.toHaveLength(0);
    });
  it('rejects stale or foreign targets and unsupported shapes without mutation', async () => {
    const client = createClient(async () => createMockModule());
    await client.addShape('Cube');
    const before = await client.getModelStructure(), object = before.objects![0];
    const target = { objectId: object.id, instanceId: object.instances[0].id, volumeType: 'model_part' as const, shape: 'Cube' };
    for (const invalid of [{ ...target, objectId: 999 }, { ...target, instanceId: 999 }, { ...target, shape: 'Text' }]) {
      expect((await client.addVolume(invalid)).ok).toBe(false);
      expect(await client.getModelStructure()).toEqual(before);
    }
  });
  it('uploads a file into the existing object', async () => {
    const client = createClient(async () => createMockModule());
    await client.addShape('Cube');
    const object = (await client.getModelStructure()).objects![0];
    const result = await client.addVolume({ objectId: object.id, instanceId: object.instances[0].id,
      volumeType: 'negative_volume', ext: 'stl', name: 'hole.stl' }, new Uint8Array([1, 2, 3]));
    expect(result.ok).toBe(true);
    expect((await client.getModelStructure()).objects![0].volumes).toContainEqual(expect.objectContaining({ name: 'hole.stl', type: 'negative_volume' }));
  });
});
