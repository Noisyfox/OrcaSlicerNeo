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
