import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { PrinterConfigurationDocument } from '@orca/printer-control';
import type * as D from '@orca/printer-control/domain';
import { cameraConfigurationDigest, type CameraRequest } from '../shared/snapmakerCamera';
vi.mock('electron', () => ({ MessageChannelMain: class {} }));
import { SnapmakerCameraIpc } from './snapmakerCameraIpc';
import type { SnapmakerCameraUtility } from './snapmakerCameraUtility';

async function fixture() {
  const document: PrinterConfigurationDocument = { version: 1, printers: [{ id: 'u1', driverId: 'snapmaker', displayName: 'U1', apiBaseUrl: 'http://printer', apiKey: 'private-key', consoleUrl: '' }] };
  const sender = Object.assign(new EventEmitter(), { mainFrame: {} }) as unknown as WebContents;
  const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent;
  const load = vi.fn(async () => document), utility = { call: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })), configuration: vi.fn(), closeOwner: vi.fn() };
  const ipc = new SnapmakerCameraIpc(() => utility as unknown as SnapmakerCameraUtility, content => content === sender, load);
  const request: CameraRequest = { method: 'open', input: { configurationDigest: await cameraConfigurationDigest(document.printers[0]), request: {
    target: { printerId: 'u1' as D.Id<'printer'>, routeId: 'snapmaker:u1' as D.Id<'route'>, expectedConfigurationRevision: 'revision' }, requestId: 'open' as D.Id<'request'>, source: { kind: 'camera', cameraId: 'snapmaker-chamber-camera' as D.Id<'camera'> },
    client: { video: [{ transport: 'jpeg-frames', codecIds: ['jpeg'] }], imageMimeTypes: [], contentFormats: [] } } } };
  return { ipc, utility, event, sender, load, document, request };
}
it('rejects guests, child frames, malformed requests and endpoint injection', async () => {
  const f = await fixture();
  await expect(f.ipc.call({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent, f.request)).rejects.toThrow('rejected');
  await expect(f.ipc.call(f.event, { ...f.request, endpoint: 'http://attacker' })).rejects.toThrow('rejected');
  if (f.request.method !== 'open') throw new Error('Invalid fixture');
  await expect(f.ipc.call(f.event, { ...f.request, input: { ...f.request.input, configurationDigest: '0'.repeat(64) } })).resolves.toMatchObject({ ok: false, error: { code: 'stale-context' } });
  expect(f.utility.call).not.toHaveBeenCalled();
});
it('grants the persisted configuration and retires ownership on navigation and process loss', async () => {
  const f = await fixture(); await f.ipc.call(f.event, f.request);
  expect(f.utility.call).toHaveBeenCalledWith(expect.any(String), f.request, { printer: f.document.printers[0], revision: 'revision' }, expect.any(Function));
  const [owner, , , current] = f.utility.call.mock.calls[0] as unknown as [string, unknown, unknown, () => boolean];
  expect(current()).toBe(true);
  f.sender.emit('did-start-navigation', {}, 'http://new-document', false, true);
  expect(current()).toBe(false); expect(f.utility.closeOwner).toHaveBeenCalledWith(owner);
  await f.ipc.call(f.event, f.request);
  expect(f.utility.call.mock.calls[1][0]).not.toBe(owner);
  f.sender.emit('render-process-gone'); expect(f.utility.closeOwner).toHaveBeenCalledTimes(2);
});
it('cancels an open while persisted configuration is still loading', async () => {
  const f = await fixture(); let finish!: (document: PrinterConfigurationDocument) => void;
  f.load.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const opening = f.ipc.call(f.event, f.request);
  await f.ipc.call(f.event, { method: 'cancelOpen', input: { requestId: 'open' } });
  finish(f.document); expect(await opening).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  expect(f.utility.call).toHaveBeenCalledTimes(1);
});
it('rejects an open whose configuration changes while loading', async () => {
  const f = await fixture(); let finish!: (document: PrinterConfigurationDocument) => void;
  f.load.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const opening = f.ipc.call(f.event, f.request);
  await f.ipc.configurationChanged(); finish(f.document);
  expect(await opening).toMatchObject({ ok: false, error: { code: 'stale-context' } });
  expect(f.utility.call).not.toHaveBeenCalled();
});
