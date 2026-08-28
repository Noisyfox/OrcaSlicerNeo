import type {
  PrinterTransport,
  PrinterTransportRequest,
  PrinterTransportResponse,
} from '@orca/printer-control';
import type { ElectronBridge, PrinterTransportIpcRequest } from '../../../shared/ipc';

function abortError(): DOMException {
  return new DOMException('The printer request was cancelled', 'AbortError');
}

/** Renderer-side transport: only structured data crosses the preload seam. */
export class ElectronPrinterTransport implements PrinterTransport {
  private nextId = 0;

  constructor(private readonly host: Pick<ElectronBridge, 'printers'>) {}

  request(request: PrinterTransportRequest): Promise<PrinterTransportResponse> {
    const requestId = `printer-request-${++this.nextId}`;
    const payload: PrinterTransportIpcRequest = {
      method: request.method,
      url: request.url,
      ...(request.headers ? { headers: { ...request.headers } } : {}),
      ...(request.body ? { body: request.body } : {}),
    };
    let removeProgress: (() => void) | undefined;
    let removeAbort: (() => void) | undefined;
    const cleanup = () => {
      removeProgress?.();
      removeAbort?.();
      removeProgress = undefined;
      removeAbort = undefined;
    };
    const promise = new Promise<PrinterTransportResponse>((resolve, reject) => {
      removeProgress = this.host.printers.transport.onProgress((id, progress) => {
        if (id !== requestId) return;
        try { request.onUploadProgress?.(progress); } catch { /* observers cannot break IPC */ }
      });
      const onAbort = () => {
        void this.host.printers.transport.cancel(requestId).catch(() => undefined);
        reject(abortError());
      };
      if (request.signal?.aborted) { onAbort(); return; }
      request.signal?.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => request.signal?.removeEventListener('abort', onAbort);
      void this.host.printers.transport.request(requestId, payload)
        .then((response) => {
          if (request.signal?.aborted) { reject(abortError()); return; }
          resolve({
            status: response.status,
            async json() {
              if (response.jsonError) throw new Error('Printer request returned invalid JSON');
              return response.json;
            },
          });
        })
        .catch(() => reject(request.signal?.aborted ? abortError() : new Error('Printer request failed')));
    });
    return promise.finally(cleanup);
  }
}

export function createElectronPrinterTransport(host: Pick<ElectronBridge, 'printers'>): PrinterTransport {
  return new ElectronPrinterTransport(host);
}
