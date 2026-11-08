import { test, expect } from './browser-fixture';
import { startSnapmakerFixture } from '../../desktop/e2e/snapmaker-fixture';

test('Web U1 camera decodes JPEG, renews on activity, recovers and releases hidden views', async ({ page }) => {
  const fixture = await startSnapmakerFixture();
  const commands: { method: string; params: { clientid: string } }[] = [];
  await page.routeWebSocket(`${fixture.baseUrl.replace('http:', 'ws:')}/websocket`, socket => {
    socket.onMessage(data => {
      const request = JSON.parse(String(data)); commands.push(request);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'camera.start_monitor'
        ? { state: 'success', url: '/files/camera/monitor.jpg', pw: 'fixture-unused', salt: 'fixture-unused', iterations: 654 }
        : { state: 'success' } }));
    });
  });
  const starts = () => commands.filter(command => command.method === 'camera.start_monitor');
  const stops = () => commands.filter(command => command.method === 'camera.stop_monitor');
  try {
    await page.addInitScript(baseUrl => localStorage.setItem('orca-slicer-neo:printer-configuration:v1', JSON.stringify({ version: 1,
      printers: [{ id: 'u1', driverId: 'snapmaker', displayName: 'U1 camera fixture', apiBaseUrl: baseUrl, apiKey: '', consoleUrl: '' }] })), fixture.baseUrl);
    await page.goto('/');
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
    const encoded = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
      const context = canvas.getContext('2d')!; context.fillStyle = '#369'; context.fillRect(0, 0, 64, 48);
      return canvas.toDataURL('image/jpeg').split(',')[1];
    });
    fixture.setCameraFrame(Buffer.from(encoded, 'base64'));
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-printer-select').click(); await page.getByTestId('device-select-u1').click();
    const card = page.getByTestId('camera-card');
    await expect(card.getByRole('button', { name: 'Play camera' })).toBeVisible();
    expect(starts()).toHaveLength(0); expect(fixture.cameraRequests()).toBe(0);
    await card.getByRole('button', { name: 'Play camera' }).click();
    const image = card.locator('img');
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(64);
    await expect.poll(() => fixture.cameraRequests()).toBeGreaterThan(1);
    expect(starts()).toHaveLength(1);

    await card.hover();
    await expect.poll(() => starts().length).toBe(2);
    await card.hover(); expect(starts()).toHaveLength(2);
    fixture.setCameraFrame(Buffer.from([255, 216, 0, 0, 255, 217]));
    await expect(card.getByText('Recovering camera…', { exact: true })).toBeVisible();
    await expect(image).toHaveJSProperty('naturalWidth', 64);
    fixture.setCameraFrame(Buffer.from(encoded, 'base64'));
    await expect(card.getByText('Recovering camera…', { exact: true })).toBeHidden();
    fixture.setCameraFailed(true);
    await expect(card.getByText('Recovering camera…', { exact: true })).toBeVisible();
    await expect(image).toHaveJSProperty('naturalWidth', 64);
    fixture.setCameraFailed(false);
    await expect(card.getByText('Recovering camera…', { exact: true })).toBeHidden();

    await page.locator('#app-tab-prepare').click();
    await expect.poll(() => stops().length).toBe(1);
    const stoppedCount = fixture.cameraRequests();
    await page.waitForTimeout(500); expect(fixture.cameraRequests()).toBe(stoppedCount);
    await page.getByTestId('tab-device').click();
    await expect.poll(() => starts().length).toBe(3);
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(64);
    await card.getByRole('button', { name: 'Stop camera' }).click();
    await expect.poll(() => stops().length).toBe(2);
    expect(stops()[1].params.clientid).toBe(starts().at(-1)!.params.clientid);
    await page.locator('#app-tab-prepare').click(); await page.getByTestId('tab-device').click();
    expect(starts()).toHaveLength(3);
  } finally { await fixture.close(); }
});
