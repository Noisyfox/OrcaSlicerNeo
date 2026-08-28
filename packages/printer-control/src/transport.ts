export type PrinterHttpMethod = 'GET' | 'POST';

export interface PrinterJsonBody {
  kind: 'json';
  /** Serialized JSON; the host chooses its request implementation. */
  json: string;
}

export interface PrinterMultipartBody {
  kind: 'multipart';
  fields: Readonly<Record<string, string>>;
  file: {
    fileName: string;
    bytes: Uint8Array;
  };
}

/** Structured-clone-safe request bodies for browser and Electron transports. */
export type PrinterTransportBody = PrinterJsonBody | PrinterMultipartBody;

export interface PrinterTransportRequest {
  method: PrinterHttpMethod;
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: PrinterTransportBody;
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
