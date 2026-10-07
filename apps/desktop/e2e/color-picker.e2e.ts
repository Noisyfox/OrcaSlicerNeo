import { _electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');

async function launch(preferences: string, modelPath?: string) {
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_PREFERENCES: preferences,
    ...(modelPath ? { ORCA_E2E_MODEL: modelPath } : {}) } as Record<string, string>;
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

test('renders remembered gradient and partition swatches in the shared Prepare UI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-gradient-swatches-'));
  const preferences = join(dir, 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1,
    selectedProfiles: { printer: 'Bambu Lab X1 Carbon 0.4 nozzle', print: '0.20mm Standard @BBL X1C' },
    ui: { switchToDeviceAfterSend: true },
    rememberedFilamentRacks: { 'Bambu Lab X1 Carbon 0.4 nozzle': { version: 1, slots: [
      { preset: 'Generic PLA @System', colour: '#111111', native: { representative: '#111111', multiColour: '#000000 #FFFFFF', type: '0' } },
      { preset: 'Generic PLA @System', colour: '#ff0000', native: { representative: '#ff0000', multiColour: '#ff0000 #00ff00 #0000ff', type: '1' } },
    ] } },
  }));
  const { app, page } = await launch(preferences, MODEL_PATH);
  try {
    const gradient = page.getByTestId('filament-colour-1');
    const partitions = page.getByTestId('filament-colour-2');
    await expect(partitions).toBeVisible();
    await expect.poll(() => gradient.evaluate((element) => getComputedStyle(element).backgroundImage))
      .toContain('linear-gradient(90deg, rgb(0, 0, 0), rgb(255, 255, 255))');
    await expect.poll(() => partitions.evaluate((element) => getComputedStyle(element).backgroundImage))
      .toContain('rgb(255, 0, 0) 0%, rgb(255, 0, 0) 33.3333');
    expect(await gradient.evaluate((element) => element.firstChild?.nodeType)).toBe(3);
    await expect(gradient).toHaveCSS('color', 'rgb(255, 255, 255)');
    await page.getByTestId('btn-add-model').click();
    await page.getByTestId('config-mode-scoped').click();
    const cell = page.locator('[data-testid^="filament-cell-object-"]').first();
    await expect(cell).toBeVisible();
    await expect.poll(() => cell.evaluate((element) => getComputedStyle(element).backgroundImage))
      .toContain('linear-gradient(90deg, rgb(0, 0, 0), rgb(255, 255, 255))');
    expect(await cell.evaluate((element) => element.querySelector('span'))).toBeNull();
    await cell.click();
    await expect(page.getByRole('option', { name: /^2 - / }).locator('span[aria-hidden="true"]'))
      .toHaveCSS('background-image', /linear-gradient/);
    await page.keyboard.press('Escape');
    const screenshot = join(dir, 'swatches.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await test.info().attach('gradient-swatches', { path: screenshot, contentType: 'image/png' });
  } finally { await app.close(); }
});

