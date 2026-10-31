import { test, expect, configuredActivation } from './browser-fixture';
import { readFile } from 'node:fs/promises';
import { installSliceReceiptObserver, readSliceReceipts } from '../../desktop/e2e/runtime-receipts';

test('Web retains imported Convenience Mode without a device and requires an explicit mode choice', async ({ page }) => {
  test.skip(!process.env.ORCA_E2E_CONVENIENCE_PROJECT, 'Requires the native Convenience persistence fixture');
  const bytes = await readFile(process.env.ORCA_E2E_CONVENIENCE_PROJECT!);
  await page.addInitScript(profileActivation => {
    localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({ version: 1, profileActivation,
      selectedProfiles: { printer: 'Bambu Lab H2D 0.4 nozzle' }, projectLoadBehaviour: 'load_all', ui: { sidebarWidth: 340 } }));
  }, configuredActivation);
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await installSliceReceiptObserver(page, ['getNozzleMapping', 'mutateNozzleMapping', 'slicePlate']);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('titlebar-menu-trigger').click();
  await page.getByTestId('menu-file-trigger').hover();
  await page.locator('[data-slot="menubar-sub-content"]').hover({ position: { x: 8, y: 8 } });
  await page.getByTestId('file-open-project').click();
  await (await chooser).setFiles({ name: 'convenience.3mf', mimeType: 'application/octet-stream', buffer: bytes });
  await expect.poll(async () => {
    if (await page.getByTestId('project-load-choice-dialog').isVisible()) {
      await page.getByTestId('project-load-project').click(); await page.getByTestId('project-load-confirm').click();
    }
    if (await page.getByTestId('project-load-confirmation-dialog').isVisible())
      await page.getByTestId('project-load-confirmation-dialog-continue').click();
    return page.evaluate(() => (window as any).__orcaE2e.projectLoadEvidence().receipt);
  }, { timeout: 120_000 }).toMatchObject({ sourceDisplayName: 'convenience.3mf', nativeResult: { ok: true, mode: 'project' } });
  await expect(page.getByTestId('project-progress-dialog')).toHaveCount(0);
  if (await page.getByTestId('project-notice-dialog-close').isVisible()) await page.getByTestId('project-notice-dialog-close').click();
  await page.getByTestId('config-mode-plates').click(); await page.getByTestId('plate-properties-mapping').click();
  await expect(page.getByTestId('mapping-mode-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('mapping-mode-1')).toBeDisabled();
  await expect(page.getByTestId('nozzle-mapping-editor')).toContainText('Select a device matching');
  await page.getByTestId('output-mode-select').click();
  await page.getByRole('menuitem', { name: 'Filament mapping', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Convenience Mode (unavailable)', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Error');
  await expect(page.locator('[data-testid="slice-notification"][data-severity="error"] [data-slot="toast-description"]')).toContainText('Select a device matching');
  const beforeChoice = await readSliceReceipts(page) as any[];
  expect(beforeChoice.some(r => r.op === 'mutateNozzleMapping' || r.op === 'slicePlate')).toBe(false);
  await expect(page.getByTestId('mapping-mode-1')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('mapping-mode-2').click();
  await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 1');
});
