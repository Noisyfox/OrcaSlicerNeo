import { test, expect } from './browser-fixture';


test('Web color favorites survive reload and expose alpha/gradient entries', async ({ page }) => {
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
  const popup = page.locator('[data-slot="popover-content"]');
  await expect(popup).toBeVisible();
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
  const anchorBounds = (await trigger.boundingBox())!;

  await expect.poll(async () => {
    const bounds = (await popup.boundingBox())!;
    return Math.min(Math.abs(bounds.x - anchorBounds.x - anchorBounds.width),
      Math.abs(bounds.x + bounds.width - anchorBounds.x),
      Math.abs(bounds.y - anchorBounds.y - anchorBounds.height),
      Math.abs(bounds.y + bounds.height - anchorBounds.y));
  }).toBeLessThan(10);
  await expect(page.getByRole('button', { name: 'Favorite #11223380', exact: true })).toBeVisible();
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
  await favorite.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove favorite', exact: true }).click();
  await expect.poll(async () => (await stored()).colorPicker.favorites).toEqual(hidden);
  expect((await stored()).ui.sidebarWidth).toBe(320);
});

test('Web converts imported multicolour to edited gradient across local storage and reload', async ({ page }) => {
  const printer = 'Bambu Lab X1 Carbon 0.4 nozzle';
  const original = { representative: '#998877', multiColour: '#11223380 #abcdef #44556640', type: '1' };
  await page.addInitScript(({ printer, original }) => {
    if (!localStorage.getItem('orca-slicer-neo:preferences')) localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({
      version: 1, selectedProfiles: { printer, print: '0.20mm Standard @BBL X1C' },
      rememberedFilamentRacks: { [printer]: { version: 1, slots: [
        { preset: 'Generic PLA @System', colour: '#998877', native: original },
      ] } },
    }));
  }, { printer, original });
  const native = () => page.evaluate((printer) => JSON.parse(localStorage.getItem('orca-slicer-neo:preferences')!)
    .rememberedFilamentRacks[printer].slots[0].native, printer);
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  if (process.env.ORCA_WEB_NO_ISOLATION === '1') {
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
    await expect(page.getByTestId('serial-fallback-status')).toContainText('serial wasm64 fallback');
  } else {
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await expect(page.getByTestId('serial-fallback-status')).toHaveCount(0);
  }
  await page.locator('#app-tab-prepare').click();
  const trigger = page.getByTestId('filament-colour-1');
  await expect(trigger).toHaveCSS('background-image', /rgba\(17, 34, 51, [\d.]+\).*rgb\(171, 205, 239\).*rgba\(68, 85, 102, [\d.]+\)/);
  await trigger.click();
  await expect(page.getByRole('tab', { name: 'Gradient', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('11223380');
  await page.getByRole('tab', { name: 'End' }).click();
  await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('44556640');
  await page.getByRole('textbox', { name: 'HEX color', exact: true }).fill('#77889940');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await native()).toEqual(original);
  await page.reload();
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(trigger).toHaveCSS('background-image', /rgb\(171, 205, 239\)/);
  await trigger.click();
  await page.getByRole('tab', { name: 'Start' }).click();
  await page.getByRole('textbox', { name: 'HEX color', exact: true }).fill('#22446680');
  await page.getByRole('tab', { name: 'End' }).click();
  await page.getByRole('textbox', { name: 'HEX color', exact: true }).fill('#77889940');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(trigger).toHaveCSS('background-image', /linear-gradient\(90deg, rgba\(34, 68, 102, [\d.]+\), rgba\(119, 136, 153, [\d.]+\)\)/);
  await expect.poll(native).toEqual({ representative: '#22446680', multiColour: '#22446680 #77889940', type: '0' });
  await page.reload();
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(trigger).toHaveCSS('background-image', /linear-gradient\(90deg, rgba\(34, 68, 102, [\d.]+\), rgba\(119, 136, 153, [\d.]+\)\)/);
  expect(await native()).toEqual({ representative: '#22446680', multiColour: '#22446680 #77889940', type: '0' });
});
