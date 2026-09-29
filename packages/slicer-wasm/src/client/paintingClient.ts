import type { OrcaModule } from './types';
import type { PaintingApi, PaintingGeometryRequest, PaintingGeometryResult } from './painting';
import { callJson } from './heap';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
function envelope(value: unknown): asserts value is Record<string, unknown> {
  if (!record(value) || (typeof value.error !== 'string' && (value.ok !== true || value.version !== 1)))
    throw new Error('invalid painting response');
}
export function decodePaintingGeometry(module: OrcaModule, raw: unknown, request: PaintingGeometryRequest): PaintingGeometryResult {
  const leaseId = record(raw) && canonical(raw.leaseId, 'pg-') ? raw.leaseId : undefined;
  try {
    envelope(raw);
    if (typeof raw.error === 'string') return { error: raw.error };
    if (!leaseId) throw new Error('invalid painting geometry lease');
    if (raw.sessionId !== request.sessionId || raw.revision !== request.revision || !Array.isArray(raw.parts) || !Array.isArray(raw.resources) || !Array.isArray(raw.candidates))
      throw new Error('stale or invalid painting geometry response');
    const used = new Set<number>();
    const ranges: [number, number][] = [];
    const copy = (pointer: unknown, count: unknown, stride: number): Float32Array => {
      if (!integer(pointer) || !integer(count) || !Number.isSafeInteger(count * stride * 4)) throw new Error('invalid painting buffer');
      const bytes = count * stride * 4;
      if ((bytes > 0 && (!pointer || pointer % 4 || used.has(pointer))) || (!bytes && pointer !== 0) || pointer + bytes > module.HEAPU8.length || ranges.some(([start, end]) => bytes > 0 && pointer < end && pointer + bytes > start))
        throw new Error('invalid painting buffer range');
      if (pointer) { used.add(pointer); ranges.push([pointer, pointer + bytes]); }
      const result = new Float32Array(module.HEAPU8.slice(pointer, pointer + bytes).buffer);
      if (!result.every(Number.isFinite)) throw new Error('invalid painting vertex');
      return result;
    };
    const ids = new Set<string>();
    const volumeIds = new Set<number>();
    const parts = raw.parts.map((part: unknown) => {
      if (!record(part) || !integer(part.volumeId, 1) || volumeIds.has(part.volumeId) || typeof part.resourceId !== 'string' ||
          !new RegExp(`^pd-${request.sessionId.slice(3)}-[1-9]\\d*-${part.volumeId}$`).test(part.resourceId) || ids.has(part.resourceId)) throw new Error('invalid painting part');
      ids.add(part.resourceId); volumeIds.add(part.volumeId);
      return { volumeId: part.volumeId, resourceId: part.resourceId };
    });
    const candidates = raw.candidates.map((candidate: unknown) => {
      if (!record(candidate) || !integer(candidate.volumeId, 1) || !parts.some(p => p.volumeId === candidate.volumeId) ||
          (candidate.kind !== 'region' && candidate.kind !== 'gap') || typeof candidate.resourceId !== 'string' ||
          !new RegExp(`^pc-${request.sessionId.slice(3)}-${request.revision}-${candidate.volumeId}${candidate.kind === 'gap' ? '-[0-9]+' : ''}$`).test(candidate.resourceId) || ids.has(candidate.resourceId))
        throw new Error('invalid painting candidate manifest');
      ids.add(candidate.resourceId);
      return { volumeId: candidate.volumeId, resourceId: candidate.resourceId, kind: candidate.kind as 'region' | 'gap' };
    });
    const resources = raw.resources.map((entry: unknown) => {
      if (!record(entry) || !integer(entry.volumeId, 1) || !parts.some(p => p.volumeId === entry.volumeId) ||
          typeof entry.resourceId !== 'string' || (entry.kind !== 'draft' && entry.kind !== 'region' && entry.kind !== 'gap') || !Array.isArray(entry.groups) || !integer(entry.vertexCount) || !integer(entry.contourVertexCount))
        throw new Error('invalid painting geometry');
      if (entry.kind === 'draft' ? !parts.some(p => p.resourceId === entry.resourceId && p.volumeId === entry.volumeId)
          : !candidates.some(candidate => candidate.resourceId === entry.resourceId && candidate.kind === entry.kind && candidate.volumeId === entry.volumeId)) throw new Error('invalid painting resource identity');
      const vertices = copy(entry.vertex_ptr, entry.vertexCount, 6);
      const contour = copy(entry.contour_ptr, entry.contourVertexCount, 3);
      if (entry.vertexCount % 3 || entry.contourVertexCount % 2) throw new Error('invalid painting primitive count');
      let end = 0;
      const states = new Set<number>();
      for (const group of entry.groups) {
        if (!Array.isArray(group) || group.length !== 3 || !integer(group[0]) || group[0] > 16 || states.has(group[0]) ||
            group[1] !== end || !integer(group[2], 1) || group[2] % 3) throw new Error('invalid painting groups');
        states.add(group[0]); end += group[2];
      }
      if (end !== entry.vertexCount) throw new Error('invalid painting group coverage');
      return { volumeId: entry.volumeId, resourceId: entry.resourceId, kind: entry.kind as 'draft' | 'region' | 'gap', vertices, contour, groups: entry.groups as [number, number, number][] };
    });
    if (new Set(resources.map(resource => resource.resourceId)).size !== resources.length) throw new Error('duplicate painting resource');
    for (const part of [...parts, ...candidates]) if (!resources.some(resource => resource.resourceId === part.resourceId) && !request.knownResourceIds?.includes(part.resourceId))
      throw new Error('missing painting resource');
    return { ok: true, version: 1, sessionId: raw.sessionId, revision: raw.revision, parts, candidates, resources };
  } finally {
    // Even malformed resource addresses release only native-owned allocation bases.
    // A corrupt lease cannot safely identify ownership; never guess a pointer.
    if (leaseId) module.ccall('orc_painting_geometry_release', 'void', ['string'], [JSON.stringify({ version: 1, leaseId })]);
  }
}
function canonical(value: unknown, prefix: string): value is string {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}[1-9]\\d*$`).test(value)) return false;
  return BigInt(value.slice(prefix.length)) <= 18446744073709551615n;
}
function vector(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && value.every(n => typeof n === 'number' && Number.isFinite(n));
}
function ids(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(n => integer(n, 1)) && new Set(value).size === value.length;
}
function phase(value: unknown, stroke: unknown, id: string): boolean {
  return value === 'idle' ? stroke === null : (value === 'drawing' || value === 'finished') && canonical(stroke, `pst-${id.slice(3)}-`);
}
function counts(value: unknown): boolean { return Array.isArray(value) && value.length === 17 && value.every(n => integer(n)); }
function checkReceipt(raw: Record<string, unknown>, request: Record<string, unknown>, operation: string): void {
  if (!canonical(raw.sessionId, 'ps-') || raw.sessionId !== request.sessionId || !integer(raw.revision, 1) ||
      !integer(request.revision, 1) || raw.revision !== request.revision + 1 || !phase(raw.phase, raw.strokeId, raw.sessionId) ||
      typeof raw.effective !== 'boolean' || !ids(raw.changedPartIds) ||
      (raw.candidateRevision !== null && raw.candidateRevision !== raw.revision)) throw new Error('invalid painting receipt');
  if (raw.phase !== 'idle' && operation !== 'orc_painting_stroke_begin' && raw.strokeId !== request.strokeId)
    throw new Error('invalid painting stroke receipt');
  const expected = operation === 'orc_painting_stroke_begin' ? (['gap', 'eraseAll'].includes(String(request.tool)) ? 'finished' : 'drawing')
    : operation === 'orc_painting_stroke_sample' ? 'drawing' : operation === 'orc_painting_stroke_finish' ? 'finished' : 'idle';
  if (raw.phase !== expected) throw new Error('invalid painting receipt phase');
  if (raw.hit !== null && (!record(raw.hit) || !integer(raw.hit.volumeId, 1) || !integer(raw.hit.originalFacet) || !vector(raw.hit.world, 3)))
    throw new Error('invalid painting hit');
  if (operation !== 'orc_painting_preview' && raw.candidateRevision !== null) throw new Error('invalid painting candidate revision');
}
function checkSession(raw: Record<string, unknown>, request: Record<string, unknown>, operation: string): void {
  const s = raw.session;
  if (!record(s) || !canonical(s.id, 'ps-') || !canonical(s.historySessionId, 'hs-') || !integer(s.revision, 1) ||
      !integer(s.objectId, 1) || !integer(s.instanceId, 1) || s.annotation !== 'mmu' || !vector(s.instanceTransform, 16) ||
      !phase(s.phase, s.strokeId, s.id) || !Array.isArray(s.parts) || s.parts.length === 0) throw new Error('invalid painting session');
  if (operation === 'orc_painting_session_open') {
    if (s.historySessionId !== request.historySessionId || s.revision !== 1 || s.phase !== 'idle') throw new Error('invalid painting open receipt');
  } else if (s.id !== request.sessionId || !integer(request.revision, 1) ||
      (operation === 'orc_painting_session_target' ? s.revision !== request.revision + 1 : request.latest === true ? s.revision < request.revision : s.revision !== request.revision))
    throw new Error('stale painting session receipt');
  if (operation !== 'orc_painting_session_read' && (s.objectId !== request.objectId || s.instanceId !== request.instanceId))
    throw new Error('invalid painting target receipt');
  const seen = new Set<number>();
  for (const p of s.parts) {
    if (!record(p) || !integer(p.volumeId, 1) || seen.has(p.volumeId) || !integer(p.sourceTriangleCount, 1) ||
        !vector(p.volumeTransform, 16) || !counts(p.facetCounts) || typeof p.draftResourceId !== 'string' ||
        !new RegExp(`^pd-${s.id.slice(3)}-[1-9]\\d*-${p.volumeId}$`).test(p.draftResourceId)) throw new Error('invalid painting part metadata');
    seen.add(p.volumeId);
  }
  if (s.candidate !== undefined) {
    const c = s.candidate;
    if (!record(c) || c.revision !== s.revision || !integer(c.selectedFacetCount) || !integer(c.gapRegionCount) || !Array.isArray(c.parts) ||
        c.parts.length !== s.parts.length || !ids(c.parts.map(p => record(p) ? p.volumeId : null)) ||
        !c.parts.every(p => record(p) && seen.has(p.volumeId as number) && counts(p.facetCounts))) throw new Error('invalid painting candidate metadata');
  }
}
export function createPaintingApi(module: () => Promise<OrcaModule>, normalizeHistory: (value: unknown) => import('./history').HistoryStatus): PaintingApi {
  const call = async <T>(name: string, request: object, kind: 'session' | 'draft' | 'close' | 'commit' | 'settle'): Promise<T> => {
    const raw = callJson(await module(), name, ['string'], [JSON.stringify(request)]);
    envelope(raw);
    const input = request as Record<string, unknown>;
    if (typeof raw.error === 'string') {
      if (raw.recovered !== undefined) {
        if (kind !== 'commit' || raw.recovered !== true) throw new Error('invalid painting recovery');
        checkReceipt(raw, input, name);
        if (raw.phase !== 'idle' || raw.effective !== false || (raw.changedPartIds as unknown[]).length !== 0) throw new Error('invalid painting recovery state');
        return { error: raw.error, recovered: true, sessionId: raw.sessionId, revision: raw.revision } as T;
      }
      return { error: raw.error } as T;
    }
    if (kind === 'session') checkSession(raw, input, name);
    else if (kind === 'draft' || kind === 'commit') {
      checkReceipt(raw, input, name);
      if (kind === 'commit') {
        if (typeof raw.committed !== 'boolean' || !Array.isArray(raw.affectedPlateIds) ||
            !raw.affectedPlateIds.every(id => typeof id === 'string' && id.length > 0) ||
            new Set(raw.affectedPlateIds).size !== raw.affectedPlateIds.length) throw new Error('invalid painting commit');
        raw.history = normalizeHistory(raw.history);
      }
    } else if (kind === 'settle' && !integer(raw.settledVersion)) throw new Error('invalid painting settlement');
    return raw as T;
  };
  return {
    openPaintingSession: request => call('orc_painting_session_open', request, 'session'),
    targetPaintingSession: request => call('orc_painting_session_target', request, 'session'),
    readPaintingSession: request => call('orc_painting_session_read', request, 'session'),
    closePaintingSession: request => call('orc_painting_session_close', request, 'close'),
    previewPainting: request => call('orc_painting_preview', request, 'draft'),
    beginPaintingStroke: request => call('orc_painting_stroke_begin', request, 'draft'),
    samplePaintingStroke: request => call('orc_painting_stroke_sample', request, 'draft'),
    finishPaintingStroke: request => call('orc_painting_stroke_finish', request, 'draft'),
    cancelPaintingStroke: request => call('orc_painting_stroke_cancel', request, 'draft'),
    commitPaintingStroke: request => call('orc_painting_stroke_commit', request, 'commit'),
    settlePainting: () => call('orc_painting_settle', { version: 1 }, 'settle'),
    getPaintingGeometry: async request => { const m = await module(); return decodePaintingGeometry(m,
      callJson(m, 'orc_painting_geometry', ['string'], [JSON.stringify(request)]), request); },
  };
}
