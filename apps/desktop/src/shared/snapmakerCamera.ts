import type * as D from '@orca/printer-control/domain';
import type { PrinterConfiguration } from '@orca/printer-control';
import { isBambuMediaRequest, isBambuMediaAttachment, isMediaRef, type BambuMediaAttachment } from './bambuMedia';

export type CameraStatus = { descriptor: D.MediaDescriptor; state: 'connecting' | 'ready' | 'closed'; error: D.PrinterError | null };
export interface CameraInputs {
  open: { request: D.OpenMediaRequest; configurationDigest: string };
  cancelOpen: { requestId: D.Id<'request'> };
  get: D.MediaRef;
  renew: D.MediaRef;
  interact: D.MediaRef;
  close: D.MediaRef;
}
export interface CameraResults {
  open: D.Result<D.MediaDescriptor>;
  cancelOpen: D.Result<null>;
  get: D.Result<CameraStatus>;
  renew: D.Result<D.MediaDescriptor>;
  interact: D.Result<null>;
  close: D.Result<null>;
}
export type CameraRequest = { [K in keyof CameraInputs]: { method: K; input: CameraInputs[K] } }[keyof CameraInputs];
export interface SnapmakerCameraBridge {
  call<K extends keyof CameraInputs>(method: K, input: CameraInputs[K]): Promise<CameraResults[K]>;
  connect(request: BambuMediaAttachment): void;
  onChanged(listener: () => void): () => void;
}
/** Private comparison input. Neither credentials nor this digest enter media descriptors. */
export function cameraConfigurationKey(printer: Readonly<PrinterConfiguration>): string {
  return JSON.stringify([printer.id, printer.driverId, printer.apiBaseUrl, printer.apiKey, printer.consoleUrl]);
}
export async function cameraConfigurationDigest(printer: Readonly<PrinterConfiguration>): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cameraConfigurationKey(printer)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function isCameraRequest(value: unknown): value is CameraRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some(key => key !== 'method' && key !== 'input')) return false;
  if (request.method === 'interact') return isMediaRef(request.input);
  if (request.method !== 'open') return isBambuMediaRequest(value);
  const input = request.input as CameraInputs['open'] | undefined;
  return !!input && typeof input === 'object' && Object.keys(input).every(key => key === 'request' || key === 'configurationDigest')
    && typeof input.configurationDigest === 'string' && /^[a-f0-9]{64}$/.test(input.configurationDigest)
    && isBambuMediaRequest({ method: 'open', input: input.request }) && input.request.source.kind === 'camera';
}
export function isCameraAttachment(value: unknown): value is BambuMediaAttachment {
  return isBambuMediaAttachment(value) && value.startSeconds === undefined;
}
