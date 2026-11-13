import { expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule, MOCK_PROFILE_ACTIVATION } from './testing/mock-module';

it('blocks only model operations that invalidate measured targets', async () => {
  const client = createClient(async () => createMockModule());
  await client.init(MOCK_PROFILE_ACTIVATION);
  await client.addShape('Cube', 'Measured');
  let object = (await client.getModelStructure()).objects[0];
  for (let i = 0; i < 2; ++i)
    await client.addVolume({ objectId: object.id, instanceId: object.instances[0].id, volumeType: 'model_part', shape: 'Cube' });
  await client.addInstance(object.id);
  await client.addShape('Cube', 'Other');
  [object] = (await client.getModelStructure()).objects;
  const other = (await client.getModelStructure()).objects[1];
  const [first, second, third] = object.volumes.map(volume => volume.id);
  const [instance, sibling] = object.instances.map(entry => entry.id);
  const opened = await client.openMeasureSession({ version: 1, targets: [{ objectId: object.id, instanceId: instance, volumeId: first }] });
  if (!('ok' in opened)) throw new Error(opened.error);
  const before = await client.getModelStructure();
  const failures = [
    await client.clearModel(),
    await client.deleteObjects([other.id, object.id]),
    await client.deleteVolumes([first]),
    await client.splitVolumeToParts(first),
    await client.splitObjectToObjects(object.id),
    await client.mergeObjectsToMultipart([object.id, other.id], 'Merged'),
    await client.separateInstances(object.id, [instance]),
    await client.removeInstance(object.id, instance),
    await client.meshBoolean({ entry: 'object', objectId: object.id, keepPainting: false }),
    await client.meshBoolean({ entry: 'gizmo', objectId: object.id, instanceId: sibling,
      sourceVolumeId: second, toolVolumeId: first, operation: 'union', deleteInput: false, keepPainting: false }),
  ];
  failures.forEach(value => expect(value).toMatchObject({ error: expect.stringContaining('Close Measure') }));
  expect(await client.getModelStructure()).toEqual(before);
  expect(await client.deleteVolumes([third])).toMatchObject({ ok: true });
  expect(await client.deleteVolumes([second])).toMatchObject({ error: expect.stringContaining('Close Measure') });
  expect(await client.removeInstance(object.id, sibling)).toMatchObject({ ok: true });
  expect(await client.deleteObjects([other.id])).toMatchObject({ ok: true });
  expect(await client.readMeasureSession({ version: 1, sessionId: opened.sessionId, targetRevision: 1 })).toMatchObject({ ok: true });
  await client.closeMeasureSession({ version: 1, sessionId: opened.sessionId });
  expect(await client.deleteVolumes([first])).toMatchObject({ ok: true });
});
