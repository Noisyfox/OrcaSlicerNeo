import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

// This suite intentionally has no mock mode. The staging step must have
// published both real wasm64 variants before either invocation is run.
test('real Web flow: import → profile → slice → layer → G-code download', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready');

  await page.getByTestId('preset-select').click();
  const picker = page.locator('[data-slot="combobox-content"]');
  await picker.locator('input').fill('Bambu Lab P1S 0.4 nozzle');
  await picker.locator('[data-slot="combobox-item"]').filter({ hasText: 'Bambu Lab P1S 0.4 nozzle' }).click();

  const input = page.locator('input[type="file"]');
  await page.getByTestId('btn-add-model').click();
  await input.setInputFiles(resolve(__dirname, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
  await expect(page.getByTestId('viewport')).toBeVisible();
  await expect(page.getByTestId('layer-scrubber')).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByTestId('btn-export').click();
  const result = await download;
  expect(result.suggestedFilename()).toMatch(/\.gcode$/);
  expect(await result.path()).toBeTruthy();
});
