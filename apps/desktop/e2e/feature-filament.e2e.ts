import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { addPrimitive } from './add-primitive';
import { _electron } from './electron-fixture';

const DESKTOP_ROOT = resolve(__dirname, '..');
async function launchApp() {
  const env = { ...process.env, ORCA_E2E: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
}

test('edits feature filament routes for objects and model parts', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('filament-add').click();
    await expect(page.getByTestId('filament-slot-2')).toBeVisible();
    await addPrimitive(page, 'cube');
    await page.getByTestId('config-mode-scoped').click();
    const list = page.getByTestId('object-list');
    const object = list.locator('section[data-testid^="plate-group-"] > div[data-testid^="object-"]').first();
    const row = object.locator('button.object-list-row').first();
    await row.click();
    await page.getByTestId('config-page-Multi.').click();
    const group = page.getByTestId('config-category-toggle-Filament for Features');
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await group.click();
    const filament = page.getByTestId('config-input-outer_wall_filament_id');
    const selected = filament.locator('[data-slot="select-value"]');
    await expect(selected).toHaveText('Inherit');
    await filament.click();
    await page.getByRole('option', { name: /^2 - / }).click();
    await expect(selected).toHaveText(/^2 - /);

    await row.click({ button: 'right' });
    await page.getByTestId('objectlist-add-model_part').click();
    await page.getByTestId('objectlist-add-model_part-Cube').click();
    const parts = object.locator('[data-testid^="part-"]');
    if (await parts.count() === 0) await object.locator('[data-testid^="object-expand-"]').click();
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
  } finally {
    await app.close();
  }
});
