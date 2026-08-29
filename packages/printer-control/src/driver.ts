import type { PrinterConfiguration } from './configuration';
import type { PrinterTransport, PrinterTransportRequest, PrinterTransportResponse } from './transport';

export interface GcodeUpload {
  bytes: Uint8Array;
  /** The local filename sent as the multipart file name. */
  fileName: string;
}

export interface UploadProgress {
  loaded: number;
  total?: number;
  fraction?: number;
}

export type ProgressSink = (progress: UploadProgress) => void;

export interface UploadedGcode {
  /** Moonraker's exact remote path, used unchanged by startPrint. */
  remotePath: string;
  /** Alias useful to callers that model a remote file as a path. */
  path: string;
  fileName: string;
}

export interface PrinterConnectionInfo {
  machineName?: string;
  version?: string;
  klippyState?: string;
  raw: unknown;
}

export interface PrinterStatus {
  state: string;
  raw: unknown;
}

export type PrinterOperation = 'connection' | 'status' | 'upload' | 'start' | 'pause' | 'resume' | 'cancel';
export type PrinterOperationErrorCode = 'transport' | 'http' | 'protocol' | 'aborted' | 'start-failed-after-upload';

export class PrinterControlError extends Error {
  constructor(
    readonly code: PrinterOperationErrorCode,
    message: string,
    readonly operation: PrinterOperation,
    readonly status?: number,
    readonly uploaded?: UploadedGcode,
  ) {
    super(message);
    this.name = 'PrinterControlError';
  }
}

export interface PrinterApiDriver {
  readonly id: string;
  readonly displayName: string;
  testConnection(printer: PrinterConfiguration, signal?: AbortSignal): Promise<PrinterConnectionInfo>;
  getStatus(printer: PrinterConfiguration, signal?: AbortSignal): Promise<PrinterStatus>;
  uploadGcode(printer: PrinterConfiguration, input: GcodeUpload, progress?: ProgressSink, signal?: AbortSignal): Promise<UploadedGcode>;
  startPrint(printer: PrinterConfiguration, remoteFile: UploadedGcode, signal?: AbortSignal): Promise<void>;
  pausePrint(printer: PrinterConfiguration, signal?: AbortSignal): Promise<void>;
  resumePrint(printer: PrinterConfiguration, signal?: AbortSignal): Promise<void>;
  cancelPrint(printer: PrinterConfiguration, signal?: AbortSignal): Promise<void>;
}

