import { expect, test } from '@playwright/test';
import { _electron, desktopLaunchOptions } from './electron-fixture';
import { installControlFixture } from './bambu-control-fixture';
import { Ipc } from '../src/shared/ipc';

test('Prepare sync uses Bambu observations, commits mixed hardware and reviews one native material batch', async () => {
  const app = await _electron.launch({ ...desktopLaunchOptions(), env: { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1' } });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60_000 });
    await page.locator('#app-tab-prepare').click();
    await installControlFixture(app);
    // The IPC fixture already passes through the Bambu telemetry normalizer.
    // Supply identified hardware for this import journey; protocol decoding is
    // independently covered by the agent's telemetry tests.
    await app.evaluate(({ BrowserWindow }, channel) => {
      const current = globalThis.bambuControlFixture.data['bambu:a'];
      const descriptor = current.snapshot.values.descriptor;
      if (descriptor?.kind !== 'known') throw new Error('Missing fixture descriptor');
      descriptor.value.topology.nozzles.forEach((nozzle, i) => {
        nozzle.diameterMm = i === 0 ? 0.6 : 0.4; nozzle.flowType = i === 0 ? 'high flow' : 'standard flow'; nozzle.flowReporting = 'supported';
      });
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, 'printers');
    }, Ipc.bambuChanged);
    await page.getByTestId('printer-sync').click();
    const dialog = page.getByTestId('prepare-synchronization-dialog');
    await expect(dialog.getByRole('combobox', { name: 'Synchronization device' })).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Synchronization device' }).selectOption('bambu:a');
    await dialog.getByRole('button', { name: 'Connect and sync' }).click();
    await expect(dialog.getByRole('button', { name: 'Switch Printer and sync' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Switch Printer and sync' }).click();
    await expect(dialog.getByText('Printer synchronized. Continue with Filament sync?')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('preset-select')).toContainText('H2D');
    await expect(page.getByTestId('printer-nozzle-row')).toContainText('0.6');
    await expect(page.getByTestId('printer-nozzle-row')).toContainText('0.4');
    await dialog.getByRole('button', { name: 'Continue to Filament sync' }).click();
    await expect(dialog.getByRole('combobox', { name: 'Filament sync mode' })).toHaveValue('rebuild');
    await expect(dialog.getByLabel('Device materials')).toContainText('AMS');
    await expect(dialog.getByRole('button', { name: 'Apply Filament sync' })).toBeEnabled();
    const retainedTokens = await app.evaluate(() => [...globalThis.bambuControlFixture.tokens].sort());
    await dialog.getByRole('button', { name: 'Refresh device' }).click();
    await expect(dialog.getByRole('button', { name: 'Apply Filament sync' })).toBeEnabled();
    await expect.poll(() => app.evaluate(() => [...globalThis.bambuControlFixture.tokens].sort())).toEqual(retainedTokens);
    await page.screenshot({ path: test.info().outputPath('filament-sync-review.png'), fullPage: true });
    await dialog.getByRole('button', { name: 'Apply Filament sync' }).click();
    await expect(dialog).toHaveCount(0); await expect(page.getByTestId('filament-rack')).toContainText('Material (14)');
    // Printer and Filament are separate history entries; Undo material import keeps hardware.
    await page.getByTestId('history-undo').click();
    await expect(page.getByTestId('filament-rack')).toContainText('Material (1)');
    await expect(page.getByTestId('preset-select')).toContainText('H2D');
    await expect(page.getByTestId('printer-nozzle-row')).toContainText('0.6');
    await page.getByTestId('filament-sync').click();
    await expect(dialog.getByRole('combobox', { name: 'Synchronization device' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Apply Filament sync' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('#app-tab-device').click();
    await page.getByTestId('device-printer-select').click();
    await page.getByRole('option', { name: 'Workshop B', exact: true }).click();
    await expect(page.locator('#device-content').getByText('Second task', { exact: true })).toBeVisible();
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('printer-nozzle-row')).toContainText('0.6');
    await page.getByTestId('filament-sync').click();
    await expect(dialog.getByText('Workshop B · H2D')).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Synchronization device' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await app.evaluate(() => globalThis.bambuControlFixture.commands)).toEqual([]);
  } finally { await app.close(); }
});
