import playwright from '../../desktop/node_modules/@playwright/test/index.js';
const { test, expect } = playwright;

test('Web color favorites survive reload and preserve hidden alpha/gradient entries', async ({ page }) => {
  const hidden = [{ kind: 'solid', color: '#11223380' },
    { kind: 'linear-gradient', start: '#FF000000', end: '#0000FF' }];
  await page.addInitScript((favorites) => {
    if (!localStorage.getItem('orca-slicer-neo:preferences')) localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({
      version: 1, selectedProfiles: {}, ui: { sidebarWidth: 320 }, colorPicker: { favorites },
    }));
  }, hidden);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('orca-slicer-neo:preferences')!));
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  const trigger = page.getByTestId('filament-colour-1');
  const original = await trigger.getAttribute('value');
  await trigger.click();
  await expect(page.getByRole('button', { name: 'Favorite #11223380', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'HEX color', exact: true }).fill('#456789');
  await page.getByRole('button', { name: 'Add favorite color', exact: true }).click();
  await expect.poll(async () => (await stored()).colorPicker.favorites).toEqual([{ kind: 'solid', color: '#456789' }, ...hidden]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(trigger).toHaveAttribute('value', original!);
  await page.reload();
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await trigger.click();
  const favorite = page.getByRole('button', { name: 'Favorite #456789', exact: true });
  await expect(favorite).toBeVisible();
  await favorite.click();
  await page.screenshot({ path: test.info().outputPath('web-color-picker.png') });
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(trigger).toHaveAttribute('value', '#456789');
  await trigger.click();
  const remove = page.getByRole('button', { name: 'Remove favorite #456789', exact: true });
  await remove.focus(); await remove.click();
  await expect.poll(async () => (await stored()).colorPicker.favorites).toEqual(hidden);
  expect((await stored()).ui.sidebarWidth).toBe(320);
});
