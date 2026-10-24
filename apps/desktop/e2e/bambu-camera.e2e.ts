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

import { _electron as desktopElectron, desktopLaunchOptions } from './electron-fixture';
import { installControlFixture } from './bambu-control-fixture';
import { installCameraFixture } from './bambu-camera-fixture';
test('shared Monitor displays actual JPEG frames, retains controls and releases hidden/stopped views', async () => {
  const app = await desktopElectron.launch({ ...desktopLaunchOptions(), env: { ...process.env, ORCA_E2E: '1' } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30000 });
    await installCameraFixture(app, page); await installControlFixture(app, true);
    await page.getByTestId('tab-device').click(); await page.getByTestId('device-printer-select').click();
    await page.getByRole('option', { name: 'Workshop A', exact: true }).click();
    const card = page.getByTestId('camera-card');
    await expect(card.getByRole('button', { name: 'Play camera' })).toBeVisible();
    const counts = () => app.evaluate(() => ({ opened: globalThis.cameraFixture.opened, closed: globalThis.cameraFixture.closed.length }));
    expect(await counts()).toEqual({ opened: 0, closed: 0 });
    await card.getByRole('button', { name: 'Play camera' }).click();
    await expect.poll(() => card.getByAltText('Live camera').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
    await expect(card.getByText('Connecting…')).toHaveCount(0);
    const fullscreen = card.getByRole('button', { name: 'Fullscreen', exact: true });
    await fullscreen.click(); await expect(fullscreen).toBeEnabled();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    expect((await card.getByAltText('Live camera').boundingBox())!.height).toBeGreaterThan(400);
    await fullscreen.click(); await expect(fullscreen).toBeEnabled();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await page.locator('#device-content').getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.bambuControlFixture.commands.length)).toBe(1);
    await page.locator('#app-tab-home').click(); await expect.poll(counts).toEqual({ opened: 1, closed: 1 });
    await page.getByTestId('tab-device').click(); await expect.poll(counts).toEqual({ opened: 2, closed: 1 });
    await expect.poll(() => card.getByAltText('Live camera').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
    await card.getByRole('button', { name: 'Stop camera' }).click(); await expect.poll(counts).toEqual({ opened: 2, closed: 2 });
    await page.locator('#app-tab-home').click(); await page.getByTestId('tab-device').click();
    expect(await counts()).toEqual({ opened: 2, closed: 2 });
    await card.getByRole('button', { name: 'Play camera' }).click(); await expect.poll(counts).toEqual({ opened: 3, closed: 2 });
    await page.getByTestId('device-printer-select').click(); await page.getByRole('option', { name: 'Workshop B', exact: true }).click();
    await expect.poll(counts).toEqual({ opened: 3, closed: 3 });
    await expect(card.getByRole('button', { name: 'Play camera' })).toBeVisible();
  } finally { await app.close(); }
});
