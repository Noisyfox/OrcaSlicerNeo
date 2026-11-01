import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, desktopLaunchOptions } from './electron-fixture';
import { installControlFixture, publishControlSnapshot } from './bambu-control-fixture';
import { installSliceReceiptObserver, readSliceReceipts } from './runtime-receipts';

test('real Convenience Mode uses selected-device observations without Sync or implicit device reads', async () => {
  test.skip(process.env.ORCA_E2E_REAL !== '1', 'Requires real native WASM');
  const preferences = join(mkdtempSync(join(tmpdir(), 'neo-convenience-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1,
    selectedProfiles: { printer: 'Bambu Lab H2D 0.4 nozzle' }, ui: { sidebarWidth: 340 } }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_PREFERENCES: preferences } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ ...desktopLaunchOptions(), env });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('preset-select')).toContainText('H2D');
    await installSliceReceiptObserver(page, ['setDeviceMaterialContext', 'getNozzleMapping', 'mutateNozzleMapping',
      'slicePlate', 'prepareMaterialImport', 'applyMaterialImport', 'synchronizePrinter']);
    await installControlFixture(app);
    await page.locator('#app-tab-device').click();
    await page.getByTestId('device-printer-select').click();
    await page.getByRole('option', { name: 'Workshop A', exact: true }).click();
    await expect.poll(async () => (await readSliceReceipts(page) as any[])
      .some(r => r.op === 'setDeviceMaterialContext' && r.direction === 'response' && r.result?.ok)).toBe(true);
    await page.locator('#app-tab-prepare').click();
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const bounds = await canvas.boundingBox(); if (!bounds) throw new Error('Missing viewport');
    await canvas.click({ button: 'right', position: { x: bounds.width - 40, y: 140 } });
    await page.getByTestId('btn-add-primitive').click(); await page.getByTestId('btn-add-cube').click();
    await page.getByTestId('config-mode-plates').click();
    await page.getByTestId('plate-properties-mapping').click();
    await expect(page.getByTestId('mapping-mode-1')).toBeEnabled();
    await page.getByTestId('mapping-mode-2').click();
    await page.getByTestId('mapping-filament-1').click();
    await page.getByRole('option', { name: 'Nozzle 2', exact: true }).click();
    const deviceReads = () => app.evaluate(() => globalThis.bambuControlFixture.requests
      .filter((r: any) => r.method === 'read' && r.input.source === 'device').length);
    const beforeReads = await deviceReads();
    await page.getByTestId('output-mode-select').click();
    await page.getByRole('menuitem', { name: 'Filament mapping', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Convenience Mode', exact: true }).click();
    await expect(page.getByTestId('mapping-mode-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('mapping-materials')).toHaveCount(0);
    await publishControlSnapshot(app, 'a', 'External task', false);
    await expect(page.getByTestId('printer-connection-indicator')).toHaveCount(0);
    await expect(page.getByTestId('mapping-mode-1')).toBeEnabled();
    await page.getByTestId('btn-slice').click();
    await expect.poll(async () => (await readSliceReceipts(page) as any[])
      .some(r => r.op === 'slicePlate' && r.direction === 'response' && r.result?.ok), { timeout: 180_000 }).toBe(true);
    await expect(page.getByTestId('mapping-confirmation')).toHaveCount(0);
    await expect(page.getByTestId('mapping-mode-1')).toHaveAttribute('aria-pressed', 'true');
    expect(await deviceReads()).toBe(beforeReads);
    expect((await readSliceReceipts(page) as any[]).filter(r => ['prepareMaterialImport', 'applyMaterialImport', 'synchronizePrinter'].includes(r.op))).toEqual([]);
    await page.getByTestId('mapping-mode-2').click();
    await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 2');
    const receipts = await readSliceReceipts(page) as any[];
    expect(receipts.filter(r => r.op === 'getNozzleMapping' && r.result?.saved.mode === 1)
      .every(r => r.result.saved.filamentMap?.[0] === 2)).toBe(true);
    expect(await app.evaluate(() => globalThis.bambuControlFixture.commands)).toEqual([]);
  } finally { await app.close(); }
});
