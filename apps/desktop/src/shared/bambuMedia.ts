/** Metadata-only IPC and bounded binary channel messages. Credentials never cross this boundary. */
import type * as D from '@orca/printer-control/domain';
export type BambuMediaStatus = { descriptor: D.MediaDescriptor; state: 'ready' | 'interrupted' | 'closed'; error: D.PrinterError | null };
export interface BambuMediaInputs { open: D.OpenMediaRequest; get: D.MediaRef; renew: D.MediaRef; close: D.MediaRef }
export interface BambuMediaResults { open: D.Result<D.MediaDescriptor>; get: D.Result<BambuMediaStatus>; renew: D.Result<D.MediaDescriptor>; close: D.Result<null> }
export type BambuMediaRequest = { [K in keyof BambuMediaInputs]: { method: K; input: BambuMediaInputs[K] } }[keyof BambuMediaInputs];
export type BambuMediaCall = <K extends keyof BambuMediaInputs>(method: K, input: BambuMediaInputs[K]) => Promise<BambuMediaResults[K]>;
export interface BambuMediaAttachment { media: D.MediaRef; streamId: D.Id<'media-stream'>; token: string }
export type BambuMediaMessage = { type: 'packet'; packet: D.MediaStreamPacket } | { type: 'error'; error: D.PrinterError } | { type: 'closed' };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 512;
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
export function isMediaRef(v: unknown): v is D.MediaRef {
  return object(v) && exact(v, ['printerId', 'routeId', 'id']) && text(v.printerId) && text(v.routeId) && text(v.id);
}
export function isBambuMediaAttachment(v: unknown): v is BambuMediaAttachment {
  return object(v) && exact(v, ['media', 'streamId', 'token']) && isMediaRef(v.media) && text(v.streamId) && text(v.token);
}
export function isBambuMediaRequest(v: unknown): v is BambuMediaRequest {
  if (!object(v) || !exact(v, ['method', 'input'])) return false;
  if (['get', 'renew', 'close'].includes(String(v.method))) return isMediaRef(v.input);
  if (v.method !== 'open' || !object(v.input) || !exact(v.input, ['target', 'requestId', 'source', 'client'])) return false;
  const r = v.input;
  if (!object(r.target) || !exact(r.target, ['printerId', 'routeId', 'expectedConfigurationRevision']) || !text(r.target.printerId) || !text(r.target.routeId)
    || r.target.expectedConfigurationRevision !== undefined && !text(r.target.expectedConfigurationRevision) || !text(r.requestId)) return false;
  if (!object(r.source) || r.source.kind !== 'camera' || !exact(r.source, ['kind', 'cameraId', 'profileId']) || !text(r.source.cameraId) || r.source.profileId !== undefined && !text(r.source.profileId)) return false;
  const c = r.client;
  return object(c) && exact(c, ['video', 'imageMimeTypes', 'contentFormats']) && Array.isArray(c.video) && c.video.length <= 16
    && c.video.every(v => object(v) && exact(v, ['transport', 'codecIds']) && ['mse-fmp4', 'jpeg-frames', 'hls', 'mjpeg', 'progressive-http', 'webrtc'].includes(String(v.transport))
      && Array.isArray(v.codecIds) && v.codecIds.length <= 16 && v.codecIds.every(text))
    && [c.imageMimeTypes, c.contentFormats].every(v => Array.isArray(v) && v.length <= 16 && v.every(text));
}
/** The host sends only known packet kinds, bounded owned bytes and monotonic numeric positions. */
export function isMediaPacket(v: unknown): v is D.MediaStreamPacket {
  return object(v) && Number.isSafeInteger(v.generation) && Number(v.generation) >= 0 && Number.isSafeInteger(v.sequence) && Number(v.sequence) >= 0
    && v.bytes instanceof Uint8Array && v.bytes.byteLength > 0 && v.bytes.byteLength <= 16 * 1024 * 1024
    && (v.kind === 'segment' || v.kind === 'jpeg' || v.kind === 'init' && typeof v.mimeType === 'string' && v.mimeType.length <= 256);
}
