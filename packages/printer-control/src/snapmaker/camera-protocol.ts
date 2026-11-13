/** U1 camera control. Source URLs and temporary authorization stay provider-private. */
import type { PrinterConfiguration, PrinterTransport, PrinterWebSocket, PrinterWebSocketTransport, PrinterError } from '@orca/platform-contract';
import { endpoint, fail, MoonrakerFailure, record } from '../moonraker-http';

const REQUEST_TIMEOUT_MS = 5000;
interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: MoonrakerFailure): void;
}
export interface U1CameraControlOptions {
  http: PrinterTransport;
  sockets: PrinterWebSocketTransport;
  clientId: string;
  signal?: AbortSignal;
}
const failure = (code: PrinterError['code'], message: string) => new MoonrakerFailure({ code, message });

function deadline(caller?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return { signal: AbortSignal.any([controller.signal, ...(caller ? [caller] : [])]), dispose: () => clearTimeout(timer) };
}
function interrupted(signal?: AbortSignal): MoonrakerFailure {
  return failure(signal?.aborted ? 'cancelled' : 'transport', 'Camera request interrupted.');
}

/** Applies a deadline without depending on a transport honoring cancellation. */
async function bounded<T>(operation: Promise<T>, signal: AbortSignal, caller?: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(interrupted(caller));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

function cameraImageUrl(base: string, source: unknown): string {
  if (typeof source !== 'string' || !source) fail('device-failed', 'Invalid camera image location.');
  const root = new URL(endpoint(base, '/server/files/'));
  let url: URL;
  try {
    url = new URL(source, source.startsWith('/files/') ? base : undefined);
    if (source.startsWith('/files/')) url.pathname = `${new URL(base).pathname.replace(/\/$/, '')}/server${url.pathname}`;
  } catch { fail('device-failed', 'Invalid camera image location.'); }
  if (url.origin !== root.origin || url.username || url.password || url.hash || !url.pathname.startsWith(root.pathname)) {
    fail('device-failed', 'Invalid camera image location.');
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
    if (path.includes('\\') || path.split('/').some(part => part === '.' || part === '..')) {
      fail('device-failed', 'Invalid camera image location.');
    }
  } catch { fail('device-failed', 'Invalid camera image location.'); }
  if (path.toLowerCase().endsWith('.enc')) fail('no-compatible-media', 'Encrypted camera images are unsupported.');
  return url.href;
}

/** One authenticated connection, with a stable monitor identity across start/renew/stop. */
export class U1CameraControl {
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: MoonrakerFailure) => void;
  private ended: MoonrakerFailure | undefined;
  private endResolve!: () => void;
  readonly closed: Promise<void>;
  get connected(): boolean { return !this.ended && this.socket.readyState === 1; }

  private constructor(private readonly socket: PrinterWebSocket, private readonly base: string, readonly clientId: string) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.closed = new Promise(resolve => { this.endResolve = resolve; });
    socket.addEventListener('open', this.onOpen);
    socket.addEventListener('message', this.onMessage);
    socket.addEventListener('error', this.onError);
    socket.addEventListener('close', this.onClose);
    if (socket.readyState === 1) this.readyResolve();
    if (socket.readyState > 1) this.finish(failure('transport', 'Camera connection closed.'));
  }

  static async connect(printer: Pick<PrinterConfiguration, 'apiBaseUrl' | 'apiKey'>, options: U1CameraControlOptions): Promise<U1CameraControl> {
    if (typeof options.clientId !== 'string' || !options.clientId) {
      fail('invalid-request', 'Invalid camera client identity.');
    }
    let base: URL;
    try { base = new URL(printer.apiBaseUrl); }
    catch { fail('invalid-request', 'Invalid camera connection.'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) fail('invalid-request', 'Invalid camera connection.');
    const scope = deadline(options.signal);
    try {
      const signal = scope.signal;
      if (signal.aborted) throw interrupted(options.signal);
      const url = new URL(endpoint(base.href, '/websocket'));
      url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      if (printer.apiKey) {
        let response;
        try {
          response = await bounded(options.http.request({ method: 'GET', url: endpoint(base.href, '/access/oneshot_token'),
          headers: { 'X-Api-Key': printer.apiKey }, signal }), signal, options.signal);
        } catch (error) {
          if (error instanceof MoonrakerFailure) throw error;
          throw interrupted(options.signal);
        }
        if (response.status === 401) fail('authentication-required', 'Camera authentication required.');
        if (response.status === 403) fail('permission-denied', 'Camera access denied.');
        if (response.status < 200 || response.status >= 300) fail('transport', 'Camera authorization failed.');
        let token: unknown;
        try { token = record(await bounded(response.json(), signal, options.signal)).result; }
        catch (error) {
          if (error instanceof MoonrakerFailure) throw error;
          fail('device-failed', 'Invalid camera authorization response.');
        }
        if (typeof token !== 'string' || !token) fail('device-failed', 'Invalid camera authorization response.');
        url.searchParams.set('token', token);
      }
      if (signal.aborted) throw interrupted(options.signal);
      let control: U1CameraControl;
      try { control = new U1CameraControl(options.sockets.create(url.href), base.href, options.clientId); }
      catch { throw interrupted(options.signal); }
      try { await bounded(control.ready, signal, options.signal); return control; }
      catch (error) { control.close(); throw error; }
    } finally { scope.dispose(); }
  }

  private readonly onOpen = () => this.readyResolve();
  private readonly onClose = () => this.finish(failure('transport', 'Camera connection closed.'));
  private readonly onError = () => this.finish(failure('transport', 'Camera connection failed.'));
  private readonly onMessage = (event: Event) => {
    const data: unknown = (event as MessageEvent).data;
    if (typeof data !== 'string') {
      this.finish(failure('device-failed', 'Invalid camera control response.')); return;
    }
    let response: Record<string, unknown>;
    try { response = record(JSON.parse(data)); }
    catch { this.finish(failure('device-failed', 'Invalid camera control response.')); return; }
    if (typeof response.id !== 'number') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.jsonrpc !== '2.0') { pending.reject(failure('device-failed', 'Invalid camera control response.')); return; }
    if ('error' in response) {
      const code = record(response.error).code;
      if (code === -32601) pending.reject(failure('unsupported', 'Camera monitoring is unsupported by this device.'));
      else if (code === 401) {
        pending.reject(failure('authentication-required', 'Camera authentication required.'));
      } else if (code === 403) pending.reject(failure('permission-denied', 'Camera access denied.'));
      else pending.reject(failure('device-rejected', 'Device rejected camera monitoring.'));
      return;
    }
    const result = record(response.result);
    if (result.state !== 'success') { pending.reject(failure('device-rejected', 'Device rejected camera monitoring.')); return; }
    pending.resolve(result);
  };

  private finish(error: MoonrakerFailure): void {
    if (this.ended) return;
    this.ended = error;
    this.readyReject(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.socket.removeEventListener('open', this.onOpen);
    this.socket.removeEventListener('message', this.onMessage);
    this.socket.removeEventListener('error', this.onError);
    this.socket.removeEventListener('close', this.onClose);
    this.endResolve();
    try { this.socket.close(); } catch { /* local retirement is unconditional */ }
  }

  private async request(method: string, params: Record<string, unknown>, caller?: AbortSignal): Promise<Record<string, unknown>> {
    if (caller?.aborted) throw interrupted(caller);
    if (this.ended) throw this.ended;
    const id = ++this.nextId, scope = deadline(caller);
    const response = new Promise<Record<string, unknown>>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    try {
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    } catch { this.finish(failure('transport', 'Camera request failed.')); }
    try { return await bounded(response, scope.signal, caller); }
    finally { scope.dispose(); this.pending.delete(id); }
  }

  /** A repeated start renews the monitor. Returned URL is private acquisition data. */
  async start(signal?: AbortSignal): Promise<string> {
    const result = await this.request('camera.start_monitor', { domain: 'lan', interval: 0, expect_pw: true, clientid: this.clientId }, signal);
    return cameraImageUrl(this.base, result.url);
  }
  async stop(signal?: AbortSignal): Promise<void> {
    await this.request('camera.stop_monitor', { domain: 'lan', clientid: this.clientId }, signal);
  }
  listTimelapses(page: number, rows: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const requestId = crypto.getRandomValues(new Uint32Array(1))[0];
    return this.request('camera.get_timelapse_instance', { req_id: requestId, page_index: page, page_rows: rows, thumbnail_direct: false }, signal);
  }
  async deleteTimelapse(dateIndex: string, signal?: AbortSignal): Promise<void> {
    const requestId = crypto.getRandomValues(new Uint32Array(1))[0];
    await this.request('camera.delete_timelapse_instance', { req_id: requestId, date_index: dateIndex }, signal);
  }
  close(): void { this.finish(failure('cancelled', 'Camera connection closed.')); }
}

