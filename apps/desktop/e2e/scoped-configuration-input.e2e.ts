import { _electron } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test('conditional settings preserve controls through hiding and read-only changes', async () => {
  test.skip(process.env.VITE_SCOPED_CONFIGURATION_GATE !== '1', 'Requires the existing configuration test gate in the renderer build');
  const desktop = resolve(__dirname, '..');
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_MODEL: resolve(desktop, '../../packages/slicer-wasm/fixtures/cube.stl') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: desktop, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60_000 });
    await page.locator('#app-tab-prepare').click();
    await page.waitForFunction(() => Boolean((window as any).__orcaScopedConfigurationGate));
    await page.getByTestId('config-page-Multi.').click();
    const tower = page.getByTestId('config-input-enable_prime_tower');
    if (await tower.getAttribute('aria-checked') !== 'true') await tower.click();
    const width = page.getByTestId('config-input-prime_tower_width');
    await expect(width).toBeVisible();
    await width.fill('35'); await width.press('Enter');
    await expect(width).toHaveValue('35'); await expect(width).toBeEnabled();
    const originalWidth = await width.elementHandle();
    await tower.click(); await expect(width).toBeHidden();
    expect(await page.getByTestId('config-field-prime_tower_width').getAttribute('hidden')).not.toBeNull();
    // The ordinary configuration command remains valid while its UI is hidden.
    await page.evaluate(async () => (window as any).__orcaScopedConfigurationGate.configure({
      version: 1, operation: 'set', targets: [{ scope: 'project' }], key: 'prime_tower_width', value: '42',
    }));
    await tower.click(); await expect(width).toBeVisible(); await expect(width).toHaveValue('42');
    expect(await width.evaluate((node, original) => node === original, originalWidth)).toBe(true);

    await page.getByTestId('btn-add-model').click();
    await page.getByTestId('config-mode-scoped').click();
    await expect.poll(() => page.evaluate(() => (window as any).__orcaE2e.selectMockInstance(0, false))).toBe(true);
    await page.getByTestId('config-page-Speed').click();
    const speed = page.getByTestId('config-input-outer_wall_speed');
    await expect(speed).toBeVisible(); const originalSpeed = await speed.elementHandle();
    const setWalls = async (value: string) => page.evaluate(async value => {
      const gate = (window as any).__orcaScopedConfigurationGate;
      const object = gate.snapshot().objects[0];
      await gate.configure({ version: 1, operation: 'set', targets: [{ scope: 'object', id: String(object.id) }], key: 'wall_loops', value });
    }, value);
    await setWalls('0'); await expect(speed).toBeDisabled();
    await setWalls('2'); await expect(speed).toBeEnabled();
    expect(await speed.evaluate((node, original) => node === original, originalSpeed)).toBe(true);
    await originalWidth?.dispose(); await originalSpeed?.dispose();
  } finally { await app.close(); }
});

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
    await expect(categoryToggle).toHaveCSS('color', 'rgb(247, 148, 29)');
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
      // The native history patch must retain selection, allowing continued
      // editing without selecting the object again.
      await expect(rows.nth(i).locator('[data-testid^="config-marker-object-"]')).toBeVisible();
      await expect(rows.nth(i).locator(':scope > div > button[data-state="selected"]')).toBeVisible();
      await expect(rows.nth(i).locator(':scope > div > button > span').last()).toHaveCSS('color', 'rgb(247, 148, 29)');
      await expect(height).toHaveValue(i === 0 ? '0.21' : '0.31');
      await height.evaluate((el) => el.blur());
      await page.mouse.move(0, 0);
      await height.hover();
      await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText('Effective value source: Object.');
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
    const sourcePercent = await percent.inputValue();
    const field = page.getByTestId('config-field-sparse_infill_density');
    const decrease = field.locator('button[aria-label^="Decrease"]');
    const increase = field.locator('button[aria-label^="Increase"]');
    await percent.fill('0%');
    await expect(decrease).toBeDisabled();
    await expect(increase).toBeEnabled();
    await percent.fill('100%');
    await expect(increase).toBeDisabled();
    await expect(decrease).toBeEnabled();
    await percent.press('Escape');
    await expect(percent).toHaveValue(sourcePercent);
    await page.getByTestId('config-option-label-sparse_infill_density').hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText('Range: [0%, 100%]');
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText('parameter name: sparse_infill_density');
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText('Default: 20%');
    await page.mouse.move(0, 0);
    await percent.fill('22%');
    await percent.press('Enter');
    await settle();
    await rows.nth(1).locator('button').first().click();
    await expect(percent).toHaveValue('22%');
    await percent.evaluate((el) => el.blur());
    await page.mouse.move(0, 0);
    await percent.hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText('Effective value source: Object.');
    await expect(page.locator('[data-testid^="config-error-"]')).toHaveCount(0);
    await rows.nth(1).locator('[data-testid^="config-marker-object-"]').click();
    await expect(rows.nth(1).locator('[data-testid^="config-marker-object-"]')).toHaveCount(0);
    await expect(rows.nth(1).locator(':scope > div > button[data-state="selected"]')).toBeVisible();
    await expect(percent).not.toHaveValue('22%');
    await expect(rows.nth(0).locator('[data-testid^="config-marker-object-"]')).toBeVisible();
  } finally {
    await app.close();
  }
});
