/** Provider-private HTTP mapping; callers use the domain service, never vendor payloads. */
import { PrinterConfigurationValidationError, type PrinterConfiguration } from './configuration';
import type { PrinterTransport, PrinterTransportRequest } from './transport';
import type { PrinterError } from './domain';

export class MoonrakerFailure extends Error {
  constructor(readonly detail: PrinterError, readonly uncertain = false) {
    super(detail.message);
  }
}
export function fail(code: PrinterError['code'], message: string): never {
  throw new MoonrakerFailure({ code, message });
}
export function publicError(error: unknown): PrinterError {
  if (error instanceof PrinterConfigurationValidationError) return { code: 'invalid-request', message: 'Invalid printer configuration' };
  return error instanceof MoonrakerFailure ? error.detail : { code: 'transport', message: 'Printer request failed' };
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function objectResult(payload: Record<string, unknown>): Record<string, unknown> {
  if (!payload.result || typeof payload.result !== 'object' || Array.isArray(payload.result)) throw new Error('Invalid result');
  return record(payload.result);
}
export function endpoint(base: string, path: string): string {
  const url = new URL(base);
  const [pathname, search = ''] = path.split('?', 2);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${pathname.replace(/^\/+/, '')}`;
  url.search = search;
  url.hash = '';
  return url.href;
}
export class MoonrakerHttp {
  constructor(private readonly transport: PrinterTransport) {}
  private async request<T>(printer: PrinterConfiguration, path: string, request: Omit<PrinterTransportRequest, 'url'>,
    decode: (payload: Record<string, unknown>) => T, notFound?: () => T): Promise<T> {
    if (request.signal?.aborted) fail('cancelled', 'Printer request cancelled');
    let response;
    try {
      response = await this.transport.request({ ...request, url: endpoint(printer.apiBaseUrl, path), headers: {
        ...(printer.apiKey ? { 'X-Api-Key': printer.apiKey } : {}), ...request.headers,
      } });
    } catch {
      throw new MoonrakerFailure({ code: request.signal?.aborted ? 'cancelled' : 'transport', message: 'Printer request interrupted' }, request.method !== 'GET');
    }
    if (response.status === 404 && notFound) return notFound();
    if (request.method === 'DELETE' && response.status >= 500)
      throw new MoonrakerFailure({ code: 'device-failed', message: 'Printer did not confirm file deletion' }, true);
    if (response.status < 200 || response.status >= 300) {
      fail(response.status === 401 ? 'authentication-required' : response.status === 403 ? 'permission-denied' : 'device-rejected', 'Printer rejected the request');
    }
    try {
      const payload = record(await response.json());
      if ('error' in payload) fail('device-rejected', 'Printer rejected the request');
      return decode(payload);
    } catch (error) {
      if (error instanceof MoonrakerFailure) throw error;
      throw new MoonrakerFailure({ code: 'device-failed', message: 'Invalid printer response' }, request.method !== 'GET');
    }
  }
  get(printer: PrinterConfiguration, path: string, signal?: AbortSignal) {
    return this.request(printer, path, { method: 'GET', signal }, objectResult);
  }
  getOptional(printer: PrinterConfiguration, path: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown> | null>(printer, path, { method: 'GET', signal }, objectResult, () => null);
  }
  getArray(printer: PrinterConfiguration, path: string, signal?: AbortSignal) {
    return this.request(printer, path, { method: 'GET', signal }, payload => {
      if (!Array.isArray(payload.result)) throw new Error('Invalid result');
      return payload.result as readonly unknown[];
    });
  }
  deleteGcode(printer: PrinterConfiguration, path: string, filename: string, signal: AbortSignal) {
    return this.request(printer, path, { method: 'DELETE', signal }, payload => {
      const result = objectResult(payload), item = record(result.item);
      if (result.action !== 'delete_file' || item.root !== 'gcodes' || item.path !== filename)
        throw new Error('Mismatched deletion acknowledgement');
    });
  }
  async getBytes(printer: PrinterConfiguration, path: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) fail('cancelled', 'Printer request cancelled');
    let response;
    try {
      response = await this.transport.request({ method: 'GET', url: endpoint(printer.apiBaseUrl, path), responseType: 'bytes', signal,
        headers: printer.apiKey ? { 'X-Api-Key': printer.apiKey } : {} });
    } catch {
      fail(signal?.aborted ? 'cancelled' : 'transport', 'Printer request interrupted');
    }
    if (response.status < 200 || response.status >= 300) {
      fail(response.status === 401 ? 'authentication-required' : response.status === 403 ? 'permission-denied' : 'preview-unavailable', 'Printer image is unavailable');
    }
    return response.bytes();
  }
  post(printer: PrinterConfiguration, path: string, json: unknown) {
    return this.request(printer, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { kind: 'json', json: JSON.stringify(json) } }, payload => {
      if (payload.result !== 'ok') throw new Error('Missing acknowledgement');
    });
  }
  async upload(printer: PrinterConfiguration, fileName: string, bytes: Uint8Array, signal: AbortSignal, onUploadProgress: PrinterTransportRequest['onUploadProgress']) {
    return this.request(printer, '/server/files/upload', {
      method: 'POST', signal, onUploadProgress,
      body: { kind: 'multipart', fields: { root: 'gcodes' }, file: { fileName, bytes } },
    }, payload => {
      // The HTTP-only upload endpoint returns a top-level item, without a result envelope.
      const item = record(payload.item);
      const path = item.path;
      if (item.root !== 'gcodes' || typeof path !== 'string' || !path || path.includes('\0')
        || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error('Invalid uploaded file location');
      }
      return path;
    });
  }
}
