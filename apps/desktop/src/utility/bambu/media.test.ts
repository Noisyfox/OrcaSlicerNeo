import { isBambuMediaRequest, isBambuMediaAttachment } from '../../shared/bambuMedia';
import { afterEach, expect, it, vi } from 'vitest';
import type { BambuNative, NativeCamera } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import { BambuMedia } from './media';
import { CameraChannel, type CameraPort } from './mediaChannel';
import { savedBambuPrinter } from '../../shared/bambuPrinters';
import type { BambuDevice } from '../../shared/bambuDevices';
import type { BambuHostConfig } from '../../shared/bambu';

const owners: BambuMedia[] = [];
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); });
function fixture() {
  const device: BambuDevice = { deviceId: 'printer', name: 'Printer', model: null, routes: [{ channel: 'lan', address: '192.0.2.1', revision: 'r1' }] };
  const devices = { list: vi.fn(async () => [device]) };
  const repository = { read: vi.fn(async () => ({ version: 1 as const, region: 'Others' as const, clientId: 'client', lan: [{ deviceId: 'printer', name: 'Printer', model: '', ip: '192.0.2.1', accessCode: 'secret', revision: 'r1' }] })) };
  const printer = savedBambuPrinter(device), route = printer.routes[0];
  const target = { printerId: printer.identity.id, routeId: route.id, expectedConfigurationRevision: route.configurationRevision };
  const monitor = { acquire: vi.fn(async () => ({ ok: true as const, value: 'lease' })), stop: vi.fn(async () => ({ ok: true as const, value: null })),
    context: vi.fn(async () => ({ ok: true as const, value: { report: { ipcam: { ipcam_dev: '1', liveview: { local: 'local' } } } } })) };
  const native = { installDeviceCertificate: vi.fn(async () => {}), getCameraUrl: vi.fn(async () => 'bambu:///local/192.0.2.1?port=6000&passwd=cloud-secret') } as unknown as BambuNative;
  let read = false;
  const camera: NativeCamera = { close: vi.fn(async () => {}), poll: vi.fn(() => {
    const samples = read ? [] : [{ bytes: new Uint8Array([255, 216, 255, 217]), flags: 1, time100ns: 0n }]; read = true;
    return { ready: true, format: 'jpeg' as const, width: 320, height: 180, samples };
  }) };
  const load = vi.fn(() => camera), changed = vi.fn();
  const media = new BambuMedia({ addonPath: '/addon.node', pluginPath: '/plugin/libbambu_networking.so' } as BambuHostConfig,
    native, monitor, devices, repository, changed, load); owners.push(media);
  const request: D.OpenMediaRequest = { target, requestId: 'request' as D.Id<'request'>, source: { kind: 'camera', cameraId: 'chamber' as D.Id<'camera'> },
    client: { video: [{ transport: 'jpeg-frames', codecIds: ['jpeg'] }], imageMimeTypes: ['image/jpeg'], contentFormats: [] } };
  return { media, monitor, native, camera, load, changed, request, device, devices, repository };
}
function portFixture() {
  const callbacks = new Map<string, (...args: any[]) => void>();
  const port = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn(), on: (name: string, fn: (...args: any[]) => void) => callbacks.set(name, fn) } as CameraPort;
  return { port, pull: () => callbacks.get('message')?.({ data: 'pull' }), disconnect: () => callbacks.get('close')?.() };
}
it('opens independently, deduplicates a request and separates private connection data from descriptors', async () => {
  const f = fixture(); const [a, b] = await Promise.all([f.media.open('document', f.request), f.media.open('document', f.request)]);
  expect(a).toEqual(b); expect(f.load).toHaveBeenCalledOnce(); expect(f.monitor.acquire).toHaveBeenCalledOnce();
  expect(JSON.stringify(a)).not.toContain('secret'); expect(JSON.stringify(a)).not.toContain('192.0.2.1');
  expect(await f.media.open('document', { ...f.request, requestId: 'second' as D.Id<'request'> })).toMatchObject({ ok: false, error: { code: 'viewer-limit' } });
  expect(await f.media.open('document', { ...f.request, source: { kind: 'camera', cameraId: 'other' as D.Id<'camera'> } })).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  if (!a.ok || a.value.presentation.kind !== 'video' || !('streamId' in a.value.presentation.delivery)) throw new Error('Fixture failed');
  const p = portFixture(); f.media.attach('document', { media: a.value.ref, streamId: a.value.presentation.delivery.streamId, token: 'token' }, p.port);
  p.pull(); expect(p.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'packet' }));
  expect(await f.media.call('other', { method: 'get', input: a.value.ref })).toMatchObject({ ok: false });
  await f.media.closeOwner('document'); expect(f.camera.close).toHaveBeenCalledOnce(); expect(f.monitor.stop).toHaveBeenCalledWith('lease');
  expect(await f.media.call('document', { method: 'renew', input: a.value.ref })).toMatchObject({ ok: false });
});
it('releases a late-open lease after its document has closed', async () => {
  const f = fixture(); let resolve!: (value: { ok: true; value: string }) => void;
  f.monitor.acquire.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const opening = f.media.open('old-document', f.request);
  await vi.waitFor(() => expect(f.monitor.acquire).toHaveBeenCalled());
  await f.media.closeOwner('old-document'); resolve({ ok: true, value: 'late' });
  expect(await opening).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  expect(f.monitor.stop).toHaveBeenCalledWith('late'); expect(f.load).not.toHaveBeenCalled();
});
it('route removal closes a viewer, while unchanged independent LAN authorization survives Cloud removal', async () => {
  const f = fixture(); f.device.routes = [...f.device.routes, { channel: 'cloud', revision: 'cloud' }];
  f.request.target.expectedConfigurationRevision = savedBambuPrinter(f.device).routes[0].configurationRevision;
  expect((await f.media.open('doc', f.request)).ok).toBe(true);
  f.device.routes = f.device.routes.filter(r => r.channel === 'lan'); await f.media.reconcile(); expect(f.camera.close).not.toHaveBeenCalled();
  f.devices.list.mockResolvedValue([]); await f.media.reconcile(); expect(f.camera.close).toHaveBeenCalledOnce();
});
it('rejects disabled/unknown protocols before reading native samples', async () => {
  const f = fixture(); f.monitor.context.mockResolvedValue({ ok: true, value: { report: { ipcam: { ipcam_dev: '1', liveview: { local: 'disabled' } } } } });
  expect(await f.media.open('doc', f.request)).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
  expect(f.load).not.toHaveBeenCalled(); expect(f.monitor.stop).toHaveBeenCalledWith('lease');
});
it('binary channel bounds AVC, retains latest pending JPEG and grants one packet per pull', () => {
  const fail = vi.fn(), channel = new CameraChannel(fail), p = portFixture(); channel.attach(p.port);
  for (let i = 0; i < 100; i++) channel.push({ generation: 0, sequence: i, kind: 'jpeg', bytes: new Uint8Array([i]) });
  expect(p.port.postMessage).not.toHaveBeenCalled(); p.pull();
  expect(p.port.postMessage).toHaveBeenCalledWith({ type: 'packet', packet: { generation: 0, sequence: 0, kind: 'jpeg', bytes: new Uint8Array([99]) } });
  for (let i = 0; i < 65; i++) channel.push({ generation: 0, sequence: i, kind: 'segment', bytes: new Uint8Array([1]) });
  expect(fail).toHaveBeenCalledOnce(); channel.close(); p.disconnect(); expect(fail).toHaveBeenCalledOnce();
});

it('metadata boundary rejects secrets, malformed identities and excessive capability lists', () => {
  const { request } = fixture();
  expect(isBambuMediaRequest({ method: 'open', input: request })).toBe(true);
  expect(isBambuMediaRequest({ method: 'open', input: { ...request, url: 'private://secret' } })).toBe(false);
  expect(isBambuMediaRequest({ method: 'open', input: { ...request, client: { ...request.client, video: Array(17).fill(request.client.video[0]) } } })).toBe(false);
  expect(isBambuMediaAttachment({ media: { printerId: 'p', routeId: 'r', id: 'm' }, streamId: 's', token: 't' })).toBe(true);
  expect(isBambuMediaAttachment({ media: { printerId: 'p', routeId: 'r', id: 'm', owner: 'another-document' }, streamId: 's', token: 't' })).toBe(false);
});
