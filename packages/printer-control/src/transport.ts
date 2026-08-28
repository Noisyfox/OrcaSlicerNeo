export type PrinterHttpMethod = 'GET' | 'POST';

export interface PrinterTransportRequest {
  method: PrinterHttpMethod;
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: BodyInit;
  signal?: AbortSignal;
  onUploadProgress?: (progress: { loaded: number; total?: number }) => void;
}

export interface PrinterTransportResponse {
  status: number;
  json(): Promise<unknown>;
}

/** Host-owned HTTP seam. Implementations may use fetch, Electron IPC, or a test fixture. */
export interface PrinterTransport {
  request(request: PrinterTransportRequest): Promise<PrinterTransportResponse>;
}
