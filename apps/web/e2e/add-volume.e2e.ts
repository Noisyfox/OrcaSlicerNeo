import playwright from '../../desktop/node_modules/@playwright/test/index.js';
import { resolve } from 'node:path';
const { test, expect } = playwright;

test('real WASM adds object volumes from primitives and the browser file picker', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await page.getByTestId('preset-select').click();
  await page.getByRole('option', { name: 'Bambu Lab P1P 0.4 nozzle', exact: true }).click();
  await page.getByTestId('filament-add').click();
  await expect(page.getByTestId('filament-slot-2')).toBeVisible();
  const cube = resolve(import.meta.dirname, '../../../packages/slicer-wasm/fixtures/cube.stl');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(cube);
  await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('config-mode-scoped').click();
  const list = page.getByTestId('object-list');
  const rows = list.locator('section[data-testid^="plate-group-"] > div[data-testid^="object-"]');
  await expect(rows).toHaveCount(1);
  const button = rows.first().getByRole('button').first();
  await button.click({ button: 'right' });
  await page.getByTestId('objectlist-add-negative_volume').click();
  await page.getByTestId('objectlist-add-negative_volume-Sphere').click();
  const expand = list.locator('[data-testid^="object-expand-"]').first();
  await expect(expand).toBeVisible();
  await expand.click();
  const added = list.locator('[data-testid^="part-"]').filter({ hasText: 'Generic-Sphere' });
  await expect(added).toBeVisible();
  await expect(rows).toHaveCount(1);
  const materials = () => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { modelMaterialColours?: () => Array<{
      colour: string; opacity: number; transparent: boolean; depthWrite: boolean;
    }> };
  }).__orcaE2e?.modelMaterialColours?.() ?? []);
  await expect.poll(materials).toEqual(expect.arrayContaining([
    expect.objectContaining({ colour: '#8c8c8c', opacity: 0.4, transparent: true, depthWrite: true }),
  ]));
  await page.screenshot({ path: test.info().outputPath('selected-negative-volume.png') });
  const canvas = await page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]').boundingBox();
  if (!canvas) throw new Error('missing canvas');
  await page.mouse.click(canvas.x + canvas.width - 40, canvas.y + 80);
  await expect.poll(materials).toEqual(expect.arrayContaining([
    expect.objectContaining({ colour: '#4d4d4d', opacity: 0.4, transparent: true, depthWrite: true }),
  ]));
  await added.click({ button: 'right' });
  await expect(page.getByTestId('objectlist-add-model_part')).toHaveCount(0);
  await expect(page.getByTestId('objectlist-change-filament')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByTestId('history-undo').click();
  await expect(list).not.toContainText('Generic-Sphere');
  await page.getByTestId('history-redo').click();
  await expect(list).toContainText('Generic-Sphere');
  await button.click({ button: 'right' });
  await page.getByTestId('objectlist-add-parameter_modifier').click();
  const partChooser = page.waitForEvent('filechooser');
  await page.getByTestId('objectlist-add-parameter_modifier-load').click();
  await (await partChooser).setFiles(cube);
  await expect(list.locator('[data-testid^="part-"]')).toHaveCount(3);
  await expect(rows).toHaveCount(1);
  await expect.poll(materials).toEqual(expect.arrayContaining([
    expect.objectContaining({ colour: '#ffff80', opacity: 0.6, transparent: true, depthWrite: true }),
  ]));
  const modifierRow = list.locator('[data-testid^="part-"]').filter({ hasText: 'cube.stl' }).last();
  const modifierFilament = modifierRow.locator('[data-testid^="filament-cell-part-"]');
  await expect(modifierFilament).toHaveAttribute('role', 'combobox');
  await expect(modifierFilament).toHaveText('1');
  await expect(list.locator('[data-testid^="part-"] [role="checkbox"]')).toHaveCount(0);
  await modifierFilament.click();
  await page.getByRole('option', { name: 'Slot 2', exact: true }).click();
  await expect(modifierFilament).toHaveText('2');
  await modifierFilament.click();
  await page.getByRole('option', { name: 'Default', exact: true }).click();
  await expect(modifierFilament).toHaveText('1');
  // Assignment changes never replace the modifier's category rendering.
  await expect.poll(materials).toEqual(expect.arrayContaining([
    expect.objectContaining({ colour: '#ffff80', opacity: 0.6 }),
  ]));
  await page.screenshot({ path: test.info().outputPath('added-volumes.png') });
});


test('standalone Cube and Cube Part use the same Orca bed-relative size', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await page.getByTestId('preset-select').click();
  await page.getByRole('option', { name: 'Bambu Lab P1P 0.4 nozzle', exact: true }).click();
  const canvas = await page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]').boundingBox();
  if (!canvas) throw new Error('missing canvas');
  await page.mouse.click(canvas.x + canvas.width - 40, canvas.y + 80, { button: 'right' });
  await page.getByTestId('btn-add-primitive').click();
  await page.getByTestId('btn-add-cube').click();
  await page.getByTestId('config-mode-scoped').click();
  const row = page.getByTestId('object-list').locator('section[data-testid^="plate-group-"] > div[data-testid^="object-"]').first();
  const button = row.getByRole('button').first();
  await expect(button).toBeVisible();
  await button.click();
  const size = () => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { selectionBoundsWorld?: () => { size: number[] } | null };
  }).__orcaE2e?.selectionBoundsWorld?.()?.size);
  for (let axis = 0; axis < 3; axis++) await expect.poll(async () => (await size())?.[axis]).toBeCloseTo(25.6, 3);
  await button.click({ button: 'right' });
  await page.getByTestId('objectlist-add-model_part').click();
  await page.getByTestId('objectlist-add-model_part-Cube').click();
  // The add command selects only the new part. Measure its world bounds so
  // matching raw meshes cannot hide a wrong scale or instance transform.
  for (let axis = 0; axis < 3; axis++) await expect.poll(async () => (await size())?.[axis]).toBeCloseTo(25.6, 3);
});
