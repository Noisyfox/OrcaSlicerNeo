import { test, expect, _electron } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('camera metadata and binary stream cross real isolated preload/utility ports and navigation releases the view', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-camera-ipc-'));
  const app = await _electron.launch({ args: [resolve('out/main/bambu-camera-smoke.js')], env: { ...process.env, ORCA_BAMBU_SMOKE_DIRECTORY: directory } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!(window as unknown as { orca: import('../src/shared/ipc').ElectronBridge }).orca);
    const descriptor = await page.evaluate(async () => {
      const result = await (window as unknown as { orca: import('../src/shared/ipc').ElectronBridge }).orca.bambu.media('open', {
        target: { printerId: 'bambu:fixture', routeId: 'bambu:fixture:agent' }, requestId: 'fixture-view', source: { kind: 'camera', cameraId: 'chamber' },
        client: { video: [{ transport: 'jpeg-frames', codecIds: ['jpeg'] }], imageMimeTypes: ['image/jpeg'], contentFormats: [] },
      } as never);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
    expect(JSON.stringify(descriptor)).not.toContain('fixture-secret'); expect(JSON.stringify(descriptor)).not.toContain('192.0.2.1');
    const packet = await page.evaluate(async descriptor => {
      const token = 'fixture-port-offer';
      const received = new Promise(resolve => window.addEventListener('message', function offer(event) {
        if (event.source !== window || event.data?.channel !== 'orca:bambu-media' || event.data.token !== token) return;
        window.removeEventListener('message', offer);
        const port = event.ports[0];
        port.onmessage = event => { const packet = event.data.packet; if (packet) resolve({ ...packet, bytes: [...packet.bytes] }); };
        port.start(); port.postMessage('pull');
      }));
      (window as unknown as { orca: import('../src/shared/ipc').ElectronBridge }).orca.bambu.connectMedia({ media: descriptor.ref, streamId: (descriptor.presentation as any).delivery.streamId, token });
      return received;
    }, descriptor);
    expect(packet).toEqual({ kind: 'jpeg', generation: 0, sequence: 0, bytes: [255, 216, 255, 217] });
    await page.goto('data:text/html,<title>New document</title>');
    await expect.poll(() => readFile(join(directory, 'camera-closed'), 'utf8').catch(() => '')).toContain('closed');
    const oldResource = await page.evaluate(ref => (window as unknown as { orca: import('../src/shared/ipc').ElectronBridge }).orca.bambu.media('get', ref), descriptor.ref);
    expect(oldResource).toMatchObject({ ok: false, error: { code: 'invalid-target' } });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
