import { expect, test } from '@playwright/test';
import { _electron, desktopLaunchOptions } from './electron-fixture';
import { startSnapmakerFixture } from './snapmaker-fixture';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('U1 Monitor uses the real camera utility and binary preload channel, recovers, and retires navigated documents', async () => {
  const fixture = await startSnapmakerFixture(), directory = await mkdtemp(join(tmpdir(), 'neo-u1-camera-'));
  const configuration = join(directory, 'printers.json');
  await writeFile(configuration, JSON.stringify({ version: 1, printers: [{ id: 'u1', driverId: 'snapmaker', displayName: 'U1 camera fixture',
    apiBaseUrl: fixture.baseUrl, apiKey: '', consoleUrl: '' }] }));
  const app = await _electron.launch({ ...desktopLaunchOptions(), env: { ...process.env, ORCA_E2E: '1', ORCA_E2E_PRINTER_CONFIG: configuration } });
  const starts = () => fixture.cameraCommands.filter(command => command.method === 'camera.start_monitor');
  const stops = () => fixture.cameraCommands.filter(command => command.method === 'camera.stop_monitor');
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60000 });
    const encoded = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
      canvas.getContext('2d')!.fillRect(0, 0, 64, 48); return canvas.toDataURL('image/jpeg').split(',')[1];
    });
    fixture.setCameraFrame(Buffer.from(encoded, 'base64'));
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-printer-select').click(); await page.getByTestId('device-select-u1').click();
    const card = page.getByTestId('camera-card'), image = card.locator('img');
    await expect(card.getByRole('button', { name: 'Play camera' })).toBeVisible();
    expect(starts()).toHaveLength(0); expect(fixture.cameraRequests()).toBe(0);
    expect(await app.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.name))).not.toContain('Orca Snapmaker Camera');
    await card.getByRole('button', { name: 'Play camera' }).click();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(64);
    expect(starts()).toHaveLength(1);
    const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.name));
    expect(processes).toContain('Orca Snapmaker Camera');
    await card.hover(); await expect.poll(() => starts().length).toBe(2);
    fixture.setCameraFailed(true);
    await expect(card.getByText('Recovering camera…', { exact: true })).toBeVisible();
    await expect(image).toHaveJSProperty('naturalWidth', 64);
    fixture.setCameraFailed(false);
    await expect(card.getByText('Recovering camera…', { exact: true })).toBeHidden();
    fixture.setCameraFrame(Buffer.from([255, 216, 0, 0, 255, 217]));
    await expect(card.getByText('Recovering camera…', { exact: true })).toBeVisible();
    await expect(image).toHaveJSProperty('naturalWidth', 64);
    fixture.setCameraFrame(Buffer.from(encoded, 'base64'));
    await expect(card.getByText('Recovering camera…', { exact: true })).toBeHidden();
    await page.locator('#app-tab-prepare').click(); await expect.poll(() => stops().length).toBe(1);
    await page.getByTestId('tab-device').click(); await expect.poll(() => starts().length).toBe(3);
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(64);
    await page.reload(); await expect.poll(() => stops().length).toBe(2);
    expect(stops()[1].params.clientid).toBe(starts()[2].params.clientid);
    const requests = fixture.cameraRequests(); await page.waitForTimeout(500); expect(fixture.cameraRequests()).toBe(requests);
  } finally { await app.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
