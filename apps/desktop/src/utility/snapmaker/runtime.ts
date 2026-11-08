import { U1CameraMedia, type PrinterConfiguration, type PrinterConfigurationDocument, type U1CameraMediaOptions } from '@orca/printer-control';
import type * as D from '@orca/printer-control/domain';
import { cameraConfigurationKey, type CameraRequest, type CameraStatus } from '../../shared/snapmakerCamera';
import type { BambuMediaAttachment } from '../../shared/bambuMedia';
import { CameraChannel, type CameraPort } from '../bambu/mediaChannel';
import { MoonrakerFailure } from '../../../../../packages/printer-control/src/moonraker-http';

export interface CameraGrant { printer: PrinterConfiguration; revision: D.Revision }
interface View {
  owner: string;
  descriptor: D.MediaDescriptor;
  status: CameraStatus;
  watch: AbortController;
  stream?: AbortController;
  channel?: CameraChannel;
  retainedUntil: number;
}
const unavailable = (): D.Result<never> => ({ ok: false, error: { code: 'invalid-target', message: 'Camera resource unavailable.' } });

/** One application-wide admission authority, with main-assigned document owners. */
export class SnapmakerCameraRuntime {
  private readonly media: U1CameraMedia;
  private readonly views = new Map<string, View>();
  private readonly pending = new Map<string, { controller: AbortController; callers: number }>();
  private readonly grants = new Map<string, CameraGrant>();
  private configuration: PrinterConfiguration[] = [];
  constructor(options: Pick<U1CameraMediaOptions, 'http' | 'sockets'>, private readonly changed: () => void) {
    this.media = new U1CameraMedia({ ...options, resolve: async target => {
      const grant = this.grants.get(JSON.stringify([target.printerId, target.routeId, target.expectedConfigurationRevision]));
      const current = grant && this.configuration.find(printer => printer.id === grant.printer.id);
      if (!grant || !current || cameraConfigurationKey(current) !== cameraConfigurationKey(grant.printer)) {
        throw new MoonrakerFailure({ code: 'stale-context', message: 'Camera configuration changed.' });
      }
      return grant;
    } });
  }
  updateConfiguration(document: PrinterConfigurationDocument): void {
    this.configuration = document.printers;
  }
  async call(owner: string, request: CameraRequest, grant?: CameraGrant): Promise<unknown> {
    const key = (id: string) => JSON.stringify([owner, id]);
    if (request.method === 'cancelOpen') {
      this.pending.get(key(request.input.requestId))?.controller.abort(); return { ok: true, value: null };
    }
    if (request.method === 'open') {
      if (!grant || grant.printer.driverId !== 'snapmaker' || request.input.request.target.printerId !== grant.printer.id
        || request.input.request.target.routeId !== `snapmaker:${grant.printer.id}`) return unavailable();
      for (const [id, view] of this.views) if (view.status.state === 'closed' && Date.now() >= view.retainedUntil) this.views.delete(id);
      const original = request.input.request, id = key(original.requestId);
      if (this.pending.size >= 128 && !this.pending.has(id)) return unavailable();
      const grantKey = JSON.stringify([original.target.printerId, original.target.routeId, grant.revision]);
      this.grants.set(grantKey, grant);
      if (this.grants.size > 128) {
        const retained = new Set([...this.views.values()].filter(view => view.status.state !== 'closed')
          .map(view => JSON.stringify([view.descriptor.ref.printerId, view.descriptor.ref.routeId, view.descriptor.configurationRevision])));
        for (const key of this.grants.keys()) if (key !== grantKey && !retained.has(key)) { this.grants.delete(key); break; }
      }
      const pending = this.pending.get(id) ?? { controller: new AbortController(), callers: 0 };
      pending.callers++; this.pending.set(id, pending);
      const { controller } = pending;
      try {
        const result = await this.media.api.open({ ...original, requestId: id as D.Id<'request'>,
          target: { ...original.target, expectedConfigurationRevision: grant.revision } }, { signal: controller.signal });
        if (!result.ok) return result;
        if (controller.signal.aborted) { await this.media.api.close(result.value.ref); return unavailable(); }
        if (!this.views.has(result.value.ref.id)) {
          const view: View = { owner, descriptor: result.value, status: { descriptor: result.value, state: 'connecting', error: null }, watch: new AbortController(), retainedUntil: Infinity };
          this.views.set(result.value.ref.id, view);
          void this.watch(view);
        }
        return result;
      } finally { if (--pending.callers === 0) this.pending.delete(id); }
    }
    const view = this.views.get(request.input.id);
    if (!view || view.owner !== owner || view.descriptor.ref.printerId !== request.input.printerId || view.descriptor.ref.routeId !== request.input.routeId) return unavailable();
    switch (request.method) {
      case 'get': return { ok: true, value: view.status };
      case 'renew': return this.media.api.renew(request.input);
      case 'interact': return this.media.api.interact(request.input);
      case 'close': return this.close(view);
    }
  }
  private async watch(view: View): Promise<void> {
    try {
      for await (const event of this.media.api.watch(view.descriptor.ref, { signal: view.watch.signal })) {
        const payload = event.payload;
        if (payload.type === 'descriptor') { view.descriptor = payload.descriptor; view.status.descriptor = payload.descriptor; }
        if (payload.type === 'state' && (payload.state === 'ready' || payload.state === 'connecting')) view.status.state = payload.state;
        if (payload.type === 'error') view.status.error = payload.error;
        if (payload.type === 'closed' || payload.type === 'error') {
          view.status.state = 'closed'; view.retainedUntil = Date.now() + 300_000;
          view.stream?.abort(); view.channel?.close(view.status.error ?? undefined);
        }
        this.changed();
      }
    } catch { view.status.error = { code: 'transport', message: 'Camera delivery was interrupted.' }; await this.close(view); }
  }
  connect(owner: string, request: BambuMediaAttachment, port: CameraPort): void {
    const view = this.views.get(request.media.id);
    if (!view || view.owner !== owner || view.stream || view.status.state === 'closed'
      || request.media.printerId !== view.descriptor.ref.printerId || request.media.routeId !== view.descriptor.ref.routeId
      || view.descriptor.presentation.kind !== 'video' || view.descriptor.presentation.delivery.transport !== 'jpeg-frames'
      || view.descriptor.presentation.delivery.streamId !== request.streamId) { port.close(); return; }
    const controller = new AbortController(); view.stream = controller;
    const channel = new CameraChannel(() => { void this.close(view); }, 16 * 1024 * 1024); view.channel = channel;
    channel.attach(port);
    void (async () => {
      try { for await (const packet of this.media.api.readStream(request, { signal: controller.signal })) channel.push(packet); }
      catch { channel.close({ code: 'transport', message: 'Camera delivery was interrupted.' }); }
      finally { await this.close(view); }
    })();
  }
  private async close(view: View) {
    view.stream?.abort(); view.channel?.close();
    const result = await this.media.api.close(view.descriptor.ref);
    view.status.state = 'closed'; view.retainedUntil = Date.now() + 300_000; this.changed();
    return result;
  }
  async closeOwner(owner: string): Promise<void> {
    for (const [key, pending] of this.pending) if (JSON.parse(key)[0] === owner) pending.controller.abort();
    await Promise.all([...this.views.values()].filter(view => view.owner === owner).map(view => this.close(view)));
  }
  async dispose(): Promise<void> {
    for (const pending of this.pending.values()) pending.controller.abort();
    await this.media.dispose();
    for (const view of this.views.values()) { view.watch.abort(); view.stream?.abort(); view.channel?.close(); }
    this.views.clear(); this.grants.clear();
  }
}
