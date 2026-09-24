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
    const categoryReset = category.locator('[data-testid^="config-reset-category-"]');
    const resetAll = page.getByTestId('config-reset-all');
    if (await resetAll.isEnabled()) await resetAll.click();
    await expect(page.getByTestId('config-mode-project')).not.toHaveAttribute('data-local-override-highlight');
    await expect(page.getByTestId('config-mode-scoped')).not.toHaveAttribute('data-local-override-highlight');
    await expect(categoryToggle).toHaveAttribute('data-local-override-highlight', 'false');
    await expect(categoryReset).toBeDisabled();
    await expect(resetAll).toBeDisabled();

    const sourceHeight = await height.inputValue();
    const changedHeight = String(Number(sourceHeight) + 0.01);
    await height.fill(changedHeight);
    await height.press('Enter');
    await expect(categoryToggle).toHaveAttribute('data-local-override-highlight', 'true');
    await expect(categoryToggle).toHaveCSS('color', 'rgb(241, 117, 78)');
    await expect(categoryReset).toBeEnabled();
    await expect(resetAll).toBeEnabled();

    await categoryReset.click();
    await expect(categoryToggle).toHaveAttribute('data-local-override-highlight', 'false');
    await expect(categoryReset).toBeDisabled();
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
    for (let i = 0; i < 2; i++) {
      await rows.nth(i).locator('button').first().click();
      await height.fill(i === 0 ? '0.2' : '0.3');
      await height.press('Enter');
      await height.hover();
      await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText('Effective value source: Object.');
    }
    await rows.nth(0).locator('button').first().click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByTestId('config-mixed-layer_height')).toBeVisible();
    await height.focus();
    await height.pressSequentially('0.25');
    await expect(height).toHaveValue('0.25');
    await height.press('Enter');
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
    const percent = page.getByTestId('config-input-sparse_infill_density');
    await percent.fill('22%');
    await percent.press('Enter');
    await expect(percent).toHaveValue('22%');
    await percent.hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText('Effective value source: Object.');
    await expect(page.locator('[data-testid^="config-error-"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
