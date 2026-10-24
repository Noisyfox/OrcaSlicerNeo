import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadBambuCamera, type BambuNative, type NativeCamera } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import type { BambuHostConfig } from '../../shared/bambu';
import type { BambuMediaAttachment, BambuMediaRequest, BambuMediaStatus } from '../../shared/bambuMedia';
import type { BambuMonitor } from './monitor';
import type { BambuDevices } from './devices';
import type { BambuRepository } from './repository';
import { savedBambuPrinter } from '../../shared/bambuPrinters';
import { record } from './telemetry';
import { CameraMuxer } from './cameraMuxer';
import { CameraChannel, type CameraPort } from './mediaChannel';

const error = (code: D.ErrorCode, message: string): D.PrinterError => ({ code, message });
const failed = (detail: D.PrinterError) => ({ ok: false as const, error: detail });
const unavailable = () => error('transport', 'The LAN camera could not be reached.');
export function cameraProtocol(report: Record<string, unknown>): 'local' | 'rtsps' | 'rtsp' | 'disabled' | 'unavailable' | 'unknown' {
  const camera = record(report.ipcam), live = record(camera.liveview);
  if (camera.ipcam_dev === '0' || camera.ipcam_dev === 0) return 'unavailable';
  if (camera.rtsp_url === 'disable') return 'disabled';
  if (typeof camera.rtsp_url === 'string' && camera.rtsp_url.startsWith('rtsps://')) return 'rtsps';
  if (typeof camera.rtsp_url === 'string' && camera.rtsp_url.startsWith('rtsp://')) return 'rtsp';
  return ['local', 'rtsps', 'rtsp', 'disabled'].includes(String(live.local)) ? live.local as 'local' | 'rtsps' | 'rtsp' | 'disabled' : 'unknown';
}
interface Resource {
  owner: string; request: D.OpenMediaRequest; controller: AbortController; channel: CameraChannel;
  descriptor?: D.MediaDescriptor; status: 'ready' | 'interrupted' | 'closed'; error: D.PrinterError | null;
  camera?: NativeCamera; task?: Promise<void>; token?: string; attached: boolean; attachDeadline: number;
  connectionKey?: string; accountDependent: boolean; close?: Promise<void>;
}
/** One view per application. Metadata stays separate from the dedicated binary channel. */
export class BambuMedia {
  private active: Resource | null = null;
  private readonly resources = new Map<string, Resource>();
  private readonly requests = new Map<string, { fingerprint: string; until: number; result: Promise<D.Result<D.MediaDescriptor>> }>();
  private readonly retiredOwners = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(private readonly config: BambuHostConfig, private readonly native: BambuNative,
    private readonly monitor: { acquire: BambuMonitor['acquire']; stop: BambuMonitor['stop']; context(target: D.PrinterTarget): Promise<D.Result<{ report: Record<string, unknown> }>> },
    private readonly devices: Pick<BambuDevices, 'list'>, private readonly repository: Pick<BambuRepository, 'read'>,
    private readonly changed: () => void, private readonly load: typeof loadBambuCamera = loadBambuCamera) {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.requests) if (value.until < now) this.requests.delete(key);
      for (const [id, resource] of this.resources) {
        if (resource.status === 'closed' && resource.attachDeadline < now) this.resources.delete(id);
        else if (resource.descriptor && (resource.descriptor.expiresAtMs! < now || !resource.attached && resource.attachDeadline < now)) void this.release(resource, error('lease-expired', 'Camera access expired.'));
      }
    }, 1000); this.timer.unref();
  }
  private async connection(request: D.OpenMediaRequest) {
    const device = (await this.devices.list()).find(d => `bambu:${encodeURIComponent(d.deviceId)}` === request.target.printerId);
    if (!device) return null;
    const printer = savedBambuPrinter(device), route = printer.routes.find(r => r.id === request.target.routeId);
    if (!route) return null;
    const lan = (await this.repository.read()).lan.find(r => r.deviceId === device.deviceId && device.routes.some(d => d.channel === 'lan' && d.revision === r.revision));
    const cloud = device.routes.find(d => d.channel === 'cloud');
    return { device, route, lan, key: lan ? JSON.stringify([lan.deviceId, lan.ip, lan.revision]) : JSON.stringify([device.deviceId, cloud?.revision]) };
  }
  async reconcile() {
    const resource = this.active; if (!resource || !resource.connectionKey) return;
    const current = await this.connection(resource.request);
    if (!current || current.key !== resource.connectionKey) await this.release(resource, error('stale-context', 'The camera route or account changed.'));
  }
  private valid(owner: string, ref: D.MediaRef): Resource | undefined {
    const r = this.resources.get(ref.id);
    return r?.owner === owner && r.descriptor?.ref.printerId === ref.printerId && r.descriptor.ref.routeId === ref.routeId ? r : undefined;
  }
  async call(owner: string, request: BambuMediaRequest) {
    if (this.closing || this.retiredOwners.has(owner)) return failed(error('cancelled', 'The viewing document closed.'));
    if (request.method === 'open') return this.open(owner, request.input);
    const r = this.valid(owner, request.input);
    if (!r) return request.method === 'close' ? { ok: true as const, value: null } : failed(error('invalid-target', 'Camera resource unavailable.'));
    if (request.method === 'close') { await this.release(r); return { ok: true as const, value: null }; }
    if (request.method === 'renew') {
      if (r.status !== 'ready') return failed(r.error ?? error('lease-expired', 'Camera access expired.'));
      await this.reconcile();
      if (r.controller.signal.aborted) return failed(r.error ?? unavailable());
      r.descriptor = { ...r.descriptor!, revision: r.descriptor!.revision + 1, expiresAtMs: Date.now() + 300_000 };
      this.changed(); return { ok: true as const, value: r.descriptor };
    }
    return { ok: true as const, value: { descriptor: r.descriptor!, state: r.status, error: r.error } satisfies BambuMediaStatus };
  }
  open(owner: string, request: D.OpenMediaRequest): Promise<D.Result<D.MediaDescriptor>> {
    const key = `${owner}:${request.requestId}`, fingerprint = JSON.stringify(request);
    const previous = this.requests.get(key);
    if (previous && previous.until > Date.now()) return previous.fingerprint === fingerprint ? previous.result : Promise.resolve(failed(error('invalid-request', 'Camera request ID was reused.')));
    if (this.requests.size >= 128) return Promise.resolve(failed(error('busy', 'Too many camera requests.')));
    if (this.active) return Promise.resolve(failed(error('viewer-limit', 'Stop the current camera before opening another.')));
    const r: Resource = { owner, request, controller: new AbortController(), channel: new CameraChannel(() => { void this.release(r, error('stream-gap', 'Camera delivery was interrupted.')); }),
      status: 'ready', error: null, attached: false, attachDeadline: Date.now() + 10_000, accountDependent: false };
    this.active = r;
    const result = this.initialize(r).catch(async () => { await this.release(r, unavailable()); return failed(r.error ?? unavailable()); });
    this.requests.set(key, { fingerprint, until: Date.now() + 300_000, result });
    return result;
  }
  private async initialize(r: Resource): Promise<D.Result<D.MediaDescriptor>> {
    const signal = r.controller.signal, request = r.request;
    const reject = async (e: D.PrinterError) => { await this.release(r, e); return failed(e); };
    if (request.source.kind !== 'camera' || request.source.cameraId !== 'chamber' || request.source.profileId !== undefined) return reject(error('invalid-request', 'Unsupported camera selection.'));
    const connection = await this.connection(request);
    if (!connection) return reject(error('invalid-target', 'This printer route is unavailable.'));
    if (request.target.expectedConfigurationRevision !== undefined && request.target.expectedConfigurationRevision !== connection.route.configurationRevision) return reject(error('stale-context', 'Printer configuration changed.'));
    r.connectionKey = connection.key; r.accountDependent = !connection.lan;
    const lease = await this.monitor.acquire(request.target);
    if (!lease.ok) return reject(lease.error);
    if (signal.aborted) { await this.monitor.stop(lease.value); return reject(error('cancelled', 'Camera viewing stopped.')); }
    r.token = lease.value;
    const context = await this.monitor.context(request.target);
    if (!context.ok) return reject(context.error);
    const protocol = cameraProtocol(context.value.report);
    if (protocol === 'disabled') return reject(error('precondition-failed', 'LAN live view is disabled on the printer.'));
    if (protocol !== 'local' && protocol !== 'rtsps') return reject(error('unsupported', protocol === 'unavailable' ? 'The camera is unavailable.' : 'A supported LAN camera protocol has not been reported.'));
    const transport = protocol === 'local' ? 'jpeg-frames' : 'mse-fmp4';
    if (!request.client.video.some(v => v.transport === transport && v.codecIds.includes(protocol === 'local' ? 'jpeg' : 'h264'))) return reject(error('no-compatible-media', 'This host cannot play the camera format.'));
    await this.native.installDeviceCertificate(connection.device.deviceId, !!connection.lan);
    let url: string;
    if (connection.lan) {
      const ip = connection.lan.ip, password = encodeURIComponent(connection.lan.accessCode);
      url = protocol === 'rtsps' ? `bambu:///rtsps___bblp:${password}@${ip}/streaming/live/1?proto=rtsps` : `bambu:///local/${ip}.?port=6000&user=bblp&passwd=${password}`;
    } else url = await this.native.getCameraUrl(connection.device.deviceId);
    if (!url.startsWith('bambu:///local/') && !url.startsWith('bambu:///rtsps___')) return reject(error('offline', 'No LAN camera address is available.'));
    if (protocol === 'rtsps' && url.startsWith('bambu:///local/')) url += '&lv=rtsps';
    url += `&device=${encodeURIComponent(connection.device.deviceId)}&net_ver=02.08.01.99`;
    if (signal.aborted || this.retiredOwners.has(r.owner)) return reject(error('cancelled', 'Camera viewing stopped.'));
    const source = join(dirname(this.config.pluginPath), process.platform === 'win32' ? 'BambuSource.dll' : process.platform === 'darwin' ? 'libBambuSource.dylib' : 'libBambuSource.so');
    r.camera = this.load(this.config.addonPath, source, url);
    const id = randomUUID() as D.Id<'media'>, streamId = randomUUID() as D.Id<'media-stream'>;
    let resolveReady!: (descriptor: D.MediaDescriptor) => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<D.MediaDescriptor>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const emit = (packet: D.MediaStreamPacket) => {
      if (!r.descriptor) {
        if (packet.kind !== 'init' && packet.kind !== 'jpeg') throw new Error('Missing camera initialization');
        r.descriptor = { ref: { printerId: request.target.printerId, routeId: request.target.routeId, id }, source: request.source, configurationRevision: connection.route.configurationRevision, revision: 1, expiresAtMs: Date.now() + 300_000,
          presentation: { kind: 'video', delivery: packet.kind === 'init' ? { transport: 'mse-fmp4', streamId, mimeType: packet.mimeType } : { transport: 'jpeg-frames', streamId, mimeType: 'image/jpeg' },
            profile: null, codecId: packet.kind === 'init' ? 'h264' : 'jpeg', live: true, seekable: false, durationSeconds: null } };
        this.resources.set(id, r); r.attachDeadline = Date.now() + 10_000; resolveReady(r.descriptor); this.changed();
      }
      r.channel.push(packet);
    };
    r.task = (async () => {
      let muxer: CameraMuxer | undefined, jpegSequence = 0;
      const deadline = Date.now() + 20_000;
      try {
        while (!signal.aborted) {
          if (!r.descriptor && Date.now() > deadline) throw new Error('Camera initialization timed out');
          const next = r.camera!.poll();
          if (next.ready) {
            if (next.format !== (protocol === 'local' ? 'jpeg' : 'h264')) throw new Error('Camera format changed');
            if (next.format === 'h264' && !muxer) muxer = new CameraMuxer(next.width, next.height, emit);
            for (const sample of next.samples) {
              if (next.format === 'h264') muxer!.push(sample);
              else {
                if (sample.bytes[0] !== 255 || sample.bytes[1] !== 216 || sample.bytes.at(-2) !== 255 || sample.bytes.at(-1) !== 217) throw new Error('Invalid JPEG');
                emit({ generation: 0, sequence: jpegSequence++, kind: 'jpeg', bytes: sample.bytes });
              }
            }
          }
          await delay(5, undefined, { signal });
        }
      } catch { if (!signal.aborted) { r.error = unavailable(); r.status = 'interrupted'; this.changed(); } }
      finally {
        rejectReady(new Error('Camera stopped before initialization')); r.channel.close(r.error ?? undefined);
        await r.camera?.close();
        if (r.token) { const token = r.token; r.token = undefined; await this.monitor.stop(token); }
        if (this.active === r) this.active = null;
      }
    })();
    void r.task.catch(() => {});
    return { ok: true, value: await ready };
  }
  attach(owner: string, attachment: BambuMediaAttachment, port: CameraPort) {
    const r = this.valid(owner, attachment.media), delivery = r?.descriptor?.presentation;
    if (!r || r.status !== 'ready' || delivery?.kind !== 'video' || !('streamId' in delivery.delivery) || delivery.delivery.streamId !== attachment.streamId || r.attached) {
      port.postMessage({ type: 'error', error: error('invalid-target', 'Camera stream unavailable.') }); port.close(); return;
    }
    r.attached = true; r.channel.attach(port);
  }
  private release(r: Resource, detail?: D.PrinterError): Promise<void> {
    if (r.close) return r.close;
    r.error = detail ?? r.error; r.status = 'closed'; r.attachDeadline = Date.now() + 60_000;
    r.controller.abort(); r.channel.close(r.error ?? undefined); this.changed();
    r.close = (async () => {
      await r.task;
      if (!r.task) { await r.camera?.close(); if (r.token) { const token = r.token; r.token = undefined; await this.monitor.stop(token); } }
      if (this.active === r) this.active = null;
    })();
    return r.close;
  }
  async closeOwner(owner: string) {
    this.retiredOwners.add(owner);
    if (this.active?.owner === owner) await this.release(this.active);
    for (const r of this.resources.values()) if (r.owner === owner) await this.release(r);
  }
  async close() { this.closing = true; clearInterval(this.timer); if (this.active) await this.release(this.active); }
}