/** Acquire a JPEG and validate its framing before media delivery. */
export async function readU1CameraFrame(printer: Pick<PrinterConfiguration, 'apiKey'>, source: string, http: PrinterTransport, caller?: AbortSignal): Promise<Uint8Array> {
  const scope = deadline(caller);
  try {
    if (scope.signal.aborted) throw interrupted(caller);
    const url = new URL(source);
    url.searchParams.set('_nocache', `${Date.now()}-${crypto.randomUUID()}`);
    const response = await bounded(http.request({ method: 'GET', url: url.href, responseType: 'bytes',
      signal: scope.signal,
      headers: printer.apiKey ? { 'X-Api-Key': printer.apiKey } : {} }), scope.signal, caller);
    if (response.status === 401) fail('authentication-required', 'Camera authentication required.');
    if (response.status === 403) fail('permission-denied', 'Camera access denied.');
    if (response.status < 200 || response.status >= 300) fail('transport', 'Camera image unavailable.');
    const bytes = await bounded(response.bytes(), scope.signal, caller);
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216
      || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail('device-failed', 'Invalid camera JPEG frame.');
    return bytes;
  } catch (error) {
    if (error instanceof MoonrakerFailure) throw error;
    throw interrupted(caller);
  } finally { scope.dispose(); }
}
