import { expect, it } from 'vitest';
import { isBambuControlRequest } from './bambuControl';
it('accepts only bounded typed observation requests, never native payloads or host settings', () => {
  const target = { printerId: 'bambu:a', routeId: 'bambu:a:agent' };
  expect(isBambuControlRequest({ method: 'describe', input: target })).toBe(true);
  expect(isBambuControlRequest({ method: 'preview', input: { ...target, expectedConfigurationRevision: 'r1' } })).toBe(true);
  expect(isBambuControlRequest({ method: 'preview', input: { ...target, url: 'https://private/' } })).toBe(false);
  expect(isBambuControlRequest({ method: 'read', input: { target, topics: ['status', 'materials'], source: 'device' } })).toBe(true);
  expect(isBambuControlRequest({ method: 'observe', input: { target, token: 'subscription' } })).toBe(true);
  expect(isBambuControlRequest({ method: 'release', input: { token: 'subscription' } })).toBe(true);
  for (const request of [
    { method: 'send_message', input: { payload: '{}' } },
    { method: 'describe', input: { ...target, accessCode: 'code' } },
    { method: 'describe', input: { ...target, expectedConfigurationRevision: 'r1' } },
    { method: 'observe', input: { target: { ...target, expectedConfigurationRevision: 'r1' }, token: 'subscription' } },
    { method: 'read', input: { target: { ...target, expectedConfigurationRevision: 'r1' }, topics: ['status'], source: 'cache' } },
    { method: 'read', input: { target, topics: [], source: 'device' } },
    { method: 'read', input: { target, topics: ['raw'], source: 'device' } },
    { method: 'read', input: { target, topics: ['status', 'status'], source: 'cache' } },
    { method: 'read', input: { target, topics: ['status'], source: 'raw' } },
    { method: 'observe', input: { target, token: '' } },
    { method: 'release', input: { token: 'a'.repeat(513) } },
    { method: 'describe', input: target, addonPath: '/tmp/evil' },
  ]) expect(isBambuControlRequest(request)).toBe(false);
});
it('rejects command injection and malformed guards before native dispatch', () => {
  const target = { printerId: 'bambu:a', routeId: 'bambu:a:agent' };
  const input = { target, requestId: 'request', command: { type: 'jobs.pause', params: {} } };
  expect(isBambuControlRequest({ method: 'submit', input })).toBe(true);
  expect(isBambuControlRequest({ method: 'submit', input: { ...input, guard: { expectedTaskId: 'task' } } })).toBe(true);
  expect(isBambuControlRequest({ method: 'submit', input: { ...input, command: { type: 'jobs.pause', params: { gcode: 'G28' } } } })).toBe(false);
  expect(isBambuControlRequest({ method: 'submit', input: { ...input, guard: { capabilityRevision: {} } } })).toBe(false);
  expect(isBambuControlRequest({ method: 'submit', input: { ...input, command: { type: 'fans.setSpeed', params: { fanId: 'fan:1', speedFraction: Infinity } } } })).toBe(false);
  expect(isBambuControlRequest({ method: 'submit', input: { ...input, command: { type: 'motion.jog', params: { motionGroupId: 'gantry', axis: 'x', kind: 'step', stepId: 'small', direction: 'up' } } } })).toBe(false);
});

it('bounds object selections and requires an explicit task-scoped cancellation intent', () => {
  const target = { printerId: 'bambu:a', routeId: 'bambu:a:agent' };
  const contextRef = { ...target, configurationRevision: 'r1', taskId: 'task-1', token: 'catalogue-1' };
  const params = { contextRef, objectIds: ['object-a'], intent: 'skip-selected' };
  const request = (value: unknown) => ({ method: 'submit', input: { target, requestId: 'r', command: { type: 'jobs.skipObjects', params: value } } });
  expect(isBambuControlRequest(request(params))).toBe(true);
  expect(isBambuControlRequest(request({ ...params, intent: 'cancel-print' }))).toBe(true);
  expect(isBambuControlRequest(request({ ...params, objectIds: Array.from({ length: 64 }, (_, i) => `object-${i}`) }))).toBe(true);
  expect(isBambuControlRequest({ method: 'objectMap', input: { contextRef, readId: 'image-read' } })).toBe(true);
  expect(isBambuControlRequest({ method: 'cancelObjectRead', input: { readId: 'image-read' } })).toBe(true);
  expect(isBambuControlRequest({ method: 'read', input: { target, topics: ['printObjects'], source: 'device', readId: 'catalogue-read' } })).toBe(true);
  expect(isBambuControlRequest({ method: 'read', input: { target, topics: ['printObjects'], source: 'device' } })).toBe(false);
  for (const invalid of [
    { ...params, objectIds: [] }, { ...params, objectIds: ['object-a', 'object-a'] },
    { ...params, objectIds: [1] }, { ...params, objectIds: [''] },
    { ...params, objectIds: Array.from({ length: 65 }, (_, i) => `object-${i}`) },
    { ...params, intent: 'auto' }, { contextRef, objectIds: ['object-a'] },
    { ...params, contextRef: { ...contextRef, taskId: '' } },
    { ...params, contextRef: { ...contextRef, token: undefined } },
    { ...params, obj_list: [1] },
  ]) expect(isBambuControlRequest(request(invalid))).toBe(false);
  expect(isBambuControlRequest({ method: 'objectMap', input: { contextRef, readId: 'image-read', url: 'bambu:///private' } })).toBe(false);
});
