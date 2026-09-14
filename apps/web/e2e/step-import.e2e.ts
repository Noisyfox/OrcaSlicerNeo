import playwright from '../../desktop/node_modules/@playwright/test/index.js';
const { expect, test } = playwright;
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const STEP_MODEL = resolve(here, '../../../packages/slicer-wasm/fixtures/step/step-box-20mm.step');

test('real Web STEP flow: Add Model → renders named solid → slice → download G-code', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  if (process.env.ORCA_WEB_NO_ISOLATION === '1') {
    await expect(page.getByTestId('serial-fallback-status')).toContainText('serial wasm64 fallback', { timeout: 30_000 });
  } else {
    await expect(page.getByTestId('serial-fallback-status')).toHaveCount(0);
  }
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('preset-select').click();
  await page.locator('[data-slot="combobox-content"] input').fill('Creality Ender-3 0.4 nozzle');
  const printer = page
    .locator('[data-slot="combobox-content"] [data-slot="combobox-item"]')
    .filter({ hasText: 'Creality Ender-3 0.4 nozzle' });
  await expect(printer).toHaveCount(1);
  await printer.click();
  await expect(page.getByTestId('btn-slice')).toBeDisabled();

  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(STEP_MODEL);
  await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByTestId('object-list')).toContainText('step-box-20mm.step', { timeout: 30_000 });
  await expect(page.getByTestId('viewport')).toBeVisible();

  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
  await expect(page.getByTestId('btn-export')).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.getByTestId('btn-export').click();
  const result = await download;
  expect(result.suggestedFilename()).toMatch(/\.gcode$/);
  expect(await result.path()).toBeTruthy();
});
