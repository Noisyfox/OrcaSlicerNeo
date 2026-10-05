import { _electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');

async function launch(preferences: string) {
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_PREFERENCES: preferences } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  const page = await app.firstWindow();
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
  await page.locator('#app-tab-prepare').click();
  return { app, page };
}

async function editHex(page: Page, color: string) {
  await page.getByRole('textbox', { name: 'HEX color', exact: true }).fill(color);
}

test('color drafts commit once; shared favorites survive cancellation and an Electron restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-color-picker-'));
  const preferences = join(dir, 'preferences.json');
  const hidden = [{ kind: 'solid', color: '#11223380' },
    { kind: 'linear-gradient', start: '#FF000000', end: '#0000FF' }];
  writeFileSync(preferences, JSON.stringify({ version: 1, selectedProfiles: {}, ui: { sidebarWidth: 320 },
    colorPicker: { favorites: hidden } }));
  const saved = () => JSON.parse(readFileSync(preferences, 'utf8'));
  const first = await launch(preferences);
  try {
    const { page } = first;
    const trigger = page.getByTestId('filament-colour-1');
    const original = await trigger.getAttribute('value');
    await trigger.click();
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toBeVisible();
    const popup = page.locator('[data-slot="popover-content"]');
    await expect(popup).toBeVisible();
    expect(await popup.locator('input').evaluateAll(inputs => inputs.every(input => {
      const style = getComputedStyle(input);
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].every(width => width === '0px');
    }))).toBe(true);
    await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
    await page.getByRole('group', { name: 'Color spectrum', exact: true }).click({ button: 'right' });
    await expect(page.getByTestId('filament-edit-1')).toHaveCount(0);
    await expect(popup).toBeVisible();
    const anchorBounds = (await trigger.boundingBox())!;

    await expect.poll(async () => {
      const bounds = (await popup.boundingBox())!;
      return Math.min(Math.abs(bounds.x - anchorBounds.x - anchorBounds.width),
        Math.abs(bounds.x + bounds.width - anchorBounds.x),
        Math.abs(bounds.y - anchorBounds.y - anchorBounds.height),
        Math.abs(bounds.y + bounds.height - anchorBounds.y));
    }).toBeLessThan(10);
    await expect.poll(async () => {
      const presets = (await page.getByLabel('Preset colors', { exact: true }).boundingBox())!;
      const favorites = (await page.getByLabel('Favorite colors', { exact: true }).boundingBox())!;
      return Math.abs(presets.y + presets.height - favorites.y - favorites.height);
    }).toBeLessThan(2);
    const modeBounds = (await page.locator('[data-slot="color-picker-mode-row"]').boundingBox())!;
    const redBounds = (await page.getByRole('spinbutton', { name: 'R value', exact: true }).boundingBox())!;
    const blueBounds = (await page.getByRole('spinbutton', { name: 'B value', exact: true }).boundingBox())!;
    const gridBounds = (await page.getByLabel('Favorite colors', { exact: true }).boundingBox())!;
    expect(Math.abs((gridBounds.y - blueBounds.y - blueBounds.height) - (redBounds.y - modeBounds.y - modeBounds.height))).toBeLessThan(2);
    const presets = page.getByLabel('Preset colors', { exact: true });
    const favoriteBounds = (await page.getByLabel('Favorite colors', { exact: true }).boundingBox())!;
    await presets.hover();
    await page.mouse.wheel(0, 320);
    await expect.poll(() => presets.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await popup.evaluate(element => element.scrollTop)).toBe(0);
    expect((await page.getByLabel('Favorite colors', { exact: true }).boundingBox())!.y).toBeCloseTo(favoriteBounds.y, 0);
    await page.getByRole('combobox', { name: 'Color palette', exact: true }).click();
    await page.getByPlaceholder('Search palettes…').fill('Basic');
    await page.getByRole('option', { name: 'Basic colors', exact: true }).click();
    await expect(popup).toBeVisible();
    await expect(page.getByRole('spinbutton', { name: 'Alpha value', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Gradient', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Favorite #11223380', exact: true })).toHaveCount(0);
    const hexInput = page.getByRole('textbox', { name: 'HEX color', exact: true });
    await hexInput.fill('');
    await hexInput.pressSequentially('235');
    await expect(hexInput).toHaveValue('235');
    await hexInput.pressSequentially('7ab');
    await expect(hexInput).toHaveValue('2357ab');
    await expect(page.getByRole('spinbutton', { name: 'R value', exact: true })).toHaveValue('35');
    await expect(trigger).toHaveAttribute('value', original!);
    await page.getByRole('button', { name: 'Add favorite color', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('2357AB');
    await expect(page.getByRole('spinbutton', { name: 'R value', exact: true })).toHaveValue('35');
    await expect.poll(() => saved().colorPicker.favorites).toEqual([{ kind: 'solid', color: '#2357AB' }, ...hidden]);
    await expect(page.getByRole('button', { name: 'Favorite #2357AB', exact: true })).toBeVisible();
    const favorite = page.getByRole('button', { name: 'Favorite #2357AB', exact: true });
    const favoriteBox = (await favorite.boundingBox())!;
    const swatchBox = (await favorite.locator('[aria-hidden="true"]').boundingBox())!;
    const emptyBox = (await page.getByLabel('Favorite colors', { exact: true }).locator(':scope > span').first().boundingBox())!;
    expect(favoriteBox.width).toBeGreaterThan(favoriteBox.height);
    expect(Math.abs(favoriteBox.width - swatchBox.width)).toBeLessThan(1);
    expect(Math.abs(favoriteBox.height - swatchBox.height)).toBeLessThan(1);
    expect(Math.abs(favoriteBox.width - emptyBox.width)).toBeLessThan(1);
    expect(Math.abs(favoriteBox.height - emptyBox.height)).toBeLessThan(1);
    await editHex(page, '#456789');
    await page.getByRole('button', { name: 'Add favorite color', exact: true }).click();
    await expect.poll(() => saved().colorPicker.favorites).toEqual([{ kind: 'solid', color: '#456789' }, { kind: 'solid', color: '#2357AB' }, ...hidden]);
    await favorite.click();
    await page.getByRole('textbox', { name: 'HEX color', exact: true }).hover();
    await expect(page.getByRole('button', { name: 'Remove favorite #2357AB', exact: true })).toHaveCSS('opacity', '0');
    await page.getByRole('button', { name: 'Add favorite color', exact: true }).click();
    await expect.poll(() => saved().colorPicker.favorites).toEqual([{ kind: 'solid', color: '#2357AB' }, { kind: 'solid', color: '#456789' }, ...hidden]);
    await page.getByRole('button', { name: 'Favorite #456789', exact: true }).hover();
    await page.getByRole('button', { name: 'Remove favorite #456789', exact: true }).click();
    await expect.poll(() => saved().colorPicker.favorites).toEqual([{ kind: 'solid', color: '#2357AB' }, ...hidden]);
    await page.screenshot({ path: test.info().outputPath('color-picker.png') });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toHaveAttribute('value', original!);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await editHex(page, '#654321');
    await page.getByTestId('slicer-status').click();
    await expect(popup).toHaveCount(0);
    await expect(trigger).toHaveAttribute('value', original!);
    await trigger.click();
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue(original!.slice(1).toUpperCase());
    await page.getByRole('button', { name: 'Favorite #2357AB', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(trigger).toHaveAttribute('value', '#2357ab');

    await page.getByTestId('filament-slot-1').click({ button: 'right' });
    await page.getByTestId('filament-edit-1').click();
    await page.getByTestId('preset-editor-input-default_filament_colour').click();
    await expect(page.getByRole('button', { name: 'Favorite #2357AB', exact: true })).toBeVisible();
    await editHex(page, '#654321');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('preset-editor-close')).toBeVisible();
    await page.getByTestId('preset-editor-close').click();
    await page.locator('#app-tab-preview').click();
    await page.getByTestId('titlebar-toggle-right-sidebar').click();
    await expect.poll(() => saved().ui.rightSidebarCollapsed).toBe(true);
    expect(saved().colorPicker.favorites).toEqual([{ kind: 'solid', color: '#2357AB' }, ...hidden]);
  } finally { await first.app.close(); }

  const second = await launch(preferences);
  try {
    const { page } = second;
    await page.getByTestId('filament-colour-1').click();
    await expect(page.getByRole('button', { name: 'Favorite #2357AB', exact: true })).toBeVisible();
    const remove = page.getByRole('button', { name: 'Remove favorite #2357AB', exact: true });
    const favorite = page.getByRole('button', { name: 'Favorite #2357AB', exact: true });
    await favorite.focus();
    await favorite.press('Tab');
    await expect(remove).toBeFocused();
    await expect(remove).toHaveCSS('opacity', '1');
    await expect.poll(() => remove.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return [[rect.left + 3, rect.top + 3], [rect.right - 3, rect.top + 3],
        [rect.left + 3, rect.bottom - 3], [rect.right - 3, rect.bottom - 3]]
        .every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
    })).toBe(true);
    await remove.click();
    await expect.poll(() => saved().colorPicker.favorites).toEqual(hidden);
    expect(saved().ui.sidebarWidth).toBe(320);
  } finally { await second.app.close(); }
});
