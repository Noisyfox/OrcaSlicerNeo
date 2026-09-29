import { describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';
import { decodePaintingGeometry } from './paintingClient';
import { createWorkerClient, startWorker, type WorkerMessage, type WorkerTransport } from './worker';
const request = { version: 1 as const, sessionId: 'ps-1', revision: 1 };
function geometry() {
  const m = createMockModule();
  const a = m._malloc(72), b = m._malloc(24);
  const raw: any = { ok: true, leaseId: 'pg-1', ...request, candidates: [], parts: [{ volumeId: 3, resourceId: 'pd-1-1-3' }], resources: [
    { volumeId: 3, resourceId: 'pd-1-1-3', kind: 'draft', vertex_ptr: a, vertexCount: 3, contour_ptr: b, contourVertexCount: 2, groups: [[0,0,3]] }] };
  const freed = vi.spyOn(m, '_free');
  const original = m.ccall.bind(m); let released = false;
  m.ccall = ((name, ret, types, args) => {
    if (name !== 'orc_painting_geometry_release') return original(name, ret, types, args);
    if (JSON.parse(String(args[0])).leaseId === 'pg-1' && !released) { released = true; m._free(a); m._free(b); }
  }) as typeof m.ccall;
  return { m, a, b, raw, freed };
}
describe('painting binary ownership', () => {
  it('copies P3N3 and native contours before freeing all buffers', () => {
    const { m, raw, freed } = geometry();
    const result = decodePaintingGeometry(m, raw, request);
    expect('ok' in result && result.resources[0].vertices.length).toBe(18);
    expect(freed).toHaveBeenCalledTimes(2);
  });
  it.each(['stale', 'groups', 'pointer', 'count', 'identity', 'nan', 'later'])('frees all buffers on %s malformed response', mode => {
    const { m, raw, a, b, freed } = geometry();
    if (mode === 'stale') raw.revision++;
    if (mode === 'groups') raw.resources[0].groups = [[17,0,3]];
    if (mode === 'pointer') raw.resources[0].vertex_ptr = a + 1;
    if (mode === 'count') raw.resources[0].vertexCount = 1e20;
    if (mode === 'identity') raw.parts[0].resourceId = 'committed-scene';
    if (mode === 'nan') new Float32Array(m.HEAPU8.buffer)[a / 4] = NaN;
    if (mode === 'later') raw.resources.unshift({ volumeId: -1 });
    expect(() => decodePaintingGeometry(m, raw, request)).toThrow();
    expect(freed).toHaveBeenCalledWith(b);
    expect(freed).toHaveBeenCalledWith(a);
    expect(freed).not.toHaveBeenCalledWith(a + 1);
  });
  it('reuses explicitly retained draft resources and rejects missing resources', () => {
    const { m, raw } = geometry(); raw.resources = [];
    expect(() => decodePaintingGeometry(m, raw, request)).toThrow('missing');
    expect(decodePaintingGeometry(m, raw, { ...request, knownResourceIds: ['pd-1-1-3'] })).toMatchObject({ resources: [] });
  });
});
class Channel implements WorkerTransport {
  listeners: ((m: WorkerMessage) => void)[] = [];
  onMessage(fn: (m: WorkerMessage) => void) { this.listeners.push(fn); }
  post(m: WorkerMessage) { this.listeners.forEach(fn => fn(structuredClone(m))); }
}
it('transports lifecycle, geometry, effective/no-op commits and history through Worker', async () => {
  const module = createMockModule(); const channel = new Channel();
  startWorker(async () => module, m => channel.post(m), fn => channel.onMessage(fn));
  const client = createWorkerClient(channel);
  await client.init(); await client.addShape('Cube', 'paint');
  const structure: any = await client.getModelStructure(); const object = structure.objects[0];
  const hs = await client.openHistorySession();
  const opened: any = await client.openPaintingSession({ version: 1, historySessionId: hs.sessionId, objectId: object.id, instanceId: object.instances[0].id });
  expect(opened.ok).toBe(true);
  let handle = { version: 1 as const, sessionId: opened.session.id, revision: opened.session.revision };
  const geo: any = await client.getPaintingGeometry(handle); expect(geo.resources[0].vertices).toBeInstanceOf(Float32Array);
  const begun: any = await client.beginPaintingStroke({ ...handle, tool: 'triangle', settings: { state: 2 } });
  await expect(client.closeHistorySession(hs.sessionId)).rejects.toThrow('busy');
  await expect(client.undoHistory()).rejects.toThrow('busy');
  const committed: any = await client.commitPaintingStroke({ ...handle, revision: begun.revision, strokeId: begun.strokeId });
  expect(committed).toMatchObject({ ok: true, committed: true, phase: 'idle' });
  expect(committed.history.undoEntries[0].label).toBe('Paint');
  handle.revision = committed.revision;
  const next: any = await client.beginPaintingStroke({ ...handle, tool: 'triangle', settings: { state: 2 } });
  const noop: any = await client.commitPaintingStroke({ ...handle, revision: next.revision, strokeId: next.strokeId });
  expect(noop.committed).toBe(false);
  await client.undoHistory();
  const restored: any = await client.readPaintingSession({ ...handle, revision: noop.revision, latest: true });
  expect(restored.session.parts[0].facetCounts[0]).toBe(1);
  await client.closePaintingSession({ ...handle, revision: restored.session.revision });
  await client.closeHistorySession(hs.sessionId);
});

it.each(['sessionId', 'revision', 'strokeId', 'hit', 'candidateRevision', 'phase', 'parts', 'recovery'])('rejects malformed or stale %s receipts', async field => {
  const m = createMockModule(); const original = m.ccall.bind(m);
  const client = createClient(async () => m); await client.init(); await client.addShape('Cube', 'paint');
  const object = (await client.getModelStructure()).objects[0]; const hs = await client.openHistorySession();
  const opened: any = await client.openPaintingSession({ version: 1, historySessionId: hs.sessionId, objectId: object.id, instanceId: object.instances[0].id });
  const handle = { version: 1 as const, sessionId: opened.session.id, revision: opened.session.revision };
  m.ccall = ((name, ret, types, args) => {
    const pointer = original(name, ret, types, args);
    if (!name.startsWith('orc_painting_')) return pointer;
    const raw = JSON.parse(m.UTF8ToString(Number(pointer))); m._free(Number(pointer));
    if (field === 'parts') raw.session.parts.push(raw.session.parts[0]);
    else if (field === 'recovery') { raw.error = 'failure'; raw.recovered = true; raw.phase = 'drawing'; }
    else raw[field] = ({ sessionId: 'ps-999', revision: 999, strokeId: 'pst-999-1', hit: { volumeId: 1, originalFacet: -1, world: [0,0,0] }, candidateRevision: 900, phase: 'idle' } as any)[field];
    const bytes = new TextEncoder().encode(JSON.stringify(raw) + '\0'); const result = m._malloc(bytes.length); m.HEAPU8.set(bytes, result); return result;
  }) as typeof m.ccall;
  const promise = field === 'parts' ? client.readPaintingSession(handle) : client.beginPaintingStroke({ ...handle, tool: 'triangle', settings: {} });
  await expect(promise).rejects.toThrow(/painting/);
});
it('does not coerce malformed strings into freeable pointers', () => {
  const { m, raw, a, freed } = geometry(); raw.resources[0].vertex_ptr = String(a);
  expect(() => decodePaintingGeometry(m, raw, request)).toThrow();
  expect(freed).toHaveBeenCalledWith(a);
});
it('candidate manifests distinguish retained overlays from removal', () => {
  const { m, raw } = geometry(); raw.resources = [];
  raw.candidates = [{ volumeId: 3, resourceId: 'pc-1-1-3', kind: 'region' }];
  expect(() => decodePaintingGeometry(m, raw, { ...request, knownResourceIds: ['pd-1-1-3'] })).toThrow('missing');
  const result = decodePaintingGeometry(m, raw, { ...request, knownResourceIds: ['pd-1-1-3', 'pc-1-1-3'] });
  expect(result).toMatchObject({ candidates: [{ resourceId: 'pc-1-1-3' }], resources: [] });
  raw.candidates = [];
  expect(decodePaintingGeometry(m, raw, { ...request, knownResourceIds: ['pd-1-1-3', 'pc-1-1-3'] })).toMatchObject({ candidates: [] });
});

it('rejects duplicate volume identities even with different generation IDs', () => {
  const { m, raw } = geometry(); raw.parts.push({ volumeId: 3, resourceId: 'pd-1-2-3' });
  expect(() => decodePaintingGeometry(m, raw, { ...request, knownResourceIds: ['pd-1-2-3'] })).toThrow('part');
});

it('never guesses allocation bases when the ownership lease is malformed', () => {
  const { m, raw, freed } = geometry(); raw.leaseId = 'pg-invalid';
  expect(() => decodePaintingGeometry(m, raw, request)).toThrow('lease');
  expect(freed).not.toHaveBeenCalled();
});

it.each(['region', 'gap'] as const)('transports %s preview to begin and commit through Worker', async tool => {
  const module = createMockModule(); const channel = new Channel();
  startWorker(async () => module, m => channel.post(m), fn => channel.onMessage(fn));
  const client = createWorkerClient(channel);
  await client.init(); await client.addShape('Cube', 'paint');
  const object = (await client.getModelStructure()).objects[0];
  const hs = await client.openHistorySession();
  const opened = await client.openPaintingSession({ version: 1, historySessionId: hs.sessionId, objectId: object.id, instanceId: object.instances[0].id });
  if (!('ok' in opened)) throw new Error(opened.error);
  const handle = { version: 1 as const, sessionId: opened.session.id, revision: opened.session.revision };
  const preview = await client.previewPainting({ ...handle, tool, settings: { state: 2 } });
  if (!('ok' in preview)) throw new Error(preview.error);
  const begun = await client.beginPaintingStroke({ ...handle, revision: preview.revision, tool, settings: { state: 2 }, candidateRevision: preview.revision });
  if (!('ok' in begun) || !begun.strokeId) throw new Error('begin failed');
  expect(begun.candidateRevision).toBeNull();
  const committed = await client.commitPaintingStroke({ ...handle, revision: begun.revision, strokeId: begun.strokeId });
  expect(committed).toMatchObject({ ok: true, committed: true, phase: 'idle' });
});
