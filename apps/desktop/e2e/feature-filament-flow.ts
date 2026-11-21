import { expect, type Page } from '@playwright/test';
import { addPrimitive } from './add-primitive';

export async function verifyFeatureFilamentRouting(page: Page) {
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await page.getByTestId('filament-add').click();
  await expect(page.getByTestId('filament-slot-2')).toBeVisible();
  const group = page.getByTestId('config-category-toggle-Filament for Features');
  const filament = page.getByTestId('config-input-outer_wall_filament_id');
  const selected = filament.locator('[data-slot="select-value"]');
  await page.getByTestId('config-page-Multi.').click();
  await group.click();
  await expect(selected).toHaveText('Default');
  await filament.click();
  await expect(page.getByRole('option', { name: 'Inherit', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: /^2 - / }).click();
  await expect(selected).toHaveText(/^2 - /);

  await addPrimitive(page, 'cube');
  await page.getByTestId('config-mode-scoped').click();
  const list = page.getByTestId('object-list');
  const object = list.locator('section[data-testid^="plate-group-"] > div[data-testid^="object-"]').first();
  const row = object.locator('button.object-list-row').first();
  const parts = object.locator('[data-testid^="part-"]');
  const expand = object.locator('[data-testid^="object-expand-"]');
  await expect(parts).toHaveCount(0);
  await row.click();
  await expect(page.getByTestId('scoped-target-label')).toContainText('Object:');
  await page.getByTestId('config-page-Multi.').click();
  if (await group.getAttribute('aria-expanded') === 'false') await group.click();
  await expect(selected).toHaveText('Inherit');
  await filament.click();
  await page.getByRole('option', { name: /^2 - / }).click();
  await expect(selected).toHaveText(/^2 - /);

  await row.click({ button: 'right' });
  await page.getByTestId('objectlist-add-model_part').click();
  await page.getByTestId('objectlist-add-model_part-Cube').click();
  await expect(object.locator('[aria-label="Assembly"]')).toBeVisible();
  if (await parts.count() === 0) await expand.click();
  await parts.first().locator('button.object-list-row').first().click();
  await expect(page.getByTestId('scoped-target-label')).toContainText('Part:');
  await expect(selected).toHaveText('Inherit');
  await filament.click();
  await page.getByRole('option', { name: 'Default', exact: true }).click();
  await expect(selected).toHaveText('Default');
  await page.getByTestId('config-reset-outer_wall_filament_id').click();
  await expect(selected).toHaveText('Inherit');
  await row.click();
  await expect(selected).toHaveText(/^2 - /);
  await page.getByTestId('config-mode-project').click();
  await expect(selected).toHaveText(/^2 - /);
  await page.getByTestId('config-reset-outer_wall_filament_id').click();
  await expect(selected).toHaveText('Default');
}