function joinEndpoint(baseUrl: string, endpoint: string): string {
  const base = new URL(baseUrl);
  const [path, search = ''] = endpoint.split('?', 2);
  base.pathname = `${base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`}${path.replace(/^\/+/, '')}`;
  base.search = search ? `?${search}` : '';
  base.hash = '';
  return base.href;
}

function authHeaders(printer: PrinterConfiguration): Record<string, string> {
  return printer.apiKey.length > 0 ? { 'X-Api-Key': printer.apiKey } : {};
}

function operationMessage(operation: PrinterOperation): string {
  return `Moonraker ${operation} request failed`;
}

async function requestJson(
  transport: PrinterTransport,
  request: PrinterTransportRequest,
  operation: PrinterOperation,
): Promise<unknown> {
  try {
    const response = await transport.request(request);
    if (response.status < 200 || response.status >= 300) {
      throw new PrinterControlError('http', operationMessage(operation), operation, response.status);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof PrinterControlError) throw error;
    if (request.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new PrinterControlError('aborted', `${operationMessage(operation)} was cancelled`, operation);
    }
    // Never propagate transport-provided text: it may contain an authorization value.
    throw new PrinterControlError('transport', operationMessage(operation), operation);
  }
}

function resultOf(payload: unknown): unknown {
  return payload && typeof payload === 'object' && 'result' in payload
    ? (payload as { result: unknown }).result : payload;
}

function remotePathOf(payload: unknown): string | undefined {
  const result = resultOf(payload);
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  const item = record.item && typeof record.item === 'object' ? record.item as Record<string, unknown> : undefined;
  for (const candidate of [item?.path, record.path, item?.filename, record.filename]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

export class MoonrakerDriver implements PrinterApiDriver {
  readonly id = 'moonraker' as const;
  readonly displayName = 'Moonraker';

  constructor(private readonly transport: PrinterTransport) {}

  async testConnection(printer: PrinterConfiguration, signal?: AbortSignal): Promise<PrinterConnectionInfo> {
    const payload = await requestJson(this.transport, {
      method: 'GET',
      url: joinEndpoint(printer.apiBaseUrl, '/server/info'),
      headers: authHeaders(printer),
      signal,
    }, 'connection');
    const result = resultOf(payload);
    if (!result || typeof result !== 'object') {
      throw new PrinterControlError('protocol', 'Moonraker returned an invalid server-info response', 'connection');
    }
    const data = result as Record<string, unknown>;
    return {
      machineName: typeof data.machine_name === 'string' ? data.machine_name : typeof data.hostname === 'string' ? data.hostname : undefined,
      version: typeof data.moonraker_version === 'string' ? data.moonraker_version : undefined,
      klippyState: typeof data.klippy_state === 'string' ? data.klippy_state : undefined,
      raw: payload,
    };
  }

  async getStatus(printer: PrinterConfiguration, signal?: AbortSignal): Promise<PrinterStatus> {
    const payload = await requestJson(this.transport, {
      method: 'GET',
      url: joinEndpoint(printer.apiBaseUrl, '/printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed&fan'),
      headers: authHeaders(printer),
      signal,
    }, 'status');
    const result = resultOf(payload);
    if (!result || typeof result !== 'object') throw new PrinterControlError('protocol', 'Moonraker returned an invalid status response', 'status');
    const status = (result as Record<string, unknown>).status;
    if (!status || typeof status !== 'object') throw new PrinterControlError('protocol', 'Moonraker returned an invalid status response', 'status');
    const printStats = (status as Record<string, unknown>).print_stats;
    const state = printStats && typeof printStats === 'object' && typeof (printStats as Record<string, unknown>).state === 'string'
      ? (printStats as Record<string, string>).state : 'unknown';
    return { state, raw: status };
  }

  async uploadGcode(printer: PrinterConfiguration, input: GcodeUpload, progress?: ProgressSink, signal?: AbortSignal): Promise<UploadedGcode> {
    const payload = await requestJson(this.transport, {
      method: 'POST',
      url: joinEndpoint(printer.apiBaseUrl, '/server/files/upload'),
      headers: authHeaders(printer),
      body: {
        kind: 'multipart',
        fields: { root: 'gcodes' },
        file: { fileName: input.fileName, bytes: new Uint8Array(input.bytes) },
      },
      signal,
      onUploadProgress: progress ? ({ loaded, total }) => progress({ loaded, total, fraction: total ? loaded / total : undefined }) : undefined,
    }, 'upload');
    const remotePath = remotePathOf(payload);
    if (!remotePath) throw new PrinterControlError('protocol', 'Moonraker upload response did not contain a remote path', 'upload');
    return { remotePath, path: remotePath, fileName: input.fileName };
  }

  async startPrint(printer: PrinterConfiguration, remoteFile: UploadedGcode, signal?: AbortSignal): Promise<void> {
    await requestJson(this.transport, {
      method: 'POST',
      url: joinEndpoint(printer.apiBaseUrl, '/printer/print/start'),
      headers: { ...authHeaders(printer), 'Content-Type': 'application/json' },
      body: { kind: 'json', json: JSON.stringify({ filename: remoteFile.remotePath }) },
      signal,
    }, 'start');
  }

  private async sendGcode(printer: PrinterConfiguration, command: 'PAUSE' | 'RESUME' | 'CANCEL_PRINT', operation: 'pause' | 'resume' | 'cancel', signal?: AbortSignal): Promise<void> {
    await requestJson(this.transport, {
      method: 'POST',
      url: joinEndpoint(printer.apiBaseUrl, '/printer/gcode/script'),
      headers: { ...authHeaders(printer), 'Content-Type': 'application/json' },
      body: { kind: 'json', json: JSON.stringify({ script: command }) },
      signal,
    }, operation);
  }

  pausePrint(printer: PrinterConfiguration, signal?: AbortSignal): Promise<void> { return this.sendGcode(printer, 'PAUSE', 'pause', signal); }
  resumePrint(printer: PrinterConfiguration, signal?: AbortSignal): Promise<void> { return this.sendGcode(printer, 'RESUME', 'resume', signal); }
  cancelPrint(printer: PrinterConfiguration, signal?: AbortSignal): Promise<void> { return this.sendGcode(printer, 'CANCEL_PRINT', 'cancel', signal); }
}
