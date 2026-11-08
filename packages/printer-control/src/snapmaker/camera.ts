/** Host-neutral U1 media resources. One authority owns admission and session cleanup. */
import type * as D from '../domain';
import type { PrinterConfiguration } from '../configuration';
import type { PrinterTransport, PrinterWebSocketTransport } from '../transport';
import { fail, MoonrakerFailure, publicError } from '../moonraker-http';
import { copy, newId, requestSignature } from '../operations';
import { safe } from '../http-service';
import { readU1CameraFrame, U1CameraControl } from './camera-protocol';

const LEASE_MS = 300_000;
const REQUEST_RETENTION_MS = 300_000;
const ATTACH_MS = 10_000;
const RECOVERY_MS = 30_000;
const FRAME_INTERVAL_MS = 200;
export const U1_CAMERA_ID = 'snapmaker-chamber-camera' as D.Id<'camera'>;
export const u1CameraCapability: D.CameraMediaCapability = {
  cameraId: U1_CAMERA_ID,
  liveView: { kind: 'supported', constraints: { transports: ['jpeg-frames'], profiles: [], maxConcurrentViews: 1, requestIdRetentionMs: REQUEST_RETENTION_MS } },
  snapshot: { kind: 'unsupported', layer: 'adapter', reason: 'Snapshot capture is unavailable.' },
};
export interface U1CameraMediaOptions {
  http: PrinterTransport;
  sockets: PrinterWebSocketTransport;
  resolve(target: D.TargetRequest): Promise<{ printer: Readonly<PrinterConfiguration>; revision: D.Revision }>;
}
interface Resource {
  descriptor: D.MediaDescriptor;
  signature: string;
  requestKey: string;
  clientId: string;
  controller: AbortController;
  printer?: Readonly<PrinterConfiguration>;
  control?: U1CameraControl;
  source?: string;
  needStart: boolean;
  renewalAt: number;
  interactionAt: number;
  generation: number;
  pending?: Uint8Array;
  attached: boolean;
  attachDeadline: number;
  state: 'connecting' | 'ready' | 'closed';
  error?: D.PrinterError;
  revision: number;
  listeners: Set<() => void>;
  recoverySince?: number;
  recoveryTimer?: ReturnType<typeof setTimeout>;
  task: Promise<void>;
  opened: Promise<D.Result<D.MediaDescriptor>>;
  release?: Promise<void>;
  retainedUntil: number;
}
function changed(resource: Resource, metadata = true): void {
  if (metadata) resource.revision++;
  for (const listener of resource.listeners) listener();
}
function wait(resource: Resource, signal?: AbortSignal, milliseconds?: number, changes = true): Promise<void> {
  if (resource.controller.signal.aborted || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      clearTimeout(timer); resource.listeners.delete(wake);
      resource.controller.signal.removeEventListener('abort', wake); signal?.removeEventListener('abort', wake);
      resolve();
    };
    if (changes) resource.listeners.add(wake);
    resource.controller.signal.addEventListener('abort', wake, { once: true });
    signal?.addEventListener('abort', wake, { once: true });
    if (milliseconds !== undefined) timer = setTimeout(wake, milliseconds);
  });
}
const terminal = (error: D.PrinterError) => ['unsupported', 'authentication-required', 'permission-denied', 'no-compatible-media', 'invalid-target', 'stale-context', 'invalid-request'].includes(error.code);

