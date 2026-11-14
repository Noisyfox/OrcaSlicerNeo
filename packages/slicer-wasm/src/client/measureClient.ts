import type { OrcaModule } from './types';
import type { MeasureApi, MeasurePlane, MeasurePlaneRequest, MeasureReply, MeasureTarget } from './measure';
import { callJson } from './heap';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const vector = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length && value.every(finite);
const handle = (value: unknown, prefix: string): value is string => typeof value === 'string' &&
  new RegExp(`^${prefix}[1-9]\\d*$`).test(value) && Number.isSafeInteger(Number(value.slice(prefix.length)));
const target = (value: unknown): value is MeasureTarget => record(value) && integer(value.objectId, 1) &&
  integer(value.instanceId, 1) && integer(value.volumeId, 1);
const sameTarget = (a: MeasureTarget, b: MeasureTarget): boolean => a.objectId === b.objectId && a.instanceId === b.instanceId && a.volumeId === b.volumeId;

function envelope(raw: unknown): asserts raw is Record<string, unknown> {
  if (!record(raw) || (typeof raw.error !== 'string' && (raw.ok !== true || raw.version !== 1))) throw new Error('invalid measurement response');
  if (typeof raw.error === 'string' && Object.keys(raw).some(key => key !== 'error')) throw new Error('invalid measurement error response');
}

function validFeature(value: unknown, owner: MeasureTarget, session: string, revision: number): boolean {
  if (!record(value)) return false;
  switch (value.type) {
    case 'point': return vector(value.point, 3);
    case 'edge': return vector(value.start, 3) && vector(value.end, 3) && finite(value.length) && (value.center === null || vector(value.center, 3));
    case 'circle': return vector(value.center, 3) && finite(value.radius) && vector(value.normal, 3) && finite(value.diameter);
    case 'plane': {
      const prefix = `mp-${session.slice(3)}-${revision}-${owner.objectId}-${owner.instanceId}-${owner.volumeId}-`;
      return vector(value.normal, 3) && vector(value.point, 3) && vector(value.transform, 16) && typeof value.resourceId === 'string' &&
        value.resourceId.startsWith(prefix) && /^(0|[1-9]\d*)$/.test(value.resourceId.slice(prefix.length)) &&
        Number.isSafeInteger(Number(value.resourceId.slice(prefix.length)));
    }
    default: return false;
  }
}

function validSelection(value: unknown, session: string, revision: number): boolean {
  if (!record(value) || !target(value.target) || !['feature', 'center', 'midpoint', 'pointOnFeature'].includes(String(value.kind)) ||
      !validFeature(value.source, value.target, session, revision) || !validFeature(value.value, value.target, session, revision)) return false;
  return value.kind === 'feature' || (record(value.value) && value.value.type === 'point');
}

function validDistance(value: unknown): boolean {
  return value === null || (record(value) && finite(value.value) && vector(value.from, 3) && vector(value.to, 3));
}

function validResult(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value) || !validDistance(value.infinite) || !validDistance(value.strict) ||
      (value.xyz !== null && !vector(value.xyz, 3)) || typeof value.showStrict !== 'boolean' || typeof value.showXyz !== 'boolean' ||
      (value.showStrict && value.strict === null) || (value.showXyz && value.xyz === null)) return false;
  if (value.angle === null) return true;
  const angle = value.angle;
  return record(angle) && finite(angle.radians) && vector(angle.center, 3) && finite(angle.radius) && typeof angle.coplanar === 'boolean' &&
    Array.isArray(angle.edge1) && angle.edge1.length === 2 && angle.edge1.every(point => vector(point, 3)) &&
    Array.isArray(angle.edge2) && angle.edge2.length === 2 && angle.edge2.every(point => vector(point, 3));
}

function validateStatus(raw: Record<string, unknown>, request: Record<string, unknown>, name: string): void {
  if (!handle(raw.sessionId, 'ms-') || !integer(raw.targetRevision, 1) || !integer(raw.selectionRevision, 1) ||
      typeof raw.sameTarget !== 'boolean' || (raw.first !== null && !validSelection(raw.first, raw.sessionId, raw.targetRevision)) ||
      (raw.second !== null && !validSelection(raw.second, raw.sessionId, raw.targetRevision)) || (raw.first === null && raw.second !== null) ||
      !validResult(raw.result)) throw new Error('invalid measurement status');
  const first = raw.first as { target: MeasureTarget } | null;
  const second = raw.second as { target: MeasureTarget } | null;
  if (raw.sameTarget !== !!(first && (!second || sameTarget(first.target, second.target)))) throw new Error('invalid measurement target status');
  if (name === 'orc_measure_open') {
    if (raw.targetRevision !== 1 || raw.selectionRevision !== 1 || raw.first !== null || raw.second !== null || raw.result !== null)
      throw new Error('invalid measurement open response');
  } else if (raw.sessionId !== request.sessionId || !integer(request.targetRevision, 1) ||
      raw.targetRevision !== request.targetRevision + (name === 'orc_measure_rebase' ? 1 : 0)) {
    throw new Error('stale measurement response');
  }
}

