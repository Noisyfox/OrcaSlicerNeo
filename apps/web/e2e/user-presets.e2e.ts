import playwright from '../../desktop/node_modules/@playwright/test/index.js';
const { test, expect } = playwright;

test('Web user presets persist in IndexedDB across reload without an account', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('orca-slicer-neo:preferences')) localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({ version: 1, ui: {}, profileActivation: {
      models: [{ vendor: 'Creality', model: 'Creality Ender-3', nozzle_diameter: ['0.4'] }], filaments: ['Generic PLA @System'],
    } }));
  });
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await page.getByTestId('filament-slot-1').click({ button: 'right' });
  await page.getByTestId('filament-edit-1').click();
  await page.getByTestId('preset-editor-dialog').getByRole('button', { name: 'Save as…', exact: true }).click();
  await page.getByLabel('Preset name', { exact: true }).fill('Web Local PLA');
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(page.getByTestId('preset-editor-title')).toHaveText('Web Local PLA');
  await page.getByTestId('preset-editor-close').click();
  await page.reload();
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await page.getByTestId('filament-preset-1').click();
  await page.getByPlaceholder('Search compatible presets…').fill('Web Local PLA');
  await page.getByRole('menuitem', { name: 'Generic', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Web Local PLA', exact: true })).toBeVisible();
});
