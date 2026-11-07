import { startSnapmakerFixture } from '../../desktop/e2e/snapmaker-fixture';
import { test, expect } from './browser-fixture';

test('Web persists a manual Snapmaker connection without a model or printer access', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.getByTestId('tab-device').click();
  await page.getByTestId('device-add-printer').click();
  await page.getByTestId('device-adapter').click();
  await page.getByRole('option', { name: 'Snapmaker', exact: true }).click();
  await page.getByTestId('device-display-name').fill('U1 browser');
  await page.getByTestId('device-api-base-url').fill('http://127.0.0.1:9');
  await page.getByTestId('device-save-printer').click();
  await expect(page.getByTestId('device-config-dialog')).toBeHidden();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('orca-slicer-neo:printer-configuration:v1')!).printers[0]);
  expect(saved.driverId).toBe('snapmaker');
  expect(saved.printerModel).toBeUndefined();
  await page.reload();
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.getByTestId('tab-device').click();
  await page.getByTestId('device-printer-select').click();
  await page.getByTestId(`device-select-${saved.id}`).click();
  await page.getByTestId(`device-edit-${saved.id}`).click();
  await expect(page.getByTestId('device-adapter')).toContainText('Snapmaker');
});


test('Web U1 direct transport monitors and saves preferences without a gateway', async ({ page }) => {
  const fixture = await startSnapmakerFixture();
  try {
    await page.addInitScript(baseUrl => localStorage.setItem('orca-slicer-neo:printer-configuration:v1', JSON.stringify({ version: 1, printers: [{ id: 'u1', driverId: 'snapmaker', displayName: 'U1 fixture', apiBaseUrl: baseUrl, apiKey: '', consoleUrl: '' }] })), fixture.baseUrl);
    await page.goto('/'); await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
    await page.getByTestId('tab-device').click(); await page.getByTestId('device-printer-select').click(); await page.getByTestId('device-select-u1').click();
    await page.locator('#device-tab-monitor').click();
    const preview = page.getByRole('img', { name: 'Current print preview', exact: true });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    await expect(page.getByRole('button', { name: 'Load to Toolhead 2', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Load to Toolhead 2', exact: true }).click();
    await expect.poll(() => fixture.scripts).toContain('FEED_AUTO MODULE=left CHANNEL=0 LOAD=1');
    await page.getByRole('combobox', { name: 'Auto-refill', exact: true }).click();
    await page.getByRole('option', { name: 'On', exact: true }).click();
    await page.getByRole('button', { name: 'Save printer preferences' }).click();
    await expect(page.getByText('Printer preferences saved and verified.')).toBeVisible();
    expect(fixture.scripts).toContain('SET_PRINT_PREFERENCES AUTO_REPLENISH_FILAMENT=1');
  } finally { await fixture.close(); }
});
