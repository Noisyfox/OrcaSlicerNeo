import { describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import { decodeMeasurePlane } from './measureClient';
import { createMockModule, MOCK_PROFILE_ACTIVATION } from './testing/mock-module';
import { createWorkerClient, startWorker, type WorkerMessage, type WorkerTransport } from './worker';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const event = (x: number) => ({ pointer: [x, 40] as const, viewport: [0, 0, 100, 100] as const, projection: identity, view: identity });
const planeRequest = { version: 1 as const, sessionId: 'ms-1', targetRevision: 1, displayId: 'md-1', role: 'hover' as const, resourceId: 'mp-1-1-1-2-3-0' };

function binaryFixture() {
  const module = createMockModule();
  const pointer = module._malloc(36);
  module.HEAPF32.set([1, 2, 3, 4, 5, 6, 7, 8, 9], pointer / 4);
  const raw: any = { ok: true, version: 1, sessionId: 'ms-1', targetRevision: 1, displayId: 'md-1',
    resourceId: planeRequest.resourceId, leaseId: 'ml-1', vertex_ptr: pointer, vertexCount: 3, transform: identity };
  const original = module.ccall.bind(module), release = vi.fn();
  module.ccall = ((name, ret, types, args) => {
    if (name === 'orc_measure_plane_release') { release(JSON.parse(String(args[0]))); module._free(pointer); return; }
    return original(name, ret, types, args);
  }) as typeof module.ccall;
  return { module, pointer, raw, release };
}

describe('measurement binary ownership', () => {
  it('copies the native buffer and releases its lease', () => {
    const { module, pointer, raw, release } = binaryFixture();
    const result = decodeMeasurePlane(module, raw, planeRequest);
    if (!('ok' in result)) throw new Error(result.error);
    expect([...result.vertices]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    module.HEAPF32.fill(0, pointer / 4, pointer / 4 + 9);
    expect([...result.vertices]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(release).toHaveBeenCalledExactlyOnceWith({ version: 1, leaseId: 'ml-1' });
  });
  it.each(['session', 'revision', 'display', 'resource', 'pointer', 'count', 'transform'] as const)(
    'releases a valid lease on malformed %s', field => {
      const { module, raw, release } = binaryFixture();
      if (field === 'session') raw.sessionId = 'ms-2';
      if (field === 'revision') raw.targetRevision = 2;
      if (field === 'display') raw.displayId = 'md-2';
      if (field === 'resource') raw.resourceId = 'wrong';
      if (field === 'pointer') raw.vertex_ptr += 1;
      if (field === 'count') raw.vertexCount = Number.MAX_SAFE_INTEGER;
      if (field === 'transform') raw.transform = [1];
      expect(() => decodeMeasurePlane(module, raw, planeRequest)).toThrow(/measurement/);
      expect(release).toHaveBeenCalledExactlyOnceWith({ version: 1, leaseId: 'ml-1' });
    });
  it('does not guess ownership from malformed lease IDs', () => {
    const { module, raw, release } = binaryFixture(); raw.leaseId = 'ml-01';
    expect(() => decodeMeasurePlane(module, raw, planeRequest)).toThrow(/lease/);
    expect(release).not.toHaveBeenCalled();
  });
});

class Channel implements WorkerTransport {
  listeners: ((message: WorkerMessage) => void)[] = [];
  onMessage(listener: (message: WorkerMessage) => void) { this.listeners.push(listener); }
  post(message: WorkerMessage) { this.listeners.forEach(listener => listener(message)); }
}

it('transports session, marker selection, plane lease and cleanup through the Worker', async () => {
  const module = createMockModule(), wire = new Channel();
  startWorker(async () => module, message => wire.post(message), listener => wire.onMessage(listener));
  const client = createWorkerClient(wire);
  await client.init(MOCK_PROFILE_ACTIVATION); await client.addShape('Cube', 'measure');
  const object = (await client.getModelStructure()).objects[0];
  const target = { objectId: object.id, instanceId: object.instances[0].id, volumeId: object.volumes[0].id };
  const opened = await client.openMeasureSession({ version: 1, targets: [target] });
  if (!('ok' in opened)) throw new Error(opened.error);
  const request = { version: 1 as const, sessionId: opened.sessionId, targetRevision: opened.targetRevision };
  const edge = await client.getMeasureDisplay({ ...request, event: event(10) });
  if (!('ok' in edge)) throw new Error(edge.error);
  expect(edge.hover?.feature?.type).toBe('edge');
  const selected = await client.clickMeasure({ ...request, displayId: edge.displayId, marker: 0, shift: false, event: event(10) });
  if (!('ok' in selected)) throw new Error(selected.error);
  expect(selected.first?.kind).toBe('midpoint');
  const plane = await client.getMeasureDisplay({ ...request, event: event(80) });
  if (!('ok' in plane) || plane.hover?.feature?.type !== 'plane') throw new Error('plane unavailable');
  const resource = await client.getMeasurePlane({ ...request, displayId: plane.displayId, role: 'hover', resourceId: plane.hover.feature.resourceId });
  if (!('ok' in resource)) throw new Error(resource.error);
  expect([...resource.vertices]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  await client.releaseMeasureDisplay({ version: 1, sessionId: opened.sessionId, displayId: plane.displayId });
  await expect(client.getMeasurePlane({ ...request, displayId: plane.displayId, role: 'hover', resourceId: plane.hover.feature.resourceId })).resolves.toHaveProperty('error');
  const rebased = await client.rebaseMeasure(request);
  if (!('ok' in rebased)) throw new Error(rebased.error);
  expect(rebased.targetRevision).toBe(2);
  expect(rebased.first?.kind).toBe('midpoint');
  await expect(client.closeMeasureSession({ version: 1, sessionId: opened.sessionId })).resolves.toMatchObject({ ok: true });
  await expect(client.readMeasureSession({ ...request, targetRevision: 2 })).resolves.toHaveProperty('error');
});

it.each(['session', 'revision', 'selection', 'sameTarget', 'result', 'marker', 'feature'] as const)(
  'rejects malformed %s responses from the module', async field => {
    const module = createMockModule(), original = module.ccall.bind(module);
    const client = createClient(async () => module);
    await client.init(MOCK_PROFILE_ACTIVATION); await client.addShape('Cube', 'measure');
    const object = (await client.getModelStructure()).objects[0];
    const target = { objectId: object.id, instanceId: object.instances[0].id, volumeId: object.volumes[0].id };
    const opened = await client.openMeasureSession({ version: 1, targets: [target] });
    if (!('ok' in opened)) throw new Error(opened.error);
    module.ccall = ((name, ret, types, args) => {
      const pointer = original(name, ret, types, args);
      if (name !== 'orc_measure_display') return pointer;
      const raw = JSON.parse(module.UTF8ToString(Number(pointer))); module._free(Number(pointer));
      if (field === 'session') raw.sessionId = 'ms-2';
      if (field === 'revision') raw.targetRevision++;
      if (field === 'selection') raw.first = { kind: 'feature' };
      if (field === 'sameTarget') raw.sameTarget = true;
      if (field === 'result') raw.result = { angle: null, infinite: null, strict: null, xyz: null, showStrict: true, showXyz: false };
      if (field === 'marker') raw.markers[0].index = 5;
      if (field === 'feature') raw.hover.feature = { type: 'edge', start: [0, 0], end: [0, 0, 0], length: 1, center: null };
      const bytes = new TextEncoder().encode(JSON.stringify(raw) + '\0'); const replacement = module._malloc(bytes.length);
      module.HEAPU8.set(bytes, replacement); return replacement;
    }) as typeof module.ccall;
    await expect(client.getMeasureDisplay({ version: 1, sessionId: opened.sessionId, targetRevision: 1, event: event(10) })).rejects.toThrow(/measurement/);
  });

it('releases a published display when decoding another field fails', async () => {
  const module = createMockModule(), original = module.ccall.bind(module);
  const client = createClient(async () => module);
  await client.init(MOCK_PROFILE_ACTIVATION); await client.addShape('Cube', 'measure');
  const object = (await client.getModelStructure()).objects[0];
  const opened = await client.openMeasureSession({ version: 1, targets: [{ objectId: object.id, instanceId: object.instances[0].id, volumeId: object.volumes[0].id }] });
  if (!('ok' in opened)) throw new Error(opened.error);
  const releases: unknown[] = [];
  module.ccall = ((name, ret, types, args) => {
    if (name === 'orc_measure_display_release') releases.push(JSON.parse(String(args[0])));
    const pointer = original(name, ret, types, args);
    if (name !== 'orc_measure_display') return pointer;
    const raw = JSON.parse(module.UTF8ToString(Number(pointer))); module._free(Number(pointer)); raw.markers[0].index = 99;
    const bytes = new TextEncoder().encode(JSON.stringify(raw) + '\0'); const replacement = module._malloc(bytes.length);
    module.HEAPU8.set(bytes, replacement); return replacement;
  }) as typeof module.ccall;
  const request = { version: 1 as const, sessionId: opened.sessionId, targetRevision: 1 };
  await expect(client.getMeasureDisplay({ ...request, event: event(10) })).rejects.toThrow(/marker/);
  expect(releases).toEqual([{ version: 1, sessionId: opened.sessionId, displayId: 'md-1' }]);
  await expect(client.clickMeasure({ ...request, displayId: 'md-1', marker: 0, shift: false, event: event(10) })).resolves.toHaveProperty('error');
});

it('closes a published session when an open receipt is malformed', async () => {
  const module = createMockModule(), original = module.ccall.bind(module);
  const client = createClient(async () => module);
  await client.init(MOCK_PROFILE_ACTIVATION); await client.addShape('Cube', 'measure');
  const object = (await client.getModelStructure()).objects[0];
  module.ccall = ((name, ret, types, args) => {
    const pointer = original(name, ret, types, args);
    if (name !== 'orc_measure_open') return pointer;
    const raw = JSON.parse(module.UTF8ToString(Number(pointer))); module._free(Number(pointer)); raw.targetRevision = 2;
    const bytes = new TextEncoder().encode(JSON.stringify(raw) + '\0'); const replacement = module._malloc(bytes.length);
    module.HEAPU8.set(bytes, replacement); return replacement;
  }) as typeof module.ccall;
  await expect(client.openMeasureSession({ version: 1, targets: [{ objectId: object.id, instanceId: object.instances[0].id, volumeId: object.volumes[0].id }] })).rejects.toThrow(/measurement/);
  await expect(client.readMeasureSession({ version: 1, sessionId: 'ms-1', targetRevision: 1 })).resolves.toHaveProperty('error');
});
