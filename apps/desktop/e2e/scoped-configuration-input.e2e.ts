import { _electron, expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test('Project override highlights its category and enables Reset only while local values exist', async () => {
  const desktop = resolve(__dirname, '..');
  const env = { ...process.env, ORCA_E2E: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: desktop, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60_000 });
    await page.locator('#app-tab-prepare').click();
    const height = page.getByTestId('config-input-layer_height');
    const category = page.locator('[data-testid^="config-category-"]').filter({ has: height });
    const categoryToggle = category.locator('[data-testid^="config-category-toggle-"]');
    const categoryReset = page.locator('[data-testid^="config-reset-category-"]');
    const openReset = async () => {
      await height.evaluate((el) => el.blur());
      await page.keyboard.press('Escape');
      await categoryToggle.click({ button: 'right' });
      await expect(categoryReset).toBeVisible();
    };
    const resetAll = page.getByTestId('config-reset-all');
    if (await resetAll.isEnabled()) await resetAll.click();
    await expect(page.getByTestId('config-mode-project')).not.toHaveAttribute('data-local-override-highlight');
    await expect(page.getByTestId('config-mode-scoped')).not.toHaveAttribute('data-local-override-highlight');
    await expect(categoryToggle).toHaveAttribute('data-local-override-highlight', 'false');
    await openReset();
    await expect(categoryReset).toHaveAttribute('data-disabled', '');
    await page.keyboard.press('Escape');
    await expect(resetAll).toBeDisabled();

    const sourceHeight = await height.inputValue();
    const changedHeight = String(Number(sourceHeight) + 0.01);
    await height.fill(changedHeight);
    await height.press('Enter');
    await expect(categoryToggle).toHaveAttribute('data-local-override-highlight', 'true');
    await expect(categoryToggle).toHaveCSS('color', 'rgb(241, 117, 78)');
    await openReset();
    await expect(categoryReset).not.toHaveAttribute('data-disabled');
    await expect(resetAll).toBeEnabled();

    await categoryReset.click();
    await expect(categoryToggle).toHaveAttribute('data-local-override-highlight', 'false');
    await openReset();
    await expect(categoryReset).toHaveAttribute('data-disabled', '');
    await page.keyboard.press('Escape');
    await expect(resetAll).toBeDisabled();
  } finally {
    await app.close();
  }
});

test('scoped fields edit mixed drafts and percentages and cancel with Escape', async () => {
  const desktop = resolve(__dirname, '..');
  const env = { ...process.env, ORCA_E2E: '1',
    ORCA_E2E_MODEL: resolve(desktop, '../../packages/slicer-wasm/fixtures/cube.stl'),
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: desktop, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60_000 });
    await page.locator('#app-tab-prepare').click();
    const rows = page.getByTestId('object-list').locator('div[data-testid^="object-"]:not([data-testid="object-list"])');
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('btn-add-model').click();
      await expect(rows).toHaveCount(i + 1);
    }
    await page.getByTestId('config-mode-scoped').click();
    const height = page.getByTestId('config-input-layer_height');
    const settle = async () => {
      await expect.poll(() => page.evaluate(() =>
        (window as unknown as { __orcaE2e: { selectMockInstance(index: number, additive: boolean): boolean } })
          .__orcaE2e.selectMockInstance(0, false),
      )).toBe(true);
    };
    for (let i = 0; i < 2; i++) {
      await rows.nth(i).locator('button').first().click();
      await height.fill(i === 0 ? '0.21' : '0.31');
      await height.press('Enter');
      await settle();
      // The mock history receipt replaces scene buffers; reselect the same
      // target after publication before inspecting its persisted value/source.
      await rows.nth(i).locator('button').first().click();
      await expect(height).toHaveValue(i === 0 ? '0.21' : '0.31');
      await height.evaluate((el) => el.blur());
      await page.mouse.move(0, 0);
      await height.hover();
      await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText('Effective value source: Object.');
    }
    await rows.nth(0).locator('button').first().click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByTestId('config-mixed-layer_height')).toBeVisible();
    await height.focus();
    await height.pressSequentially('0.25');
    await expect(height).toHaveValue('0.25');
    await height.press('Enter');
    await settle();
    await rows.nth(0).locator('button').first().click();
    await expect(page.getByTestId('config-mixed-layer_height')).toHaveCount(0);
    await expect(height).toHaveValue('0.25');
    await height.fill('0.4');
    await height.press('Escape');
    await expect(height).toHaveValue('0.25');
    // Selecting each target proves the multi-target commit and Escape result.
    for (let i = 0; i < 2; i++) {
      await rows.nth(i).locator('button').first().click();
      await expect(height).toHaveValue('0.25');
    }
    await page.getByTestId('config-page-Strength').click();
    const percent = page.getByTestId('config-input-sparse_infill_density');
    await percent.fill('22%');
    await percent.press('Enter');
    await settle();
    await rows.nth(1).locator('button').first().click();
    await expect(percent).toHaveValue('22%');
    await percent.evaluate((el) => el.blur());
    await page.mouse.move(0, 0);
    await percent.hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText('Effective value source: Object.');
    await expect(page.locator('[data-testid^="config-error-"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
