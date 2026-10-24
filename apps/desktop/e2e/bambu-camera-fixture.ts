import type { ElectronApplication, Page } from '@playwright/test';
import type * as D from '@orca/printer-control/domain';
import { Ipc } from '../src/shared/ipc';
declare global { var cameraFixture: { opened: number; closed: string[]; resources: Record<string, D.MediaDescriptor> }; }
/** Real renderer adapter/port/player; deterministic image source, no physical device. */
export async function installCameraFixture(app: ElectronApplication, page: Page) {
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#15aa44'; ctx.fillRect(0, 0, 320, 240);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  });
  await app.evaluate(({ ipcMain, MessageChannelMain }, { channels, jpeg }) => {
    globalThis.cameraFixture = { opened: 0, closed: [], resources: {} };
    ipcMain.removeHandler(channels.bambuMedia);
    ipcMain.handle(channels.bambuMedia, (_event, { method, input }) => {
      const state = globalThis.cameraFixture;
      if (method === 'open') {
        const id = `camera-${++state.opened}`;
        const value: D.MediaDescriptor = { ref: { printerId: input.target.printerId, routeId: input.target.routeId, id: id as D.Id<'media'> }, source: input.source, revision: 1, configurationRevision: 'fixture', expiresAtMs: Date.now() + 300000,
          presentation: { kind: 'video', delivery: { transport: 'jpeg-frames', streamId: id as D.Id<'media-stream'>, mimeType: 'image/jpeg' }, profile: null, codecId: 'jpeg', live: true, seekable: false, durationSeconds: null } };
        state.resources[id] = value; return { ok: true, value };
      }
      if (method === 'close') { if (!state.closed.includes(input.id)) state.closed.push(input.id); return { ok: true, value: null }; }
      if (method === 'get') return { ok: true, value: { descriptor: state.resources[input.id], state: state.closed.includes(input.id) ? 'closed' : 'ready', error: null } };
      if (method === 'renew') return { ok: true, value: state.resources[input.id] = { ...state.resources[input.id], revision: state.resources[input.id].revision + 1, expiresAtMs: Date.now() + 300000 } };
      throw new Error('Unexpected fixture media request');
    });
    ipcMain.removeAllListeners(channels.bambuMediaConnect);
    ipcMain.on(channels.bambuMediaConnect, (event, request) => {
      const { port1, port2 } = new MessageChannelMain(); let sequence = 0;
      port1.on('message', ({ data }) => {
        if (data === 'pull' && sequence === 0) port1.postMessage({ type: 'packet', packet: { generation: 0, sequence: sequence++, kind: 'jpeg', bytes: new Uint8Array(Buffer.from(jpeg, 'base64')) } });
      });
      port1.start(); event.senderFrame!.postMessage(channels.bambuMediaPort, request.token, [port2]);
    });
  }, { channels: Ipc, jpeg });
}