function validateDisplay(raw: Record<string, unknown>): void {
  if (!handle(raw.displayId, 'md-') || !Array.isArray(raw.markers)) throw new Error('invalid measurement display');
  const session = raw.sessionId as string, revision = raw.targetRevision as number;
  if (raw.hover !== null && (!record(raw.hover) || !target(raw.hover.target) || !integer(raw.hover.originalFacet) ||
      !vector(raw.hover.local, 3) || !vector(raw.hover.world, 3) ||
      (raw.hover.feature !== null && !validFeature(raw.hover.feature, raw.hover.target, session, revision))))
    throw new Error('invalid measurement hover');
  raw.markers.forEach((marker, index) => {
    if (!record(marker) || marker.index !== index || !vector(marker.position, 3) || !validSelection(marker.item, session, revision) ||
        !record(marker.item) || !record(marker.item.value) || marker.item.value.type !== 'point' ||
        !vector(marker.item.value.point, 3) || marker.position.some((n, i) => n !== (marker.item as { value: { point: number[] } }).value.point[i]))
      throw new Error('invalid measurement marker');
  });
}

/** Copy the native allocation before releasing its ownership token, even when
 * a different field in the response is malformed. Never free an input pointer. */
export function decodeMeasurePlane(module: OrcaModule, raw: unknown, request: MeasurePlaneRequest): MeasureReply<MeasurePlane> {
  const leaseId = record(raw) && handle(raw.leaseId, 'ml-') ? raw.leaseId : undefined;
  try {
    envelope(raw);
    if (typeof raw.error === 'string') return { error: raw.error };
    if (!leaseId) throw new Error('invalid measurement plane lease');
    if (raw.sessionId !== request.sessionId || raw.targetRevision !== request.targetRevision || raw.displayId !== request.displayId ||
        raw.resourceId !== request.resourceId || !integer(raw.vertex_ptr) || !integer(raw.vertexCount) || raw.vertexCount % 3 ||
        !vector(raw.transform, 16)) throw new Error('invalid measurement plane response');
    const bytes = raw.vertexCount * 12, pointer = raw.vertex_ptr;
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(pointer + bytes) || pointer + bytes > module.HEAPU8.length ||
        (bytes > 0 ? !pointer || pointer % 4 !== 0 : pointer !== 0)) throw new Error('invalid measurement plane buffer');
    return { ok: true, version: 1, sessionId: request.sessionId, targetRevision: request.targetRevision,
      displayId: request.displayId, resourceId: request.resourceId,
      vertices: new Float32Array(module.HEAPU8.slice(pointer, pointer + bytes).buffer), transform: raw.transform };
  } finally {
    if (leaseId) module.ccall('orc_measure_plane_release', 'void', ['string'], [JSON.stringify({ version: 1, leaseId })]);
  }
}

export function createMeasureApi(module: () => Promise<OrcaModule>): MeasureApi {
  const call = async <T>(name: string, request: object): Promise<MeasureReply<T>> => {
    const m = await module();
    const input = request as Record<string, unknown>;
    let raw: unknown;
    try {
      raw = callJson(m, name, ['string'], [JSON.stringify(request)]);
      envelope(raw);
      if (typeof raw.error === 'string') return { error: raw.error };
      if (name === 'orc_measure_close') {
        if (!handle(raw.sessionId, 'ms-') || raw.sessionId !== input.sessionId) throw new Error('invalid measurement close response');
      } else {
        validateStatus(raw, input, name);
        if (name === 'orc_measure_display') validateDisplay(raw);
        if (name === 'orc_measure_click' && !['selected', 'mesh', 'miss'].includes(String(raw.outcome))) throw new Error('invalid measurement click response');
        if (name === 'orc_measure_reset' && !['selected', 'close', 'unchanged'].includes(String(raw.outcome))) throw new Error('invalid measurement reset response');
      }
      return raw as T;
    } catch (error) {
      // A display has already been published by the synchronous native call.
      // Release a recognizable handle even when another response field is bad.
      try {
        if (name === 'orc_measure_display' && record(raw) && handle(raw.displayId, 'md-') && handle(input.sessionId, 'ms-')) {
          m.ccall('orc_measure_display_release', 'void', ['string'], [JSON.stringify({ version: 1, sessionId: input.sessionId, displayId: raw.displayId })]);
        } else if ((name === 'orc_measure_open' || name === 'orc_measure_display' || name === 'orc_measure_click' || name === 'orc_measure_reset' || name === 'orc_measure_rebase') &&
            handle(name === 'orc_measure_open' && record(raw) ? raw.sessionId : input.sessionId, 'ms-')) {
          // An invalid receipt after publication leaves the selection unknown;
          // close the transient session instead of returning a divergent state.
          const sessionId = name === 'orc_measure_open' && record(raw) ? raw.sessionId : input.sessionId;
          callJson(m, 'orc_measure_close', ['string'], [JSON.stringify({ version: 1, sessionId })]);
        }
      } catch { /* Preserve the original protocol error. */ }
      throw error;
    }
  };
  return {
    openMeasureSession: request => call('orc_measure_open', request),
    readMeasureSession: request => call('orc_measure_read', request),
    getMeasureDisplay: request => call('orc_measure_display', request),
    clickMeasure: request => call('orc_measure_click', request),
    resetMeasure: request => call('orc_measure_reset', request),
    rebaseMeasure: request => call('orc_measure_rebase', request),
    closeMeasureSession: request => call('orc_measure_close', request),
    releaseMeasureDisplay: async request => { (await module()).ccall('orc_measure_display_release', 'void', ['string'], [JSON.stringify(request)]); },
    getMeasurePlane: async request => {
      const m = await module();
      return decodeMeasurePlane(m, callJson(m, 'orc_measure_plane', ['string'], [JSON.stringify(request)]), request);
    },
  };
}
