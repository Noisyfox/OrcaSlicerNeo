import { randomUUID } from 'node:crypto';
import { MessageChannelMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { PrinterConfigurationDocument } from '@orca/printer-control';
import { cameraConfigurationDigest, isCameraRequest, isCameraAttachment } from '../shared/snapmakerCamera';
import { Ipc } from '../shared/ipc';
import type { SnapmakerCameraUtility } from './snapmakerCameraUtility';

interface Owner { id: string; active: boolean; pending: Map<string, { cancelled: boolean; callers: number }> }
const rejected = (code: 'transport' | 'stale-context' | 'cancelled' | 'invalid-target') => ({ ok: false, error: { code, message: 'Camera access unavailable. Retry from the current device.' } });

/** Endpoints come from persisted main-owned configuration. Documents own only opaque viewers. */
export class SnapmakerCameraIpc {
  private readonly owners = new Map<WebContents, Owner>();
  private readonly installed = new WeakSet<WebContents>();
  private epoch = 0;
  constructor(private readonly utility: (create?: boolean) => SnapmakerCameraUtility | undefined, private readonly isApp: (contents: WebContents) => boolean,
    private readonly load: () => Promise<PrinterConfigurationDocument>) {}
  private owner(event: IpcMainEvent | IpcMainInvokeEvent): Owner {
    if (!this.isApp(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Camera request rejected.');
    let owner = this.owners.get(event.sender);
    if (!owner) { owner = { id: randomUUID(), active: true, pending: new Map() }; this.owners.set(event.sender, owner); }
    if (!this.installed.has(event.sender)) {
      this.installed.add(event.sender);
      const close = () => {
        const previous = this.owners.get(event.sender); this.owners.delete(event.sender);
        if (previous) { previous.active = false; this.utility()?.closeOwner(previous.id); }
      };
      event.sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) close(); });
      event.sender.on('render-process-gone', close); event.sender.once('destroyed', close);
    }
    return owner;
  }
  async configurationChanged(): Promise<void> {
    const epoch = ++this.epoch, document = await this.load();
    if (epoch === this.epoch) this.utility()?.configuration(document);
  }
  async call(event: IpcMainInvokeEvent, value: unknown): Promise<unknown> {
    const owner = this.owner(event);
    if (!isCameraRequest(value)) throw new Error('Camera request rejected.');
    const utility = this.utility(value.method === 'open');
    if (!utility) return rejected('transport');
    if (value.method === 'cancelOpen') {
      const pending = owner.pending.get(value.input.requestId); if (pending) pending.cancelled = true;
    }
    if (value.method !== 'open') {
      try { return await utility.call(owner.id, value, undefined, () => owner.active); }
      catch { return rejected('transport'); }
    }
    const { request, configurationDigest } = value.input;
    const pending = owner.pending.get(request.requestId) ?? { cancelled: false, callers: 0 }, epoch = this.epoch;
    pending.callers++;
    owner.pending.set(request.requestId, pending);
    try {
      const document = await this.load();
      const printer = document.printers.find(printer => printer.id === request.target.printerId && printer.driverId === 'snapmaker');
      if (!printer || request.target.routeId !== `snapmaker:${printer.id}` || !request.target.expectedConfigurationRevision) return rejected('invalid-target');
      if (await cameraConfigurationDigest(printer) !== configurationDigest || epoch !== this.epoch) return rejected('stale-context');
      if (!owner.active || pending.cancelled) return rejected('cancelled');
      utility.configuration(document);
      return await utility.call(owner.id, value, { printer, revision: request.target.expectedConfigurationRevision },
        () => owner.active && !pending.cancelled && epoch === this.epoch);
    } catch { return rejected('transport'); }
    finally { if (--pending.callers === 0) owner.pending.delete(request.requestId); }
  }
  connect(event: IpcMainEvent, request: unknown): void {
    const owner = this.owner(event);
    if (!isCameraAttachment(request)) throw new Error('Camera attachment rejected.');
    const utility = this.utility();
    if (!utility) throw new Error('Camera host unavailable.');
    const { port1, port2 } = new MessageChannelMain();
    event.senderFrame!.postMessage(Ipc.snapmakerCameraPort, request.token, [port2]);
    void utility.connect(owner.id, request, port1, () => owner.active).catch(() => port1.close());
  }
}
