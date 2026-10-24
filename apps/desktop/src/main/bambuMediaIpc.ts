import { randomUUID } from 'node:crypto';
import { MessageChannelMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { isBambuMediaAttachment, isBambuMediaRequest } from '../shared/bambuMedia';
import { Ipc } from '../shared/ipc';
import type { BambuUtility } from './bambuUtility';

/** Document identity is assigned in main; a renderer cannot access another document's viewer. */
export class BambuMediaIpc {
  private readonly owners = new Map<WebContents, string>();
  private readonly installed = new WeakSet<WebContents>();
  constructor(private readonly utility: () => BambuUtility | null, private readonly isApp: (webContents: WebContents) => boolean) {}
  private owner(event: IpcMainEvent | IpcMainInvokeEvent): string {
    if (!this.isApp(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Camera IPC rejected');
    let owner = this.owners.get(event.sender);
    if (!owner) { owner = randomUUID(); this.owners.set(event.sender, owner); }
    if (!this.installed.has(event.sender)) {
      this.installed.add(event.sender);
      const close = () => { const previous = this.owners.get(event.sender); this.owners.delete(event.sender); if (previous) this.utility()?.closeMediaOwner(previous); };
      event.sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) close(); });
      event.sender.on('render-process-gone', close); event.sender.once('destroyed', close);
    }
    return owner;
  }
  async call(event: IpcMainInvokeEvent, request: unknown) {
    const owner = this.owner(event);
    if (!isBambuMediaRequest(request)) throw new Error('Camera request rejected');
    try { return await this.utility()?.media(owner, request) ?? { ok: false, error: { code: 'transport', message: 'Camera unavailable.' } }; }
    catch { return { ok: false, error: { code: 'transport', message: 'Camera unavailable.' } }; }
  }
  connect(event: IpcMainEvent, request: unknown) {
    const owner = this.owner(event);
    if (!isBambuMediaAttachment(request)) throw new Error('Camera attachment rejected');
    const { port1, port2 } = new MessageChannelMain();
    if (!this.utility()) { port1.close(); port2.close(); return; }
    event.senderFrame!.postMessage(Ipc.bambuMediaPort, request.token, [port2]);
    void this.utility()!.connectMedia(owner, request, port1).catch(() => port1.close());
  }
}