async function cancellableRead<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new MoonrakerFailure({ code: 'cancelled', message: 'Camera request cancelled.' }));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Instantiate once per host authority; service facades delegate to api. */
export class U1CameraMedia {
  private readonly resources = new Map<string, Resource>();
  private readonly requests = new Map<string, Resource>();
  private active?: Resource;
  private disposed = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: U1CameraMediaOptions) {}

  private monitorLeases(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const resource of this.resources.values()) {
        if (resource.state === 'closed') {
          if (now >= resource.retainedUntil) { this.resources.delete(resource.descriptor.ref.id); this.requests.delete(resource.requestKey); }
        } else if (now >= resource.descriptor.expiresAtMs! || !resource.attached && now >= resource.attachDeadline) {
          void this.release(resource, { code: 'lease-expired', message: 'Camera access expired.' });
        }
      }
    }, 1000);
  }

  readonly api: Pick<D.PrinterMedia, 'open' | 'watch' | 'readStream' | 'renew' | 'interact' | 'close'> = {
    interact: async (ref, options) => options?.signal?.aborted ? { ok: false, error: { code: 'cancelled', message: 'Camera request cancelled.' } } : this.interact(ref),
    open: (request, options) => this.open(request, options?.signal),
    watch: (ref, options) => this.watch(ref, options?.signal),
    readStream: (request, options) => this.readStream(request, options?.signal),
    renew: (ref, options) => safe(async () => {
      if (options?.signal?.aborted) fail('cancelled', 'Camera request cancelled.');
      const resource = this.require(ref);
      await this.validate(resource);
      this.require(ref);
      resource.descriptor = { ...resource.descriptor, revision: resource.descriptor.revision + 1, expiresAtMs: Date.now() + LEASE_MS };
      changed(resource); return copy(resource.descriptor);
    }),
    close: ref => safe(async () => { await this.release(this.require(ref, true)); return null; }),
  };

  /** Direct user activity; media-lease renewal is a separate operation. */
  interact(ref: D.MediaRef): D.Result<null> {
    const resource = this.resources.get(ref.id);
    if (!resource || !this.matches(resource, ref) || resource.state === 'closed') {
      return { ok: false, error: { code: 'invalid-target', message: 'Camera resource unavailable.' } };
    }
    if (Date.now() - resource.interactionAt >= 60_000) {
      resource.interactionAt = Date.now(); resource.needStart = true; changed(resource, false);
    }
    return { ok: true, value: null };
  }

  private matches(resource: Resource, ref: D.MediaRef): boolean {
    return resource.descriptor.ref.printerId === ref.printerId && resource.descriptor.ref.routeId === ref.routeId;
  }
  private require(ref: D.MediaRef, allowClosed = false): Resource {
    const resource = this.resources.get(ref.id);
    if (!resource || !this.matches(resource, ref)) fail('invalid-target', 'Camera resource unavailable.');
    if (!allowClosed && resource.state === 'closed') {
      if (resource.error) fail(resource.error.code, resource.error.message);
      fail('lease-expired', 'Camera viewing ended.');
    }
    if (!allowClosed && Date.now() >= resource.descriptor.expiresAtMs!) {
      void this.release(resource, { code: 'lease-expired', message: 'Camera access expired.' });
      fail('lease-expired', 'Camera access expired.');
    }
    return resource;
  }
  private async validate(resource: Resource) {
    const current = await cancellableRead(this.options.resolve({ ...resource.descriptor.ref, expectedConfigurationRevision: resource.descriptor.configurationRevision }), resource.controller.signal);
    if (current.revision !== resource.descriptor.configurationRevision) fail('stale-context', 'Camera connection configuration changed.');
    return current;
  }

  private async open(request: D.OpenMediaRequest, caller?: AbortSignal): Promise<D.Result<D.MediaDescriptor>> {
    return safe(async () => {
      if (this.disposed || caller?.aborted) fail('cancelled', 'Camera request cancelled.');
      if (request.source.kind !== 'camera' || request.source.cameraId !== U1_CAMERA_ID || request.source.profileId !== undefined) fail('invalid-request', 'Camera source unavailable.');
      if (!request.client.video.some(item => item.transport === 'jpeg-frames' && item.codecIds.includes('jpeg'))) fail('no-compatible-media', 'JPEG camera playback unavailable.');
      const requestKey = JSON.stringify([request.target.printerId, request.target.routeId, request.requestId]);
      const signature = requestSignature(request), previous = this.requests.get(requestKey);
      if (previous) {
        if (signature !== previous.signature) fail('invalid-request', 'Camera request identity already used.');
        const result = await cancellableRead(previous.opened, caller);
        if (!result.ok) fail(result.error.code, result.error.message);
        return copy(previous.descriptor);
      }
      if (this.active) fail('busy', 'Another Snapmaker camera view is active.');
      if (this.requests.size >= 128) fail('busy', 'Camera request history is full.');
      // Reserve admission before configuration I/O, including concurrent opens.
      let accept!: (result: D.Result<D.MediaDescriptor>) => void;
      const opened = new Promise<D.Result<D.MediaDescriptor>>(resolve => { accept = resolve; });
      const descriptor: D.MediaDescriptor = { ref: { printerId: request.target.printerId, routeId: request.target.routeId, id: newId<'media'>() },
        configurationRevision: request.target.expectedConfigurationRevision ?? '', revision: 1, source: copy(request.source), expiresAtMs: Date.now() + LEASE_MS, acceptsUserActivity: true,
        presentation: { kind: 'video', playbackRecovery: { timeoutMs: RECOVERY_MS }, delivery: { transport: 'jpeg-frames', streamId: newId<'media-stream'>(), mimeType: 'image/jpeg' },
          profile: null, durationSeconds: null, seekable: false, codecId: 'jpeg', live: true } };
      const resource: Resource = { descriptor, signature, requestKey, clientId: `neo-camera-${newId<'request'>()}`, controller: new AbortController(),
        needStart: true, renewalAt: 0, interactionAt: -Infinity, generation: 0, attached: false, attachDeadline: Infinity,
        state: 'connecting', revision: 0, listeners: new Set(), task: Promise.resolve(), opened, retainedUntil: Infinity };
      this.active = resource; this.resources.set(descriptor.ref.id, resource); this.requests.set(requestKey, resource);
      this.monitorLeases();
      const cancel = () => { void this.release(resource, { code: 'cancelled', message: 'Camera opening cancelled.' }); };
      caller?.addEventListener('abort', cancel, { once: true });
      resource.task = this.run(resource, request.target, accept);
      try {
        const result = await opened;
        if (!result.ok) fail(result.error.code, result.error.message);
        return copy(result.value);
      } finally { caller?.removeEventListener('abort', cancel); }
    });
  }

  private async run(resource: Resource, target: D.TargetRequest, accept: (result: D.Result<D.MediaDescriptor>) => void): Promise<void> {
    const signal = resource.controller.signal;
    let opened = false;
    try {
      const current = await cancellableRead(this.options.resolve(target), signal);
      if (target.expectedConfigurationRevision !== undefined && target.expectedConfigurationRevision !== current.revision) {
        fail('stale-context', 'Camera connection configuration changed.');
      }
      resource.printer = copy(current.printer); resource.descriptor.configurationRevision = current.revision;
      while (!signal.aborted) {
        try {
          await this.validate(resource);
          if (signal.aborted) break;
          if (!resource.control?.connected) {
            if (opened) this.recover(resource);
            resource.control?.close();
            resource.control = await U1CameraControl.connect(resource.printer, { http: this.options.http, sockets: this.options.sockets, clientId: resource.clientId, signal });
            resource.needStart = true; resource.generation++; resource.pending = undefined;
          }
          if (resource.needStart || Date.now() >= resource.renewalAt) {
            const source = await resource.control.start(signal);
            if (resource.source && resource.source !== source) { resource.generation++; resource.pending = undefined; }
            resource.source = source; resource.needStart = false; resource.renewalAt = Date.now() + 300_000;
            if (!opened && !signal.aborted) {
              opened = true; resource.attachDeadline = Date.now() + ATTACH_MS; accept({ ok: true, value: copy(resource.descriptor) });
            }
          }
          const frameAt = Date.now();
          const bytes = await readU1CameraFrame(resource.printer, resource.source!, this.options.http, signal);
          if (signal.aborted) break;
          await this.validate(resource);
          if (signal.aborted) break;
          if (!resource.control.connected) fail('transport', 'Camera control connection interrupted.');
          clearTimeout(resource.recoveryTimer); resource.recoveryTimer = undefined; resource.recoverySince = undefined;
          const metadataChanged = resource.state !== 'ready';
          resource.pending = bytes; resource.state = 'ready'; changed(resource, metadataChanged);
          await wait(resource, undefined, Math.max(0, FRAME_INTERVAL_MS - (Date.now() - frameAt)), false);
        } catch (error) {
          if (signal.aborted) break;
          const detail = publicError(error);
          if (terminal(detail)) { void this.release(resource, detail); break; }
          this.recover(resource); await wait(resource, undefined, 1000, false);
        }
      }
    } catch (error) {
      if (!signal.aborted) { resource.error = publicError(error); resource.controller.abort(); }
    } finally {
      clearTimeout(resource.recoveryTimer);
      resource.state = 'closed'; resource.pending = undefined;
      resource.retainedUntil = Date.now() + REQUEST_RETENTION_MS;
      accept({ ok: false, error: resource.error ?? { code: 'cancelled', message: 'Camera opening cancelled.' } });
      try { if (resource.control?.connected) await resource.control.stop(); }
      catch { /* stop acknowledgement is best-effort; local release must complete */ }
      resource.control?.close();
      if (this.active === resource) this.active = undefined;
      changed(resource);
    }
  }

  private recover(resource: Resource): void {
    const metadataChanged = resource.state !== 'connecting';
    resource.state = 'connecting';
    if (resource.recoverySince === undefined) {
      resource.recoverySince = Date.now();
      resource.recoveryTimer = setTimeout(() => { void this.release(resource, { code: 'transport', message: 'Camera recovery timed out.' }); }, RECOVERY_MS);
    }
    changed(resource, metadataChanged);
  }

  private release(resource: Resource, error?: D.PrinterError): Promise<void> {
    if (resource.release) return resource.release;
    resource.error ??= error; resource.state = 'closed'; resource.controller.abort();
    clearTimeout(resource.recoveryTimer); resource.pending = undefined; changed(resource);
    resource.release = resource.task.then(() => undefined);
    return resource.release;
  }

  private async *watch(ref: D.MediaRef, signal?: AbortSignal): AsyncIterable<D.MediaEvent> {
    const resource = this.require(ref, true); let revision = -1, sequence = 0;
    yield { sequence: sequence++, payload: { type: 'descriptor', descriptor: copy(resource.descriptor) } };
    while (!signal?.aborted) {
      if (revision !== resource.revision) {
        revision = resource.revision;
        yield { sequence: sequence++, payload: { type: 'descriptor', descriptor: copy(resource.descriptor) } };
        if (resource.state === 'closed') {
          yield { sequence: sequence++, payload: resource.error ? { type: 'error', error: copy(resource.error) } : { type: 'closed', reason: 'client' } }; return;
        }
        yield { sequence: sequence++, payload: { type: 'state', state: resource.state } };
      }
      if (revision === resource.revision) await wait(resource, signal);
    }
  }

  private async *readStream(request: { media: D.MediaRef; streamId: D.Id<'media-stream'>; startSeconds?: number }, signal?: AbortSignal): AsyncIterable<D.MediaStreamPacket> {
    const resource = this.require(request.media), presentation = resource.descriptor.presentation;
    if (request.startSeconds !== undefined || presentation.kind !== 'video' || presentation.delivery.transport !== 'jpeg-frames'
      || presentation.delivery.streamId !== request.streamId) fail('invalid-target', 'Camera stream unavailable.');
    if (resource.attached) fail('busy', 'Camera stream already has a reader.');
    resource.attached = true; resource.attachDeadline = Infinity;
    let generation = -1, sequence = 0;
    try {
      while (!signal?.aborted) {
        if (resource.state === 'closed') {
          if (resource.error) throw Object.assign(new Error(resource.error.message), { detail: resource.error });
          return;
        }
        if (resource.pending) {
          const bytes = resource.pending; resource.pending = undefined;
          if (generation !== resource.generation) { generation = resource.generation; sequence = 0; }
          yield { kind: 'jpeg', generation, sequence: sequence++, bytes };
        } else await wait(resource, signal);
      }
    } finally { resource.attached = false; resource.attachDeadline = Date.now() + ATTACH_MS; }
  }

  async dispose(): Promise<void> {
    this.disposed = true; clearInterval(this.timer);
    await this.closeViews();
    this.resources.clear(); this.requests.clear();
  }

  async closeViews(): Promise<void> {
    await Promise.all([...this.resources.values()].map(resource => this.release(resource)));
  }
}
