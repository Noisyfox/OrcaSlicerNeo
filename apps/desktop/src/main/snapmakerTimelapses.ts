import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { deleteU1Timelapse, readU1TimelapsePage, u1TimelapseVideoUrl, type PrinterConfiguration, type PrinterConfigurationDocument } from '@orca/printer-control';
import type { ErrorCode, Result } from '@orca/printer-control/domain';
import { cameraConfigurationDigest, cameraConfigurationKey } from '../shared/snapmakerCamera';
import { printerMediaScheme } from '../shared/printerMedia';
import { cameraHttpTransport } from '../utility/snapmaker/http';

const failure = (code: ErrorCode, message: string): Result<never> => ({ ok: false, error: { code, message } });
const object = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\da-f-]{36}$/i.test(id);
type ReadOwner = { sender: WebContents; abort: AbortController };
type Video = ReadOwner & { origin: string; printer: PrinterConfiguration; url: string };

/** Validate saved routes in main and relay only document-owned U1 video URLs. */
export class SnapmakerTimelapseHost {
  private readonly requests = new Map<string, ReadOwner>();
  private readonly videos = new Map<string, Video>();
  private readonly watched = new WeakSet<WebContents>();
  private configurationEpoch = 0;

  constructor(private readonly load: () => Promise<PrinterConfigurationDocument>, private readonly isRenderer: (sender: WebContents) => boolean) {}

  private retire(sender?: WebContents) {
    for (const registry of [this.requests, this.videos]) {
      for (const [id, owner] of registry) {
        if (!sender || sender === owner.sender) {
          owner.abort.abort(); registry.delete(id);
        }
      }
    }
  }

  configurationChanged(): void { this.configurationEpoch++; this.retire(); }

  async call(event: IpcMainInvokeEvent, value: unknown): Promise<unknown> {
    const sender = event.sender, frame = event.senderFrame;
    if (!this.isRenderer(sender) || !frame || frame !== sender.mainFrame) return failure('invalid-target', 'Timelapse request rejected.');
    if (!this.watched.has(sender)) {
      this.watched.add(sender);
      sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) this.retire(sender); });
      sender.on('render-process-gone', () => this.retire(sender));
      sender.once('destroyed', () => this.retire(sender));
    }
    const { method, input: raw } = object(value), input = object(raw);
    if (method === 'cancel' || method === 'close') {
      const registry = method === 'cancel' ? this.requests : this.videos;
      if (validId(input.id)) {
        const owner = registry.get(input.id);
        if (owner?.sender === sender) { owner.abort.abort(); registry.delete(input.id); }
      }
      return { ok: true, value: null };
    }
    if ((method !== 'list' && method !== 'open' && method !== 'delete') || typeof input.printerId !== 'string' || typeof input.configurationDigest !== 'string')
      return failure('invalid-request', 'Invalid U1 timelapse request.');
    const requestId = input.id, page = input.page, rows = input.rows;
    const abort = new AbortController(), epoch = this.configurationEpoch;
    if (method === 'list') {
      if (!validId(requestId) || this.requests.has(requestId) || typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 ||
        typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 1 || rows > 20)
        return failure('invalid-request', 'Invalid U1 timelapse page.');
      this.requests.set(requestId, { sender, abort });
    }
    try {
      const printer = (await this.load()).printers.find(item => item.id === input.printerId && item.driverId === 'snapmaker');
      if (!printer || await cameraConfigurationDigest(printer) !== input.configurationDigest || epoch !== this.configurationEpoch)
        return failure('stale-context', 'The U1 connection changed. Refresh Storage.');
      if (abort.signal.aborted || frame.detached || !this.isRenderer(sender)) return failure('cancelled', 'Timelapse request cancelled.');
      if (method === 'list') {
        const list = await readU1TimelapsePage(printer, page as number, rows as number,
          { http: cameraHttpTransport, sockets: { create: url => new WebSocket(url) } }, abort.signal);
        return { ok: true, value: list };
      }
      if (method === 'delete') {
        if (typeof input.dateIndex !== 'string') return failure('invalid-request', 'Invalid U1 timelapse index.');
        return await deleteU1Timelapse(printer, input.dateIndex,
          { http: cameraHttpTransport, sockets: { create: url => new WebSocket(url) } }, abort.signal);
      }
      if (typeof input.video !== 'string' || input.video.length > 4096) return failure('invalid-request', 'Invalid U1 video.');
      const url = u1TimelapseVideoUrl(printer, input.video);
      for (const [id, video] of this.videos) {
        if (video.sender === sender) { video.abort.abort(); this.videos.delete(id); }
      }
      const id = randomUUID();
      this.videos.set(id, { sender, origin: new URL(frame.url).origin, printer, url, abort });
      return { ok: true, value: { id, url: `${printerMediaScheme}://video/${id}` } };
    } catch (error) {
      if (abort.signal.aborted) return failure('cancelled', 'Timelapse request cancelled.');
      const detail = object(object(error).detail);
      if (typeof detail.code === 'string' && typeof detail.message === 'string') return { ok: false, error: detail };
      return failure('transport', 'Could not access U1 timelapses.');
    } finally {
      if (validId(requestId) && this.requests.get(requestId)?.abort === abort) this.requests.delete(requestId);
    }
  }

  async serve(request: Request & { initiatorOrigin?: string | null }): Promise<Response> {
    const url = new URL(request.url), id = url.pathname.slice(1);
    const video = url.host === 'video' && !url.search && !url.hash && validId(id) ? this.videos.get(id) : undefined;
    const origin = request.initiatorOrigin ?? request.headers.get('origin');
    // Chromium's media loader can omit the origin. Its URL is an unguessable,
    // document-owned grant which expires when that document is retired.
    if (!video || video.sender.isDestroyed() || !this.isRenderer(video.sender) ||
      (origin !== null && origin !== video.origin) || !['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 404 });
    const headers = new Headers({ 'access-control-allow-origin': video.origin, 'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'no-store' });
    const range = request.headers.get('range');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return new Response(null, { status: 416, headers });
    const connection = new AbortController();
    const timeout = setTimeout(() => connection.abort(), 15_000);
    try {
      const current = (await this.load()).printers.find(printer => printer.id === video.printer.id);
      if (!current || cameraConfigurationKey(current) !== cameraConfigurationKey(video.printer)) return new Response(null, { status: 409, headers });
      const response = await fetch(video.url, { method: request.method, redirect: 'error',
        signal: AbortSignal.any([request.signal, video.abort.signal, connection.signal]),
        headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}), ...(current.apiKey ? { 'X-Api-Key': current.apiKey } : {}) } });
      if (![200, 206, 416].includes(response.status) || (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity')) {
        void response.body?.cancel().catch(() => undefined);
        return new Response(null, { status: 502, headers });
      }
      for (const key of ['accept-ranges', 'content-length', 'content-range']) {
        const value = response.headers.get(key);
        if (value) headers.set(key, value);
      }
      headers.set('content-type', 'video/mp4');
      return new Response(response.body, { status: response.status, headers });
    } catch { return new Response(null, { status: 502, headers }); }
    finally { clearTimeout(timeout); }
  }
}
