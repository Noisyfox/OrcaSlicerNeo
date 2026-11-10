import { fixtureGcode, fixtureTimelapse, fixtureTimelapseIndex, startSnapmakerFixture, usbGcodeName } from '../../desktop/e2e/snapmaker-fixture';
import { test, expect } from './browser-fixture';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectFixturePrinter } from '../../desktop/e2e/printer-selection';

test('Web U1 exports configured G-code thumbnails from the shared renderer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120000 });
  await page.locator('#app-tab-prepare').click();
  await selectFixturePrinter(page, 'Snapmaker U1 0.4 nozzle');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(import.meta.dirname, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await page.getByTestId('btn-slice').click();
  await page.getByRole('dialog', { name: 'Confirm filament mapping', exact: true })
    .getByRole('button', { name: 'Confirm and slice', exact: true }).click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 90000 });
  await page.getByTestId('output-mode-select').click();
  await page.getByRole('menuitemradio', { name: 'Export', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByTestId('btn-export').click();
  const path = await (await downloading).path();
  if (!path) throw new Error('Missing downloaded G-code');
  const gcode = readFileSync(path, 'utf8');
  expect([...gcode.matchAll(/; thumbnail begin (\d+)x(\d+) /g)].map(match => `${match[1]}x${match[2]}`)).toEqual(['48x48', '300x300']);
});

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


test('Web U1 Storage browses, downloads and deletes over direct CORS transport', async ({ page }) => {
  const fixture = await startSnapmakerFixture();
  try {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { value: async ({ suggestedName }: { suggestedName: string }) =>
        (await navigator.storage.getDirectory()).getFileHandle(suggestedName, { create: true }) });
    });
    await page.addInitScript(baseUrl => localStorage.setItem('orca-slicer-neo:printer-configuration:v1', JSON.stringify({ version: 1,
      printers: [{ id: 'u1', driverId: 'snapmaker', displayName: 'U1 fixture', apiBaseUrl: baseUrl, apiKey: 'fixture-key', consoleUrl: '' }] })), fixture.baseUrl);
    await page.goto('/');
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-printer-select').click();
    await page.getByTestId('device-select-u1').click();
    await page.locator('#device-tab-storage').click();
    const storage = page.getByTestId('printer-storage');
    await expect(storage.getByRole('img', { name: 'Thumbnail of external.gcode' })).toHaveJSProperty('naturalWidth', 1);
    await storage.getByRole('checkbox', { name: 'Select external.gcode', exact: true }).check();
    await expect(storage.getByRole('status').filter({ hasText: '1 selected' })).toBeVisible();
    await storage.getByRole('button', { name: 'Download selected', exact: true }).click();
    const saved = (name: string) => page.evaluate(async filename => {
      try {
        const handle = await (await navigator.storage.getDirectory()).getFileHandle(filename);
        return (await handle.getFile()).text();
      } catch { return null; }
    }, name);
    await expect.poll(() => saved('external.gcode')).toBe(fixtureGcode);
    expect(fixture.downloads).toEqual([{ name: 'external.gcode', key: 'fixture-key' }]);
    await expect(storage.getByRole('button', { name: /Print selected file|Play selected video/ })).toHaveCount(0);
    await storage.getByRole('button', { name: 'Delete selected', exact: true }).click();
    expect(fixture.deleted).toEqual([]);
    const confirmation = page.getByRole('dialog', { name: /Delete printer files\?|File deletion/ });
    await confirmation.getByRole('button', { name: 'Delete files', exact: true }).click();
    await expect(confirmation.getByRole('status')).toContainText('1 deleted');
    await confirmation.getByRole('button', { name: 'Close', exact: true }).last().click();
    expect(fixture.deleted).toEqual(['external.gcode']);
    await storage.getByRole('combobox', { name: 'Storage' }).click();
    await page.getByRole('option', { name: 'USB drive' }).click();
    await expect(storage.getByRole('img', { name: `Thumbnail of ${usbGcodeName}` })).toHaveJSProperty('naturalWidth', 1);
    expect(fixture.storageListReads()).toBe(2);
    await storage.getByRole('tab', { name: 'Timelapse', exact: true }).click();
    await storage.getByRole('checkbox', { name: 'Select Fixture video.mp4', exact: true }).check();
    await storage.getByRole('button', { name: 'Download selected', exact: true }).click();
    await expect.poll(() => saved('Fixture video.mp4')).toBe(fixtureTimelapse);
    expect(fixture.downloads.at(-1)).toEqual({ name: 'fixture.mp4', key: 'fixture-key' });
    await storage.getByRole('button', { name: 'Delete selected', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Delete files', exact: true }).click();
    await expect(confirmation.getByRole('status')).toContainText('1 deleted');
    expect(fixture.deleted).toEqual(['external.gcode', fixtureTimelapseIndex]);
  } finally { await fixture.close(); }
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
