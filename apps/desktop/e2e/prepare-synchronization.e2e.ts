import { expect, test } from '@playwright/test';
import { _electron, desktopLaunchOptions } from './electron-fixture';
import { installControlFixture, publishControlSnapshot } from './bambu-control-fixture';
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
      for (const data of Object.values(globalThis.bambuControlFixture.data)) {
        const materials = data.snapshot.values.materials;
        if (materials?.kind === 'known') {
          const unidentified = materials.value.topology.slots.find(slot => materials.value.topology.units.some(unit => unit.id === slot.unitId && unit.kind === 'manual-holder'));
          for (const slot of materials.value.state.slots) if (slot.material.kind === 'known' && slot.material.value) {
            slot.material.value.catalogRefs = slot.slotId === unidentified?.id ? [] : [{ namespace: 'fixture-material', value: slot.slotId }];
            if (slot.slotId === unidentified?.id) {
              slot.material.value.materialType = null; slot.material.value.color = { kind: 'solid', rgba: '#00000000' };
            }
          }
        }
      }
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, 'printers');
    }, Ipc.bambuChanged);
    await page.getByTestId('printer-sync').click();
    const dialog = page.getByTestId('prepare-synchronization-dialog');
    await expect(dialog.getByRole('combobox', { name: 'Synchronization device' })).toBeVisible();
    await expect(dialog).toHaveCSS('opacity', '1');
    await page.screenshot({ path: test.info().outputPath('sync-device-chooser.png'), fullPage: true });
    await dialog.getByRole('combobox', { name: 'Synchronization device' }).click();
    await page.getByRole('option', { name: 'Workshop A', exact: true }).click();
    await dialog.getByRole('button', { name: 'Connect and sync' }).click();
    await expect(dialog.getByRole('button', { name: 'Switch Printer and sync' })).toBeVisible();
    await expect(page.getByTestId('printer-connection-indicator')).toHaveCount(0);
    await expect(dialog).toHaveCSS('opacity', '1');
    await page.screenshot({ path: test.info().outputPath('sync-printer-confirmation.png'), fullPage: true });
    const materialDeviceReadCount = () => app.evaluate(() => {
      const requests = globalThis.bambuControlFixture.requests as { method: string; input: { source?: string; topics?: string[] } }[];
      return requests.filter(r => r.method === 'read' && r.input.source === 'device' && r.input.topics?.includes('materials')).length;
    });
    expect(await materialDeviceReadCount()).toBe(0);
    await dialog.getByRole('button', { name: 'Switch Printer and sync' }).click();
    await expect(dialog.getByText('Printer synchronized. Continue with Filament sync?')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('preset-select')).toContainText('H2D');
    await expect(page.getByTestId('preset-select').getByTestId('printer-connection-indicator')).toBeVisible();
    await expect(page.getByTestId('printer-nozzle-row')).toContainText('0.6');
    await expect(page.getByTestId('printer-nozzle-row')).toContainText('0.4');
    await dialog.getByRole('button', { name: 'Continue to Filament sync' }).click();
    // Orca bypasses details for clean, empty plates even when the rack is seeded.
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('filament-rack')).toContainText('Material (13)');
    await page.getByTestId('history-undo').click();
    await expect(page.getByTestId('filament-rack')).toContainText('Material (1)');
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const bounds = await canvas.boundingBox(); if (!bounds) throw new Error('Missing viewport');
    await canvas.click({ button: 'right', position: { x: bounds.width - 40, y: 140 } });
    await expect(page.getByTestId('ctx-menu')).toBeVisible();
    await page.getByTestId('btn-add-primitive').click();
    await page.getByTestId('btn-add-cube').click();
    await page.getByTestId('filament-sync').click();
    await expect(dialog.getByRole('combobox', { name: 'Filament sync mode' })).toContainText('Update project mapping');
    await dialog.getByRole('combobox', { name: 'Filament sync mode' }).click();
    await page.getByRole('option', { name: 'Rebuild from device', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Filament sync mode' })).toContainText('Rebuild from device');
    await expect(dialog.getByLabel('Device materials')).toContainText('AMS');
    await expect(dialog.getByLabel('Device materials').getByRole('row').filter({ hasText: 'Not eligible for synchronization' })).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Apply Filament sync' })).toBeEnabled();
    expect(await materialDeviceReadCount()).toBe(0);
    const retainedTokens = await app.evaluate(() => [...globalThis.bambuControlFixture.tokens].sort());
    await dialog.getByRole('button', { name: 'Refresh device' }).click();
    await expect(dialog.getByRole('button', { name: 'Apply Filament sync' })).toBeEnabled();
    expect(await materialDeviceReadCount()).toBe(1);
    await expect.poll(() => app.evaluate(() => [...globalThis.bambuControlFixture.tokens].sort())).toEqual(retainedTokens);
    await expect(dialog).toHaveCSS('opacity', '1');
    await page.screenshot({ path: test.info().outputPath('filament-sync-review.png'), fullPage: true });
    await dialog.getByRole('checkbox', { name: 'Colors only', exact: true }).check();
    await expect(dialog.getByLabel('Material synchronization mapping').locator('tbody tr')).toHaveCount(1);
    await dialog.getByRole('checkbox', { name: 'Colors only', exact: true }).uncheck();
    await dialog.getByRole('combobox', { name: 'Filament sync mode' }).click();
    await page.getByRole('option', { name: 'Update project mapping', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Source for material 1', exact: true })).toBeVisible();
    await dialog.getByRole('checkbox', { name: 'Colors only', exact: true }).check();
    await expect(dialog.getByRole('checkbox', { name: 'Colors only', exact: true })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Append unused device materials', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('checkbox', { name: 'Append unused device materials', exact: true })).not.toBeChecked();
    await expect(dialog.getByTestId('sync-additions')).toHaveCount(0);
    await dialog.getByRole('checkbox', { name: 'Colors only', exact: true }).uncheck();
    await dialog.getByRole('checkbox', { name: 'Append unused device materials', exact: true }).uncheck();
    await expect(dialog.getByRole('checkbox', { name: 'Append unused device materials', exact: true })).not.toBeChecked();
    await dialog.getByRole('combobox', { name: 'Source for material 1', exact: true }).click();
    await page.getByRole('option', { name: 'AMS 2 Pro 0 · Slot 1', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Source for material 1', exact: true })).toContainText('AMS 2 Pro 0 · Slot 1');
    await expect(dialog).toHaveCSS('opacity', '1');
    await page.screenshot({ path: test.info().outputPath('filament-sync-mapping.png'), fullPage: true });
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(dialog.getByRole('button', { name: 'Apply Filament sync' })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath('filament-sync-mapping-compact.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog.getByRole('combobox', { name: 'Filament sync mode' }).click();
    await page.getByRole('option', { name: 'Rebuild from device', exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply Filament sync' }).click();
    await expect(dialog).toHaveCount(0); await expect(page.getByTestId('filament-rack')).toContainText('Material (13)');
    // Printer and Filament are separate history entries; Undo material import keeps hardware.
    await page.getByTestId('history-undo').click();
    await expect(page.getByTestId('filament-rack')).toContainText('Material (1)');
    await expect(page.getByTestId('preset-select')).toContainText('H2D');
    await expect(page.getByTestId('printer-nozzle-row')).toContainText('0.6');
    await page.getByTestId('filament-sync').click();
    await expect(dialog.getByRole('combobox', { name: 'Synchronization device' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Apply Filament sync' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.screenshot({ path: test.info().outputPath('printer-model-match-indicator.png'), fullPage: true });
    await page.getByTestId('filament-preset-1').click();
    const installed = page.getByTestId('device-filament-options');
    await expect(installed.getByRole('menuitem', { name: /External/ }).first()).toBeVisible();
    const menu = page.getByRole('menu', { name: 'Filament preset for slot 1', exact: true });
    await expect(menu).toHaveCSS('opacity', '1');
    await page.screenshot({ path: test.info().outputPath('device-filament-menu.png'), fullPage: true });
    const search = menu.getByPlaceholder('Search compatible presets…');
    await search.fill('External');
    await expect(installed.getByRole('menuitem')).toHaveCount(1);
    await expect(installed.getByRole('menuitem', { name: /AMS/ })).toHaveCount(0);
    await search.fill('');
    await installed.getByRole('menuitem', { name: /AMS 2 Pro 0 · Slot 1:/ }).click();
    await expect(page.getByTestId('filament-colour-1')).toHaveAttribute('value', '#33aaffff');
    await expect(page.getByTestId('filament-rack')).toContainText('Material (1)');
    await page.getByTestId('history-undo').click();
    await expect(page.getByTestId('filament-colour-1')).toHaveAttribute('value', '#26a69a');
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
    await publishControlSnapshot(app, 'b', 'Second task', false);
    await expect(page.getByTestId('printer-connection-indicator')).toHaveCount(0);
    await page.getByTestId('filament-preset-1').click();
    await expect(installed).toHaveCount(0);
    await expect(menu.getByText('System presets', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await publishControlSnapshot(app, 'b', 'Second task', true);
    await expect(page.getByTestId('printer-connection-indicator')).toBeVisible();
    expect(await app.evaluate(() => globalThis.bambuControlFixture.commands)).toEqual([]);
  } finally { await app.close(); }
});
