import { describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';
import { decodePaintingGeometry } from './paintingClient';
import { createWorkerClient, startWorker, type WorkerMessage, type WorkerTransport } from './worker';
const request = { version: 1 as const, channel: 'mmu' as const, sessionId: 'ps-1', revision: 1 };
function geometry() {
  const m = createMockModule();
  const a = m._malloc(72), b = m._malloc(24);
  const raw: any = { ok: true, leaseId: 'pg-1', ...request, candidates: [], parts: [{ volumeId: 3, resourceId: 'pd-mmu-1-1-3' }], resources: [
    { volumeId: 3, resourceId: 'pd-mmu-1-1-3', kind: 'draft', vertex_ptr: a, vertexCount: 3, contour_ptr: b, contourVertexCount: 2, groups: [[0,0,3]] }] };
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
    expect(decodePaintingGeometry(m, raw, { ...request, knownResourceIds: ['pd-mmu-1-1-3'] })).toMatchObject({ resources: [] });
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
  const opened: any = await client.openPaintingSession({ version: 1, channel: 'mmu', historySessionId: hs.sessionId, objectId: object.id, instanceId: object.instances[0].id });
  expect(opened.ok).toBe(true);
  let handle = { version: 1 as const, channel: 'mmu' as const, sessionId: opened.session.id, revision: opened.session.revision };
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

it.each(['channel', 'sessionId', 'revision', 'strokeId', 'hit', 'candidateRevision', 'phase', 'parts', 'recovery'])('rejects malformed or stale %s receipts', async field => {
  const m = createMockModule(); const original = m.ccall.bind(m);
  const client = createClient(async () => m); await client.init(); await client.addShape('Cube', 'paint');
  const object = (await client.getModelStructure()).objects[0]; const hs = await client.openHistorySession();
  const opened: any = await client.openPaintingSession({ version: 1, channel: 'mmu', historySessionId: hs.sessionId, objectId: object.id, instanceId: object.instances[0].id });
  const handle = { version: 1 as const, channel: 'mmu' as const, sessionId: opened.session.id, revision: opened.session.revision };
  m.ccall = ((name, ret, types, args) => {
    const pointer = original(name, ret, types, args);
    if (!name.startsWith('orc_painting_')) return pointer;
    const raw = JSON.parse(m.UTF8ToString(Number(pointer))); m._free(Number(pointer));
    if (field === 'parts') raw.session.parts.push(raw.session.parts[0]);
    else if (field === 'recovery') { raw.error = 'failure'; raw.recovered = true; raw.phase = 'drawing'; }
    else raw[field] = ({ channel: 'seam', sessionId: 'ps-999', revision: 999, strokeId: 'pst-999-1', hit: { volumeId: 1, originalFacet: -1, world: [0,0,0] }, candidateRevision: 900, phase: 'idle' } as any)[field];
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
  raw.candidates = [{ volumeId: 3, resourceId: 'pc-mmu-1-1-3', kind: 'region' }];
  expect(() => decodePaintingGeometry(m, raw, { ...request, knownResourceIds: ['pd-mmu-1-1-3'] })).toThrow('missing');
  const result = decodePaintingGeometry(m, raw, { ...request, knownResourceIds: ['pd-mmu-1-1-3', 'pc-mmu-1-1-3'] });
  expect(result).toMatchObject({ candidates: [{ resourceId: 'pc-mmu-1-1-3' }], resources: [] });
  raw.candidates = [];
  expect(decodePaintingGeometry(m, raw, { ...request, knownResourceIds: ['pd-mmu-1-1-3', 'pc-mmu-1-1-3'] })).toMatchObject({ candidates: [] });
});

it('rejects duplicate volume identities even with different generation IDs', () => {
  const { m, raw } = geometry(); raw.parts.push({ volumeId: 3, resourceId: 'pd-mmu-1-2-3' });
  expect(() => decodePaintingGeometry(m, raw, { ...request, knownResourceIds: ['pd-mmu-1-2-3'] })).toThrow('part');
});

it('never guesses allocation bases when the ownership lease is malformed', () => {
  const { m, raw, freed } = geometry(); raw.leaseId = 'pg-invalid';
  expect(() => decodePaintingGeometry(m, raw, request)).toThrow('lease');
  expect(freed).not.toHaveBeenCalled();
});

it.each(['triangle', 'region', 'gap'] as const)('transports %s preview to begin and commit through Worker', async tool => {
  const module = createMockModule(); const channel = new Channel();
  startWorker(async () => module, m => channel.post(m), fn => channel.onMessage(fn));
  const client = createWorkerClient(channel);
  await client.init(); await client.addShape('Cube', 'paint');
  const object = (await client.getModelStructure()).objects[0];
  const hs = await client.openHistorySession();
  const opened = await client.openPaintingSession({ version: 1, channel: 'mmu', historySessionId: hs.sessionId, objectId: object.id, instanceId: object.instances[0].id });
  if (!('ok' in opened)) throw new Error(opened.error);
  const handle = { version: 1 as const, channel: 'mmu' as const, sessionId: opened.session.id, revision: opened.session.revision };
  const preview = await client.previewPainting({ ...handle, tool, settings: { state: 2 } });
  if (!('ok' in preview)) throw new Error(preview.error);
  const geometry = await client.getPaintingGeometry({ ...handle, revision: preview.revision });
  expect(geometry).toMatchObject({ candidates: [{ kind: tool }], resources: expect.arrayContaining([expect.objectContaining({ kind: tool })]) });
  const begun = await client.beginPaintingStroke({ ...handle, revision: preview.revision, tool, settings: { state: 2 }, candidateRevision: preview.revision });
  if (!('ok' in begun) || !begun.strokeId) throw new Error('begin failed');
  expect(begun.candidateRevision).toBeNull();
  const committed = await client.commitPaintingStroke({ ...handle, revision: begun.revision, strokeId: begun.strokeId });
  expect(committed).toMatchObject({ ok: true, committed: true, phase: 'idle' });
});


it.each(['support', 'seam', 'fuzzy'] as const)('carries %s identity/state/geometry and preserves MMU through the Worker', async c => {
  const module = createMockModule(); const wire = new Channel();
  startWorker(async () => module, m => wire.post(m), fn => wire.onMessage(fn));
  const client = createWorkerClient(wire);
  await client.init(); await client.addShape('Cube', 'channel');
  const object = (await client.getModelStructure()).objects[0];
  const hs = await client.openHistorySession();
  const opened = await client.openPaintingSession({ version: 1, channel: c, historySessionId: hs.sessionId, objectId: object.id, instanceId: object.instances[0].id });
  if (!('ok' in opened)) throw new Error(opened.error);
  const handle = { version: 1 as const, channel: c, sessionId: opened.session.id, revision: 1 };
  const illegal = await client.beginPaintingStroke({ ...handle, tool: 'circle', settings: { state: c === 'fuzzy' ? 2 : 3 } });
  expect(illegal).toHaveProperty('error');
  await expect(client.beginPaintingStroke({ ...handle, tool: 'height', settings: {} })).resolves.toHaveProperty('error');
  const begun = await client.beginPaintingStroke({ ...handle, tool: 'circle', settings: { state: 1 } });
  if (!('ok' in begun) || !begun.strokeId) throw new Error('begin failed');
  expect(begun.channel).toBe(c);
  const committed = await client.commitPaintingStroke({ ...handle, revision: begun.revision, strokeId: begun.strokeId });
  if (!('ok' in committed)) throw new Error(committed.error);
  expect(committed).toMatchObject({ channel: c, committed: true });
  expect(committed.history.undoEntries[0].label).toBe(c === 'support' ? 'Paint Supports' : c === 'seam' ? 'Paint Seam' : 'Paint Fuzzy Skin');
  handle.revision = committed.revision;
  const display = await client.getPaintingGeometry(handle);
  if (!('ok' in display)) throw new Error(display.error);
  expect(display.channel).toBe(c);
  expect(display.resources[0].resourceId).toMatch(new RegExp(`^pd-${c}-`));
  expect(display.resources[0].groups[0][0]).toBe(1);
  const read = await client.readPaintingSession(handle);
  expect(read).toMatchObject({ session: { channel: c, parts: [{ annotationTimestamp: 1 }] } });
  await client.closePaintingSession(handle);
  const mmu = await client.openPaintingSession({ version: 1, channel: 'mmu', historySessionId: hs.sessionId, objectId: object.id, instanceId: object.instances[0].id });
  expect(mmu).toMatchObject({ session: { channel: 'mmu', parts: [{ facetCounts: [1, ...Array(16).fill(0)] }] } });
});

it.each(['support', 'seam', 'fuzzy'] as const)('rejects illegal %s geometry states and stale channel identities, releasing the lease', c => {
  for (const corrupt of ['state', 'channel', 'resource', 'candidate']) {
    const { m, raw, freed } = geometry();
    const req = { ...request, channel: c };
    raw.channel = c;
    raw.parts[0].resourceId = raw.resources[0].resourceId = `pd-${c}-1-1-3`;
    if (corrupt === 'state') raw.resources[0].groups[0][0] = c === 'fuzzy' ? 2 : 3;
    if (corrupt === 'channel') raw.channel = 'mmu';
    if (corrupt === 'resource') raw.parts[0].resourceId = 'pd-mmu-1-1-3';
    if (corrupt === 'candidate') raw.candidates = [{ volumeId: 3, resourceId: `pc-${c}-1-1-3`, kind: 'region' }];
    expect(() => decodePaintingGeometry(m, raw, req)).toThrow();
    expect(freed).toHaveBeenCalledTimes(2);
  }
});

it.each(['support', 'seam', 'fuzzy'] as const)('rejects illegal %s imported/candidate facet counts', async c => {
  for (const candidate of [false, true]) {
    const m = createMockModule(), original = m.ccall.bind(m);
    const client = createClient(async () => m); await client.init(); await client.addShape('Cube', 'paint');
    const object = (await client.getModelStructure()).objects[0]; const hs = await client.openHistorySession();
    const opened = await client.openPaintingSession({ version: 1, channel: c, historySessionId: hs.sessionId, objectId: object.id, instanceId: object.instances[0].id });
    if (!('ok' in opened)) throw new Error(opened.error);
    m.ccall = ((name, ret, types, args) => {
      const pointer = original(name, ret, types, args);
      if (name !== 'orc_painting_session_read') return pointer;
      const raw = JSON.parse(m.UTF8ToString(Number(pointer))); m._free(Number(pointer));
      const counts = [1, ...Array(16).fill(0)]; counts[c === 'fuzzy' ? 2 : 3] = 1;
      if (candidate) raw.session.candidate = { revision: raw.session.revision, selectedFacetCount: 1, gapRegionCount: 0, parts: [{ volumeId: raw.session.parts[0].volumeId, facetCounts: counts }] };
      else raw.session.parts[0].facetCounts = counts;
      const bytes = new TextEncoder().encode(JSON.stringify(raw) + '\0'); const result = m._malloc(bytes.length); m.HEAPU8.set(bytes, result); return result;
    }) as typeof m.ccall;
    await expect(client.readPaintingSession({ version: 1, channel: c, sessionId: opened.session.id, revision: 1 })).rejects.toThrow();
  }
});

it.each(['support','fuzzy'] as const)('decodes %s SmartFill with exact channel candidate identity', channel => {
  const {m,raw}=geometry(); raw.channel=channel;raw.parts[0].resourceId=`pd-${channel}-1-1-3`;raw.resources[0].resourceId=raw.parts[0].resourceId;
  raw.candidates=[{volumeId:3,resourceId:`pc-${channel}-1-1-3`,kind:'smartFill'}];
  const req={...request,channel,knownResourceIds:[raw.candidates[0].resourceId]};
  expect(decodePaintingGeometry(m,raw,req)).toMatchObject({candidates:[{kind:'smartFill'}]});
});
it('retains support highlight identity independently of candidate revision and rejects stale/cross-channel resources',()=> {
  const {m,raw,freed,a}=geometry();raw.channel='support';raw.revision=8;
  raw.parts[0].resourceId='pd-support-1-1-3';raw.resources[0].resourceId=raw.parts[0].resourceId;
  raw.candidates=[{volumeId:3,resourceId:'ph-support-1-1-3-2',kind:'overhang'}];
  const req={...request,channel:'support' as const,revision:8,knownResourceIds:['ph-support-1-1-3-2']};
  expect(decodePaintingGeometry(m,raw,req)).toMatchObject({candidates:[{kind:'overhang'}]});
  expect(freed).toHaveBeenCalledWith(a);
  for(const key of ['ph-mmu-1-1-3-2','ph-support-1-7-3-2','pc-support-1-8-3','ph-support-1-1-3-9','ph-support-1-1-3-9007199254740992']) {
    raw.candidates[0].resourceId=key;expect(()=>decodePaintingGeometry(m,raw,{...req,knownResourceIds:[key]})).toThrow();
  }
});

it.each(['9','9007199254740992'])('rejects impossible draft revision %s even with a consistent highlight prefix and releases its lease',revision=> {
  const {m,raw,a,freed}=geometry();raw.channel='support';raw.revision=8;
  raw.parts[0].resourceId=`pd-support-1-${revision}-3`;raw.resources[0].resourceId=raw.parts[0].resourceId;
  raw.candidates=[{volumeId:3,resourceId:`ph-support-1-${revision}-3-2`,kind:'overhang'}];
  expect(()=>decodePaintingGeometry(m,raw,{...request,channel:'support',revision:8})).toThrow('part revision');
  expect(freed).toHaveBeenCalledWith(a);
});

it('releases a fresh native lease when a highlight revision is in the future',()=> {
  const {m,raw,a,freed}=geometry();raw.channel='support';raw.revision=8;
  raw.parts[0].resourceId='pd-support-1-1-3';raw.resources[0].resourceId=raw.parts[0].resourceId;
  raw.candidates=[{volumeId:3,resourceId:'ph-support-1-1-3-9',kind:'overhang'}];
  expect(()=>decodePaintingGeometry(m,raw,{...request,channel:'support',revision:8})).toThrow('highlight revision');
  expect(freed).toHaveBeenCalledWith(a);
});
