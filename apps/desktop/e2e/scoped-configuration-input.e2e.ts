import { _electron, expect, test } from '@playwright/test';
import { resolve } from 'node:path';

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
