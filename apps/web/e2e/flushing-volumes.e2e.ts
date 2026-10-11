import { test, expect } from './browser-fixture';

test('real Web Worker saves raw flushing volumes and preserves them on reopening', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('flushing-volumes-open')).toHaveCount(0);
  await page.getByTestId('filament-add').click();
  await expect(page.getByTestId('filament-slot-2')).toBeVisible();
  await page.getByTestId('flushing-volumes-open').click();
  const dialog = page.getByTestId('flushing-volumes-dialog');
  const cell = dialog.getByRole('spinbutton', { name: 'From material 1 to material 2' });
  await expect(cell).toBeVisible();
  await dialog.locator('#flush-multiplier').fill('1'); await dialog.locator('#flush-multiplier').blur();
  await cell.fill('123'); await cell.blur();
  await dialog.locator('#flush-multiplier').fill('0.5'); await dialog.locator('#flush-multiplier').blur();
  await expect(cell).toHaveValue('62');
  await dialog.getByTestId('flushing-save').click();
  await expect(dialog).toBeHidden();
  await page.getByTestId('flushing-volumes-open').click();
  await expect(cell).toHaveValue('62');
  await cell.focus(); await cell.blur();
  await dialog.locator('#flush-multiplier').fill('1'); await dialog.locator('#flush-multiplier').blur();
  await expect(cell).toHaveValue('123');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('flushing-volumes-open').click();
  await expect(cell).toHaveValue('62');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});
