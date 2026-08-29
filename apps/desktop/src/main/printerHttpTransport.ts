import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { PrinterTransportBody } from '../../../../packages/printer-control/src/transport';
import type {
  PrinterTransportIpcRequest,
  PrinterTransportIpcResponse,
  PrinterTransportProgress,
} from '../shared/ipc';

export interface NativeHttpResponse {
  statusCode: number;
  onData(listener: (chunk: Uint8Array) => void): void;
  onEnd(listener: () => void): void;
  onError(listener: (error: unknown) => void): void;
}

export interface NativeHttpRequestHandle {
  write(bytes: Uint8Array, onAccepted?: () => void): void;
  end(): void;
  abort(): void;
}

export interface NativeHttpClient {
  request(
    options: { method: string; protocol: 'http:' | 'https:'; hostname: string; port: string; path: string; headers: Record<string, string> },
    handlers: { response(response: NativeHttpResponse): void; error(error: unknown): void },
  ): NativeHttpRequestHandle;
}

function nodeResponse(response: IncomingMessage): NativeHttpResponse {
  return {
    statusCode: response.statusCode ?? 0,
    onData: (listener) => response.on('data', listener),
    onEnd: (listener) => response.on('end', listener),
    onError: (listener) => response.on('error', listener),
  };
}

export const nodeHttpClient: NativeHttpClient = {
  request(options, handlers) {
    const url = options.port.length > 0
      ? { ...options, port: Number(options.port) }
      : options;
    const requester = options.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requester(url, (response) => handlers.response(nodeResponse(response)));
    req.on('error', handlers.error);
    return {
      write: (bytes, onAccepted) => req.write(bytes, onAccepted),
      end: () => req.end(),
      abort: () => req.destroy(),
    };
  },
};

function headerExists(headers: Record<string, string>, wanted: string): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === wanted.toLowerCase());
}

