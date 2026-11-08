import type {
  PrinterTransport,
  PrinterTransportBody,
  PrinterTransportRequest,
  PrinterTransportResponse,
} from '@orca/printer-control';

function abortError(): DOMException {
  return new DOMException('The printer request was cancelled', 'AbortError');
}

function safeError(): Error {
  // XHR error objects and response text can contain request/authorization
  // details in some browsers. Keep the transport boundary deliberately terse.
  return new Error('Printer request failed');
}

function appendBody(form: FormData, body: PrinterTransportBody): FormData | string | undefined {
  if (body.kind === 'json') return body.json;
  for (const [name, value] of Object.entries(body.fields)) form.append(name, value);
  const bytes = body.file.bytes.slice();
  form.append('file', new Blob([bytes.buffer], { type: 'application/octet-stream' }), body.file.fileName);
  return form;
}

/** Browser HTTP transport with upload progress (fetch does not expose it). */
export class BrowserPrinterTransport implements PrinterTransport {
  request(request: PrinterTransportRequest): Promise<PrinterTransportResponse> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      const cleanup = () => {
        request.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error | DOMException = safeError()) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        try { xhr.abort(); } catch { /* an already-finished XHR is harmless */ }
        fail(abortError());
      };
      if (request.signal?.aborted) {
        fail(abortError());
        return;
      }
      request.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        xhr.open(request.method, request.url, true);
        xhr.responseType = request.responseType === 'bytes' ? 'arraybuffer' : 'text';
        const maximum = request.maxResponseBytes;
        if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1)) throw safeError();
        if (maximum !== undefined) xhr.addEventListener('progress', event => {
          if (event.loaded > maximum || event.lengthComputable && event.total > maximum) {
            fail(); xhr.abort();
          }
        });
        for (const [name, value] of Object.entries(request.headers ?? {})) xhr.setRequestHeader(name, value);
        if (request.body?.kind === 'json' && !Object.keys(request.headers ?? {}).some((name) => name.toLowerCase() === 'content-type')) {
          xhr.setRequestHeader('Content-Type', 'application/json');
        }
        if (request.onUploadProgress && request.body?.kind === 'multipart') {
          xhr.upload.addEventListener('progress', (event) => {
            try {
              request.onUploadProgress?.({ loaded: event.loaded, total: event.lengthComputable ? event.total : undefined });
            } catch { /* progress observers must not break the request */ }
          });
        }
        xhr.addEventListener('load', () => {
          if (settled) return;
          const status = xhr.status;
          const binary = request.responseType === 'bytes';
          const bytes = binary ? new Uint8Array(xhr.response as ArrayBuffer) : undefined;
          const text = binary ? '' : xhr.responseText;
          if (maximum !== undefined && (bytes?.byteLength ?? new TextEncoder().encode(text).byteLength) > maximum) {
            fail(); return;
          }
          settled = true;
          cleanup();
          resolve({
            status,
            async json() {
              try {
                return text.length === 0 ? undefined : JSON.parse(text) as unknown;
              } catch {
                throw safeError();
              }
            },
            async bytes() {
              if (!bytes) throw safeError();
              return bytes;
            },
          });
        });
        xhr.addEventListener('error', () => fail());
        xhr.addEventListener('abort', () => fail(abortError()));
        xhr.addEventListener('timeout', () => fail());
        const body = request.body ? appendBody(new FormData(), request.body) : undefined;
        xhr.send(body);
      } catch {
        fail();
      }
    });
  }
}

export function createBrowserPrinterTransport(): PrinterTransport {
  return new BrowserPrinterTransport();
}
