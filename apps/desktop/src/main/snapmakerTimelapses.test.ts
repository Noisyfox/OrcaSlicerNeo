import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import type { PrinterConfigurationDocument } from '@orca/printer-control';
import { cameraConfigurationDigest } from '../shared/snapmakerCamera';
import { SnapmakerTimelapseHost } from './snapmakerTimelapses';

const origin = 'http://127.0.0.1:1234';
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const configuration: PrinterConfigurationDocument = { version: 1, printers: [
    { id: 'u1', driverId: 'snapmaker', displayName: 'U1', apiBaseUrl: 'http://printer/proxy/', apiKey: 'local-key', consoleUrl: '' },
  ] };
  const sender = Object.assign(new EventEmitter(), { mainFrame: { url: origin + '/' }, isDestroyed: () => false }) as unknown as WebContents;
  const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent;
  const host = new SnapmakerTimelapseHost(async () => structuredClone(configuration), candidate => candidate === sender);
  const input = { printerId: 'u1', configurationDigest: await cameraConfigurationDigest(configuration.printers[0]), video: '/files/camera/test #%.mp4' };
  const open = async () => {
    const result = await host.call(event, { method: 'open', input }) as { ok: boolean; value: { id: string; url: string } };
    expect(result.ok).toBe(true);
    return result.value;
  };
  return { configuration, sender, event, host, input, open };
}

it('relays a same-document range with saved credentials and revokes the URL when closed', async () => {
  const { host, event, open } = await fixture();
  const fetchVideo = vi.fn<typeof fetch>(async () => new Response(Uint8Array.of(1, 2), {
    status: 206, headers: { 'Content-Range': 'bytes 0-1/10', 'Content-Length': '2', 'Accept-Ranges': 'bytes' },
  }));
  vi.stubGlobal('fetch', fetchVideo);
  const video = await open();
  const request = () => new Request(video.url, { headers: { Origin: origin, Range: 'bytes=0-1' } });
  expect((await host.serve(new Request(video.url, { headers: { Origin: 'http://other' } }))).status).toBe(404);
  expect(fetchVideo).not.toHaveBeenCalled();
  const response = await host.serve(new Request(video.url, { headers: { Range: 'bytes=0-1' } }));
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe('bytes 0-1/10');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(1, 2));
  expect(fetchVideo).toHaveBeenCalledWith('http://printer/proxy/server/files/camera/test%20%23%25.mp4', expect.objectContaining({
    method: 'GET', redirect: 'error', headers: expect.objectContaining({ Range: 'bytes=0-1', 'X-Api-Key': 'local-key' }),
  }));
  await host.call(event, { method: 'close', input: { id: video.id } });
  expect((await host.serve(request())).status).toBe(404);
});

it('rejects forged destinations and invalidates a grant when the route or document changes', async () => {
  const { host, event, sender, input, configuration, open } = await fixture();
  const fetchVideo = vi.fn();
  vi.stubGlobal('fetch', fetchVideo);
  expect(await host.call(event, { method: 'open', input: { ...input, video: '/files/camera/../../config/secret.mp4' } }))
    .toMatchObject({ ok: false, error: { code: 'invalid-target' } });
  const { url } = await open(), request = () => new Request(url, { headers: { Origin: origin } });
  configuration.printers[0].apiBaseUrl = 'http://new-printer/';
  expect((await host.serve(request())).status).toBe(409);
  expect(fetchVideo).not.toHaveBeenCalled();
  sender.emit('did-start-navigation', {}, origin + '/', false, true);
  expect((await host.serve(request())).status).toBe(404);
});