function headerPart(value: string): string {
  return value.replace(/[\r\n"]/g, '_');
}

export interface EncodedPrinterBody {
  bytes: Uint8Array;
  contentType?: string;
}

/** Encode the structured-clone body without using renderer-only BodyInit types. */
export function encodePrinterTransportBody(body: PrinterTransportBody, boundary = '----OrcaSlicerNeoBoundary'): EncodedPrinterBody {
  if (body.kind === 'json') return { bytes: new TextEncoder().encode(body.json), contentType: 'application/json' };
  const chunks: Uint8Array[] = [];
  const text = (value: string) => chunks.push(new TextEncoder().encode(value));
  for (const [name, value] of Object.entries(body.fields)) {
    text(`--${boundary}\r\nContent-Disposition: form-data; name="${headerPart(name)}"\r\n\r\n${value}\r\n`);
  }
  text(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${headerPart(body.file.fileName)}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  chunks.push(body.file.bytes.slice());
  text(`\r\n--${boundary}--\r\n`);
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, contentType: `multipart/form-data; boundary=${boundary}` };
}

function invalidRequest(): Error { return new Error('Invalid printer request'); }

function validRequest(value: unknown): value is PrinterTransportIpcRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  if ((request.method !== 'GET' && request.method !== 'POST') || typeof request.url !== 'string') return false;
  if (request.headers !== undefined && (!request.headers || typeof request.headers !== 'object' ||
      Object.values(request.headers as Record<string, unknown>).some((header) => typeof header !== 'string'))) return false;
  const body = request.body as Record<string, unknown> | undefined;
  if (body === undefined) return true;
  if (!body || typeof body !== 'object') return false;
  if (body.kind === 'json') return typeof body.json === 'string';
  if (body.kind !== 'multipart' || !body.fields || typeof body.fields !== 'object') return false;
  if (Object.values(body.fields as Record<string, unknown>).some((field) => typeof field !== 'string')) return false;
  const file = body.file as Record<string, unknown> | undefined;
  return Boolean(file && typeof file.fileName === 'string' && file.bytes instanceof Uint8Array);
}

interface ActiveRequest {
  handle: NativeHttpRequestHandle;
  settled: boolean;
  reject: (reason?: unknown) => void;
}

export interface PrinterTransportIpcDependencies {
  isCurrentRenderer(sender: unknown): boolean;
  sendProgress(sender: unknown, requestId: string, progress: PrinterTransportProgress): void;
  client?: NativeHttpClient;
}

/** Main-process request handlers. Request state is scoped to the sender. */
export function createPrinterTransportIpcHandlers(deps: PrinterTransportIpcDependencies) {
  const active = new Map<unknown, Map<string, ActiveRequest>>();
  const client = deps.client ?? nodeHttpClient;
  const requestsFor = (sender: unknown) => {
    let requests = active.get(sender);
    if (!requests) { requests = new Map(); active.set(sender, requests); }
    return requests;
  };
  return {
    request(sender: unknown, requestId: unknown, payload: unknown): Promise<PrinterTransportIpcResponse> {
      if (!deps.isCurrentRenderer(sender)) return Promise.reject(new Error('printer transport IPC sender rejected'));
      if (typeof requestId !== 'string' || requestId.length === 0 || !validRequest(payload)) return Promise.reject(invalidRequest());
      let url: URL;
      try { url = new URL(payload.url); } catch { return Promise.reject(invalidRequest()); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return Promise.reject(invalidRequest());
      const protocol: 'http:' | 'https:' = url.protocol === 'https:' ? 'https:' : 'http:';
      const headers: Record<string, string> = { ...(payload.headers ?? {}) };
      let encoded: EncodedPrinterBody | undefined;
      if (payload.body) {
        encoded = encodePrinterTransportBody(payload.body);
        if (!headerExists(headers, 'content-type') && encoded.contentType) headers['Content-Type'] = encoded.contentType;
        if (!headerExists(headers, 'content-length')) headers['Content-Length'] = String(encoded.bytes.byteLength);
      }
      const requestHeaders = headers;
      return new Promise((resolve, reject) => {
        let responseBody: Uint8Array[] = [];
        const requests = requestsFor(sender);
        if (requests.has(requestId)) { reject(new Error('Duplicate printer request ID')); return; }
        const finish = (fn: () => void) => {
          const state = requests.get(requestId);
          if (!state || state.settled) return;
          state.settled = true;
          requests.delete(requestId);
          if (requests.size === 0) active.delete(sender);
          fn();
        };
        const state: ActiveRequest = {
          handle: { write() {}, end() {}, abort() {} },
          settled: false,
          reject,
        };
        requests.set(requestId, state);
        let handle: NativeHttpRequestHandle;
        try {
          handle = client.request({
          method: payload.method,
          protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          headers: requestHeaders,
        }, {
          response: (response) => {
            response.onData((chunk) => {
              responseBody.push(new Uint8Array(chunk));
            });
            response.onError(() => finish(() => reject(new Error('Printer request failed'))));
            response.onEnd(() => finish(() => {
              if (response.statusCode < 200 || response.statusCode >= 300) { resolve({ status: response.statusCode }); return; }
              const size = responseBody.reduce((total, item) => total + item.byteLength, 0);
              const bytes = new Uint8Array(size);
              let offset = 0;
              for (const chunk of responseBody) { bytes.set(chunk, offset); offset += chunk.byteLength; }
              let json: unknown;
              try { json = bytes.byteLength === 0 ? undefined : JSON.parse(new TextDecoder().decode(bytes)); }
              catch { resolve({ status: response.statusCode, jsonError: true }); return; }
              resolve({ status: response.statusCode, json });
            }));
          },
          error: () => finish(() => reject(new Error('Printer request failed'))),
          });
        } catch {
          finish(() => reject(new Error('Printer request failed')));
          return;
        }
        state.handle = handle;
        if (state.settled) return;
        if (encoded) {
          // Native request progress is reported as bytes are accepted by the
          // destination. The initial zero event makes the IPC pathway usable
          // with clients that do not emit response data.
          if (deps.isCurrentRenderer(sender)) deps.sendProgress(sender, requestId, { loaded: 0, total: encoded.bytes.byteLength });
          handle.write(encoded.bytes, () => {
            if (deps.isCurrentRenderer(sender)) deps.sendProgress(sender, requestId, { loaded: encoded!.bytes.byteLength, total: encoded!.bytes.byteLength });
          });
        }
        handle.end();
      });
    },
    cancel(sender: unknown, requestId: unknown): void {
      if (!deps.isCurrentRenderer(sender) || typeof requestId !== 'string') return;
      const requests = active.get(sender);
      const state = requests?.get(requestId);
      if (!state || state.settled) return;
      state.reject(new Error('Printer request failed'));
      state.handle.abort();
      state.settled = true;
      requests?.delete(requestId);
      if (requests?.size === 0) active.delete(sender);
    },
  };
}
