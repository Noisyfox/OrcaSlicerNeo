import { expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule, MOCK_PROFILE_ACTIVATION } from './testing/mock-module';

it('permits model deletion and rejects reads of a removed measurement target', async () => {
  const client = createClient(async () => createMockModule());
  await client.init(MOCK_PROFILE_ACTIVATION);
  await client.addShape('Cube', 'Measured');
  await client.addShape('Cube', 'Other');
  const [object, other] = (await client.getModelStructure()).objects;
  const opened = await client.openMeasureSession({ version: 1, targets: [{
    objectId: object.id, instanceId: object.instances[0].id, volumeId: object.volumes[0].id,
  }] });
  if (!('ok' in opened)) throw new Error(opened.error);
  const handle = { version: 1 as const, sessionId: opened.sessionId, targetRevision: opened.targetRevision };
  expect(await client.deleteObjects([other.id])).toMatchObject({ ok: true });
  expect(await client.readMeasureSession(handle)).toMatchObject({ ok: true });
  expect(await client.deleteObjects([object.id])).toMatchObject({ ok: true });
  expect(await client.readMeasureSession(handle)).toMatchObject({ error: expect.stringContaining('stale') });
  expect(await client.closeMeasureSession({ version: 1, sessionId: opened.sessionId })).toMatchObject({ ok: true });
});
