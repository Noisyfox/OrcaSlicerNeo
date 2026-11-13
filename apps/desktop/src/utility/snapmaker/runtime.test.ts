import { afterEach, expect, it, vi } from 'vitest';
import { U1_CAMERA_ID } from '@orca/printer-control';
import type { PrinterConfiguration } from '@orca/platform-contract';
import type * as D from '@orca/platform-contract';
import { SnapmakerCameraRuntime } from './runtime';
import { cameraConfigurationDigest, type CameraRequest } from '../../shared/snapmakerCamera';
import type { CameraPort } from '../bambu/mediaChannel';

class Socket extends EventTarget {
  readyState: 0 | 1 | 2 | 3 = 1;
  sent: { method: string; params: { clientid: string } }[] = [];
  reply = true;
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  send(text: string) {
    const request = JSON.parse(text); this.sent.push(request);
    if (this.reply) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: request.method === 'camera.start_monitor' ? { state: 'success', url: '/files/camera/monitor.jpg' } : { state: 'success' } }) })));
  }
}
const runtimes: SnapmakerCameraRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); });
async function fixture() {
  const printer: PrinterConfiguration = { id: 'u1', driverId: 'snapmaker', displayName: 'U1', apiBaseUrl: 'http://printer', apiKey: '', consoleUrl: '' };
  const socket = new Socket(), changed = vi.fn();
  const runtime = new SnapmakerCameraRuntime({ sockets: { create: () => socket }, http: { request: async () => ({ status: 200, json: async () => ({}), bytes: async () => new Uint8Array([255, 216, 255, 217]) }) } }, changed);
  runtimes.push(runtime); runtime.updateConfiguration({ version: 1, printers: [printer] });
  const grant = { printer, revision: 'revision-1' };
  const request: CameraRequest = { method: 'open', input: { configurationDigest: await cameraConfigurationDigest(printer), request: {
    target: { printerId: 'u1' as D.Id<'printer'>, routeId: 'snapmaker:u1' as D.Id<'route'>, expectedConfigurationRevision: 'revision-1' }, requestId: 'open' as D.Id<'request'>, source: { kind: 'camera', cameraId: U1_CAMERA_ID },
    client: { video: [{ transport: 'jpeg-frames', codecIds: ['jpeg'] }], imageMimeTypes: [], contentFormats: [] } } } };
  return { runtime, socket, changed, printer, grant, request, open: () => runtime.call('document', request, grant) as Promise<D.Result<D.MediaDescriptor>> };
}
it('coalesces opens, keeps connection data private, and rejects another document and stream identity', async () => {
  const f = await fixture(), [first, duplicate] = await Promise.all([f.open(), f.open()]);
  expect(first).toEqual(duplicate); expect(f.socket.sent).toHaveLength(1);
  expect(JSON.stringify(first)).not.toContain('http://printer');
  if (!first.ok) throw new Error('Open failed');
  expect(await f.runtime.call('other', { method: 'get', input: first.value.ref })).toMatchObject({ ok: false });
  const handlers = new Map<string, (event?: any) => void>();
  const port = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn(), on: (event: string, handler: (data?: any) => void) => handlers.set(event, handler) } as CameraPort;
  f.runtime.connect('other', { media: first.value.ref, streamId: 'bad' as D.Id<'media-stream'>, token: 'token' }, port); expect(port.close).toHaveBeenCalledOnce();
  if (first.value.presentation.kind !== 'video' || first.value.presentation.delivery.transport !== 'jpeg-frames') throw new Error('Invalid descriptor');
  f.runtime.connect('document', { media: first.value.ref, streamId: first.value.presentation.delivery.streamId, token: 'token' }, port);
  expect(port.postMessage).not.toHaveBeenCalled(); handlers.get('message')?.({ data: 'pull' });
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'packet' })));
  await f.runtime.closeOwner('document');
  expect(f.socket.sent.at(-1)?.method).toBe('camera.stop_monitor');
  expect(f.socket.sent.at(-1)?.params.clientid).toBe(f.socket.sent[0].params.clientid);
});
it('cancels a pending open when its document disappears', async () => {
  const f = await fixture(); f.socket.reply = false;
  const opening = f.open();
  await vi.waitFor(() => expect(f.socket.sent).toHaveLength(1));
  await f.runtime.closeOwner('document'); f.socket.reply = true;
  expect(await opening).toMatchObject({ ok: false });
  await vi.waitFor(() => expect(f.socket.readyState).toBe(3));
});
it('invalidates changed configuration before further frame publication and preserves the original stop connection', async () => {
  const f = await fixture(), opened = await f.open(); if (!opened.ok) throw new Error('Open failed');
  f.runtime.updateConfiguration({ version: 1, printers: [{ ...f.printer, apiBaseUrl: 'http://replacement' }] });
  await vi.waitFor(async () => expect(await f.runtime.call('document', { method: 'get', input: opened.value.ref })).toMatchObject({ ok: true, value: { state: 'closed', error: { code: 'stale-context' } } }));
  expect(f.socket.sent.at(-1)?.method).toBe('camera.stop_monitor');
});
