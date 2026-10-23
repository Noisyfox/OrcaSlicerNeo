import { expect, it } from 'vitest';
import { isBambuControlRequest } from './bambuControl';
it('accepts only bounded typed observation requests, never native payloads or host settings', () => {
  const target = { printerId: 'bambu:a', routeId: 'bambu:a:cloud' };
  expect(isBambuControlRequest({ method: 'describe', input: target })).toBe(true);
  expect(isBambuControlRequest({ method: 'read', input: { target, topics: ['status', 'materials'], source: 'device' } })).toBe(true);
  expect(isBambuControlRequest({ method: 'observe', input: { target, token: 'subscription' } })).toBe(true);
  expect(isBambuControlRequest({ method: 'release', input: { token: 'subscription' } })).toBe(true);
  for (const request of [
    { method: 'send_message', input: { payload: '{}' } },
    { method: 'describe', input: { ...target, accessCode: 'code' } },
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
  const target = { printerId: 'bambu:a', routeId: 'bambu:a:cloud' };
  const input = { target, requestId: 'request', command: { type: 'jobs.pause', params: {} } };
  expect(isBambuControlRequest({ method: 'submit', input })).toBe(true);
  expect(isBambuControlRequest({ method: 'submit', input: { ...input, guard: { expectedTaskId: 'task' } } })).toBe(true);
  expect(isBambuControlRequest({ method: 'submit', input: { ...input, command: { type: 'jobs.pause', params: { gcode: 'G28' } } } })).toBe(false);
  expect(isBambuControlRequest({ method: 'submit', input: { ...input, guard: { capabilityRevision: {} } } })).toBe(false);
  expect(isBambuControlRequest({ method: 'submit', input: { ...input, command: { type: 'fans.setSpeed', params: { fanId: 'fan:1', speedFraction: Infinity } } } })).toBe(false);
  expect(isBambuControlRequest({ method: 'submit', input: { ...input, command: { type: 'motion.jog', params: { motionGroupId: 'gantry', axis: 'x', kind: 'step', stepId: 'small', direction: 'up' } } } })).toBe(false);
});
