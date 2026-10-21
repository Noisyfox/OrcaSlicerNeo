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
  async request(printer: PrinterConfiguration, path: string, request: Omit<PrinterTransportRequest, 'url'>, responseKind: 'object' | 'acknowledgement' = 'object'): Promise<Record<string, unknown>> {
    if (request.signal?.aborted) fail('cancelled', 'Printer request cancelled');
    let response;
    try {
      response = await this.transport.request({ ...request, url: endpoint(printer.apiBaseUrl, path), headers: {
        ...(printer.apiKey ? { 'X-Api-Key': printer.apiKey } : {}), ...request.headers,
      } });
    } catch {
      throw new MoonrakerFailure({ code: request.signal?.aborted ? 'cancelled' : 'transport', message: 'Printer request interrupted' }, request.method === 'POST');
    }
    if (response.status < 200 || response.status >= 300) {
      fail(response.status === 401 ? 'authentication-required' : response.status === 403 ? 'permission-denied' : 'device-rejected', 'Printer rejected the request');
    }
    try {
      const payload = record(await response.json());
      if ('error' in payload) fail('device-rejected', 'Printer rejected the request');
      if (!('result' in payload)) throw new Error('Missing result');
      // Only mutation acknowledgements may use the documented string result.
      if (responseKind === 'acknowledgement') {
        if (payload.result !== 'ok') throw new Error('Missing acknowledgement');
        return {};
      }
      if (!payload.result || typeof payload.result !== 'object' || Array.isArray(payload.result)) throw new Error('Invalid result');
      return record(payload.result);
    } catch (error) {
      if (error instanceof MoonrakerFailure) throw error;
      throw new MoonrakerFailure({ code: 'device-failed', message: 'Invalid printer response' }, request.method === 'POST');
    }
  }
  get(printer: PrinterConfiguration, path: string, signal?: AbortSignal) {
    return this.request(printer, path, { method: 'GET', signal });
  }
  post(printer: PrinterConfiguration, path: string, json: unknown) {
    return this.request(printer, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { kind: 'json', json: JSON.stringify(json) } }, 'acknowledgement');
  }
  async upload(printer: PrinterConfiguration, fileName: string, bytes: Uint8Array, signal: AbortSignal, onUploadProgress: PrinterTransportRequest['onUploadProgress']) {
    const result = await this.request(printer, '/server/files/upload', {
      method: 'POST', signal, onUploadProgress,
      body: { kind: 'multipart', fields: { root: 'gcodes' }, file: { fileName, bytes } },
    });
    const item = record(result.item);
    const path = [item.path, result.path, item.filename, result.filename].find(value => typeof value === 'string' && value.length > 0);
    if (typeof path !== 'string') throw new MoonrakerFailure({ code: 'device-failed', message: 'Upload returned no remote path' }, true);
    return path;
  }
}