test('imported partition edits as a two-endpoint gradient only after confirmation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-gradient-edit-'));
  const preferences = join(dir, 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1,
    selectedProfiles: { printer: 'Bambu Lab X1 Carbon 0.4 nozzle', print: '0.20mm Standard @BBL X1C' },
    rememberedFilamentRacks: { 'Bambu Lab X1 Carbon 0.4 nozzle': { version: 1, slots: [
      { preset: 'Generic PLA @System', colour: '#998877', native: {
        representative: '#998877', multiColour: '#112233 #abcdef #445566', type: '1',
      } },
    ] } },
  }));
  const { app, page } = await launch(preferences);
  try {
    const trigger = page.getByTestId('filament-colour-1');
    await expect(trigger).toHaveCSS('background-image', /rgb\(17, 34, 51\).*rgb\(171, 205, 239\).*rgb\(68, 85, 102\)/);
    await trigger.click();
    await expect(page.getByRole('tab', { name: 'Gradient', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('112233');
    await page.getByRole('tab', { name: 'End' }).click();
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('445566');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toHaveCSS('background-image', /rgb\(171, 205, 239\)/);
    await trigger.click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(trigger).toHaveCSS('background-image', /linear-gradient\(90deg, rgb\(17, 34, 51\), rgb\(68, 85, 102\)\)/);
    await expect.poll(() => JSON.parse(readFileSync(preferences, 'utf8'))
      .rememberedFilamentRacks['Bambu Lab X1 Carbon 0.4 nozzle'].slots[0].native)
      .toEqual({ representative: '#112233', multiColour: '#112233 #445566', type: '0' });
  } finally { await app.close(); }
});

test('color drafts commit once; shared favorites survive cancellation and an Electron restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-color-picker-'));
  const preferences = join(dir, 'preferences.json');
  const hidden = [{ kind: 'solid', color: '#11223380' },
    { kind: 'linear-gradient', start: '#FF000000', end: '#0000FF' }];
  writeFileSync(preferences, JSON.stringify({ version: 1, selectedProfiles: {}, ui: { sidebarWidth: 320 },
    colorPicker: { favorites: hidden } }));
  // The main process writes asynchronously; a disk read can overlap truncation
  // and see incomplete JSON. Retry the read and assertion together.
  const expectSaved = (expected: Record<string, unknown>) => expect(() => {
    expect(JSON.parse(readFileSync(preferences, 'utf8'))).toMatchObject(expected);
  }).toPass({ timeout: 5_000 });
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
    await expect(page.getByRole('tab', { name: 'Gradient', exact: true })).toBeVisible();
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
    await expectSaved({ colorPicker: { favorites: [{ kind: 'solid', color: '#2357AB' }, ...hidden] } });
    await expect(page.getByRole('button', { name: 'Favorite #2357AB', exact: true })).toBeVisible();
    const favorite = page.getByRole('button', { name: 'Favorite #2357AB', exact: true });
    await favorite.hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText('#2357AB');
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
    await expectSaved({ colorPicker: { favorites: [{ kind: 'solid', color: '#456789' }, { kind: 'solid', color: '#2357AB' }, ...hidden] } });
    await favorite.click();
    await page.getByRole('textbox', { name: 'HEX color', exact: true }).hover();
    await expect(page.getByRole('button', { name: /^Remove favorite/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Add favorite color', exact: true }).click();
    await expectSaved({ colorPicker: { favorites: [{ kind: 'solid', color: '#2357AB' }, { kind: 'solid', color: '#456789' }, ...hidden] } });
    await page.getByRole('button', { name: 'Favorite #456789', exact: true }).click({ button: 'right' });
    await expect(page.getByTestId('filament-edit-1')).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Remove favorite', exact: true })).toHaveAttribute('data-variant', 'destructive');
    await page.getByRole('menuitem', { name: 'Remove favorite', exact: true }).click();
    await expect(popup).toBeVisible();
    await expectSaved({ colorPicker: { favorites: [{ kind: 'solid', color: '#2357AB' }, ...hidden] } });
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
    await expectSaved({ ui: { rightSidebarCollapsed: true },
      colorPicker: { favorites: [{ kind: 'solid', color: '#2357AB' }, ...hidden] } });
  } finally { await first.app.close(); }

  const second = await launch(preferences);
  try {
    const { page } = second;
    await page.getByTestId('filament-colour-1').click();
    await expect(page.getByRole('button', { name: 'Favorite #2357AB', exact: true })).toBeVisible();
    const favorite = page.getByRole('button', { name: 'Favorite #2357AB', exact: true });
    await favorite.focus();
    // Chromium only emits the native Shift+F10 contextmenu event on Windows/Linux.
    if (process.platform === 'darwin') await favorite.click({ button: 'right' });
    else await favorite.press('Shift+F10');
    const removeFavorite = page.getByRole('menuitem', { name: 'Remove favorite', exact: true });
    await expect(removeFavorite).toBeVisible();
    await removeFavorite.click();
    await expect(favorite).toHaveCount(0);
    await expectSaved({ colorPicker: { favorites: hidden }, ui: { sidebarWidth: 320 } });
  } finally { await second.app.close(); }
});
