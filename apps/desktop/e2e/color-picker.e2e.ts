import { _electron } from './electron-fixture';
import { expect, test, type Page } from '@playwright/test';
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

async function dragPicker(page: Page, dx: number, dy: number) {
  const header = page.getByTestId('color-picker-titlebar');
  await header.hover();
  await expect.poll(() => page.locator('[data-slot="popover-content"]').evaluate(element => element.getAnimations().every(animation => animation.playState === 'finished'))).toBe(true);
  const handle = (await header.boundingBox())!;
  const before = (await page.locator('[data-slot="popover-content"]').boundingBox())!;
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 }); await page.mouse.up();
  return before;
}

test('translucent filament swatches have checkerboards in the rack, assignment and context menu', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-filament-checkerboard-'));
  const preferences = join(dir, 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1,
    selectedProfiles: { printer: 'Bambu Lab X1 Carbon 0.4 nozzle', print: '0.20mm Standard @BBL X1C' },
    rememberedFilamentRacks: { 'Bambu Lab X1 Carbon 0.4 nozzle': { version: 1, slots: [
      { preset: 'Generic PLA @System', colour: '#ff000000', native: { representative: '#ff000000', multiColour: '#ff000000', type: '1' } },
      { preset: 'Generic PLA @System', colour: '#ff000080', native: { representative: '#ff000080', multiColour: '#ff000080 #ffffff', type: '0' } },
      { preset: 'Generic PLA @System', colour: '#00ff0040', native: { representative: '#00ff0040', multiColour: '#00ff0040 #0000ff #ffffff80', type: '1' } },
      { preset: 'Generic PLA @System', colour: '#0000ffff', native: { representative: '#0000ffff', multiColour: '#0000ffff', type: '1' } },
    ] } },
  }));
  const { app, page } = await launch(preferences, MODEL_PATH);
  try {
    for (const slot of [1, 2, 3]) {
      await expect(page.getByTestId(`filament-colour-${slot}`)).toHaveCSS('background-image', /linear-gradient.*conic-gradient/);
      await expect(page.getByTestId(`filament-colour-${slot}`)).toHaveCSS('background-repeat', 'no-repeat, repeat');
      await expect(page.getByTestId(`filament-colour-${slot}`)).toHaveCSS('background-size', '100% 100%, 12px 12px');
    }
    await expect(page.getByTestId('filament-colour-4')).toHaveCSS('background-image', 'none');
    await page.getByTestId('btn-add-model').click();
    await page.getByTestId('config-mode-scoped').click();
    const cell = page.locator('[data-testid^="filament-cell-object-"]').first();
    await expect(cell).toHaveCSS('background-image', /conic-gradient/);
    await cell.click();
    const choice = page.getByRole('option', { name: /^2 - / }).locator('span[aria-hidden="true"][style]');
    await expect(choice).toHaveCSS('background-image', /linear-gradient.*conic-gradient/);
    await page.screenshot({ path: test.info().outputPath('checkerboard-assignment.png') });
    await page.keyboard.press('Escape');
    await page.getByTestId(/^object-\d+$/).first().click({ button: 'right' });
    await page.getByTestId('objectlist-change-filament').click();
    const contextSwatch = page.getByTestId('objectlist-change-filament-3').locator('span[aria-hidden="true"][style]');
    await expect(contextSwatch).toHaveCSS('background-image', /linear-gradient.*conic-gradient/);
    await page.screenshot({ path: test.info().outputPath('checkerboard-context-menu.png') });
  } finally { await app.close(); }
});

test('filament gradient alpha survives unchanged confirmation, cancellation, edits and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-filament-alpha-'));
  const preferences = join(dir, 'preferences.json');
  const printer = 'Bambu Lab X1 Carbon 0.4 nozzle';
  const native = { representative: '#11223380', multiColour: '#11223380 #44556640', type: '0' };
  writeFileSync(preferences, JSON.stringify({ version: 1,
    selectedProfiles: { printer, print: '0.20mm Standard @BBL X1C' },
    rememberedFilamentRacks: { [printer]: { version: 1, slots: [
      { preset: 'Generic PLA @System', colour: native.representative, native },
    ] } },
  }));
  const stored = () => JSON.parse(readFileSync(preferences, 'utf8')).rememberedFilamentRacks[printer].slots[0].native;
  const first = await launch(preferences);
  try {
    const { page } = first;
    const trigger = page.getByTestId('filament-colour-1');
    await trigger.click();
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('11223380');
    await expect(page.getByRole('spinbutton', { name: 'Alpha value', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    expect(stored()).toEqual(native);
    await trigger.click();
    await page.getByRole('tab', { name: 'Gradient color 2', exact: true }).click();
    await editHex(page, '44556620');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(stored()).toEqual(native);
    await trigger.click();
    await page.getByRole('tab', { name: 'Gradient color 2', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('44556640');
    await editHex(page, '44556620');
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(() => expect(stored()).toEqual({ ...native, multiColour: '#11223380 #44556620' })).toPass();
  } finally { await first.app.close(); }
  const second = await launch(preferences);
  try {
    await second.page.getByTestId('filament-colour-1').click();
    await expect(second.page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('11223380');
    await second.page.getByRole('tab', { name: 'Gradient color 2', exact: true }).click();
    await expect(second.page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('44556620');
  } finally { await second.app.close(); }
});

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
    const geometry = await page.evaluate(() => {
      const dimensions = (selector: string) => {
        const element = document.querySelector(selector)!;
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { x: box.x, y: box.y, width: box.width, height: box.height,
          border: style.borderWidth, clip: style.backgroundClip,
          backgroundColor: style.backgroundColor,
          topLeft: style.borderTopLeftRadius, bottomLeft: style.borderBottomLeftRadius,
          topRight: style.borderTopRightRadius, bottomRight: style.borderBottomRightRadius,
          directNumber: element.firstChild?.nodeType === Node.TEXT_NODE };
      };
      return {
        row1: dimensions('[data-testid="filament-slot-1"]'),
        row2: dimensions('[data-testid="filament-slot-2"]'),
        colour: dimensions('[data-testid="filament-colour-1"]'),
        preset: dimensions('[data-testid="filament-preset-1"]'),
        arrow: dimensions('[data-testid="filament-preset-1"] .sidebar-dropdown-arrow'),
      };
    });
    expect(geometry.row1.height).toBe(24);
    expect(geometry.row2.y).toBe(geometry.row1.y);
    expect(geometry.row2.x).toBeGreaterThan(geometry.row1.x + geometry.row1.width);
    expect(geometry.colour).toMatchObject({ x: geometry.row1.x, y: geometry.row1.y,
      width: 24, height: 24, border: '0px', clip: 'border-box',
      topLeft: geometry.row1.topLeft, bottomLeft: geometry.row1.bottomLeft,
      topRight: '0px', bottomRight: '0px', directNumber: true });
    expect(geometry.preset.x).toBeCloseTo(geometry.colour.x + geometry.colour.width, 3);
    expect(geometry.preset).toMatchObject({ y: geometry.row1.y, height: 24, topLeft: '0px', bottomLeft: '0px' });
    expect(geometry.preset.topRight).not.toBe('0px');
    expect(geometry.preset.bottomRight).not.toBe('0px');
    expect(geometry.arrow).toMatchObject({ width: 20, height: 20 });
    expect(geometry.arrow.x).toBeGreaterThan(geometry.preset.x);
    expect(geometry.arrow.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
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
    const partitionChoice = page.getByRole('option', { name: /^2 - / }).locator('span[aria-hidden="true"][style]');
    await expect(partitionChoice).toHaveCSS('background-image', /linear-gradient/);
    const expectedBorder = await page.evaluate(() => Math.floor(devicePixelRatio) / devicePixelRatio);
    expect(await partitionChoice.evaluate(element => parseFloat(getComputedStyle(element).borderWidth))).toBeCloseTo(expectedBorder, 5);
    await expect(partitionChoice).toHaveCSS('background-origin', 'border-box');
    await expect(partitionChoice).toHaveCSS('background-repeat', 'no-repeat');
    await page.keyboard.press('Escape');
    const screenshot = join(dir, 'swatches.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await test.info().attach('gradient-swatches', { path: screenshot, contentType: 'image/png' });
  } finally { await app.close(); }
});

test('red-to-white gradients fill bordered assignment swatches without wrapping the white end to the left', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-gradient-edge-'));
  const preferences = join(dir, 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1,
    selectedProfiles: { printer: 'Bambu Lab X1 Carbon 0.4 nozzle', print: '0.20mm Standard @BBL X1C' },
    rememberedFilamentRacks: { 'Bambu Lab X1 Carbon 0.4 nozzle': { version: 1, slots: [
      { preset: 'Generic PLA @System', colour: '#00aaaa', native: { representative: '#00aaaa', multiColour: '#00aaaa', type: '1' } },
      { preset: 'Generic PLA @System', colour: '#ff0000', native: { representative: '#ff0000', multiColour: '#ff0000 #ffffff', type: '0' } },
    ] } },
  }));
  const { app, page } = await launch(preferences, MODEL_PATH);
  try {
    await page.getByTestId('btn-add-model').click();
    await page.getByTestId('config-mode-scoped').click();
    const cell = page.locator('[data-testid^="filament-cell-object-"]').first();
    await cell.click();
    await page.getByRole('option', { name: /^2 - / }).click();
    await expect(cell).toHaveCSS('background-image', /linear-gradient\(90deg, rgb\(255, 0, 0\), rgb\(255, 255, 255\)\)/);
    await cell.click();
    const choice = page.getByRole('option', { name: /^2 - / }).locator('span[aria-hidden="true"][style]');
    await expect(choice).toBeVisible();
    await expect(choice).toHaveCSS('background-image', /linear-gradient\(90deg, rgb\(255, 0, 0\), rgb\(255, 255, 255\)\)/);
    const screenshot = join(dir, 'red-white-swatches.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await test.info().attach('red-white-gradient-edges', { path: screenshot, contentType: 'image/png' });
    const choiceScreenshot = join(dir, 'red-white-option.png');
    await choice.screenshot({ path: choiceScreenshot });
    await test.info().attach('red-white-gradient-option', { path: choiceScreenshot, contentType: 'image/png' });
    for (const swatch of [cell, choice]) {
      const expectedBorder = await page.evaluate(() => Math.floor(devicePixelRatio) / devicePixelRatio);
      expect(await swatch.evaluate(element => parseFloat(getComputedStyle(element).borderWidth))).toBeCloseTo(expectedBorder, 5);
      await expect(swatch).toHaveCSS('background-origin', 'border-box');
      await expect(swatch).toHaveCSS('background-repeat', 'no-repeat');
    }
  } finally { await app.close(); }
});

test('keeps imported partitions until an explicit gradient edit is confirmed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-gradient-edit-'));
  const preferences = join(dir, 'preferences.json');
  const printer = 'Bambu Lab X1 Carbon 0.4 nozzle';
  const original = { representative: '#998877', multiColour: '#112233 #abcdef #445566', type: '1' };
  writeFileSync(preferences, JSON.stringify({ version: 1,
    selectedProfiles: { printer, print: '0.20mm Standard @BBL X1C' },
    rememberedFilamentRacks: { [printer]: { version: 1, slots: [
      { preset: 'Generic PLA @System', colour: '#998877', native: original },
    ] } },
  }));
  const { app, page } = await launch(preferences);
  try {
    const trigger = page.getByTestId('filament-colour-1');
    const stored = () => JSON.parse(readFileSync(preferences, 'utf8')).rememberedFilamentRacks[printer].slots[0].native;
    await trigger.click();
    await expect(page.getByRole('tab', { name: 'Solid', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('The current multi-color selection is kept until you choose a different color.')).toBeVisible();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    expect(stored()).toEqual(original);
    await trigger.click();
    await page.getByRole('tab', { name: 'Gradient', exact: true }).click();
    await page.getByRole('tab', { name: 'Gradient color 2', exact: true }).click();
    await editHex(page, '#445566');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(stored()).toEqual(original);
    await trigger.click();
    await page.getByRole('tab', { name: 'Gradient', exact: true }).click();
    await page.getByRole('tab', { name: 'Gradient color 2', exact: true }).click();
    await editHex(page, '#445566');
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    // Retry parsing too: a read can overlap the main process's async write.
    await expect(() => expect(stored()).toEqual({
      representative: '#112233', multiColour: '#112233 #445566', type: '0',
    })).toPass({ timeout: 5_000 });
  } finally { await app.close(); }
});

test('color drafts commit once; shared favorites survive cancellation and an Electron restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-color-picker-'));
  const preferences = join(dir, 'preferences.json');
  const hidden = [{ kind: 'solid', color: '#11223380' },
    { kind: 'linear-gradient', colors: ['#FF000000', '#0000FF'] }];
  writeFileSync(preferences, JSON.stringify({ version: 1, selectedProfiles: {}, ui: { sidebarWidth: 320 },
    colorPicker: { favorites: hidden } }));
  // The main process writes asynchronously; a disk read can overlap truncation
  // and see incomplete JSON. Retry the read and assertion together.
  const expectSaved = (expected: Record<string, unknown>) => expect(() => {
    expect(JSON.parse(readFileSync(preferences, 'utf8'))).toMatchObject(expected);
  }).toPass({ timeout: 5_000 });
  const first = await launch(preferences);
  await first.app.context().tracing.start({ screenshots: true, snapshots: true });
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
    const collapsedWidth = (await popup.boundingBox())!.width;
    await expect(page.getByRole('spinbutton', { name: 'H value', exact: true })).toBeVisible();
    await expect(page.getByRole('spinbutton', { name: 'R value', exact: true })).toBeVisible();
    await expect(page.getByRole('slider', { name: 'Saturation', exact: true })).toHaveAttribute('aria-orientation', 'vertical');
    await page.getByRole('button', { name: 'Palettes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Palettes', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await popup.boundingBox())!.width).toBeGreaterThan(collapsedWidth + 150);
    await expectSaved({ colorPicker: { ui: { sidebarOpen: true, paletteId: 'basic' } } });
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
    await expect(page.getByRole('spinbutton', { name: 'Alpha value', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Gradient', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Favorite #11223380', exact: true })).toBeVisible();
    const hexInput = page.getByRole('textbox', { name: 'HEX color', exact: true });
    await hexInput.fill('');
    await hexInput.pressSequentially('235');
    await expect(hexInput).toHaveValue('235');
    await hexInput.pressSequentially('7ab');
    await expect(hexInput).toHaveValue('2357ab');
    await expect(page.getByRole('spinbutton', { name: 'R value', exact: true })).toHaveValue('35');
    await expect(trigger).toHaveAttribute('value', original!);
    await page.getByRole('button', { name: 'Add favorite color', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('2357ABFF');
    await expect(page.getByRole('spinbutton', { name: 'R value', exact: true })).toHaveValue('35');
    await expectSaved({ colorPicker: { favorites: [{ kind: 'solid', color: '#2357AB' }, ...hidden] } });
    await expect(page.getByRole('button', { name: 'Favorite #2357AB', exact: true })).toBeVisible();
    const favorite = page.getByRole('button', { name: 'Favorite #2357AB', exact: true });
    await favorite.hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText('#2357AB');
    const favoriteBox = (await favorite.boundingBox())!;
    const swatchBox = (await favorite.locator('[aria-hidden="true"]').boundingBox())!;
    const emptyBox = (await page.getByLabel('Favorite colors', { exact: true }).locator(':scope > span').first().boundingBox())!;
    expect(Math.abs(favoriteBox.width - favoriteBox.height)).toBeLessThan(1);
    expect(Math.abs(favoriteBox.width - swatchBox.width)).toBeLessThan(1);
    expect(Math.abs(favoriteBox.height - swatchBox.height)).toBeLessThan(1);
    expect(Math.abs(favoriteBox.width - emptyBox.width)).toBeLessThan(1);
    expect(Math.abs(favoriteBox.height - emptyBox.height)).toBeLessThan(1);
    await editHex(page, '#456789');
    await page.getByRole('button', { name: 'Add favorite color', exact: true }).click();
    await expectSaved({ colorPicker: { favorites: [{ kind: 'solid', color: '#456789' }, { kind: 'solid', color: '#2357AB' }, ...hidden] } });
    // Disk persistence and renderer publication are separate receipts. Wait for
    // the reordered swatches before selecting one at its new position.
    const favoriteButtons = page.getByLabel('Favorite colors', { exact: true }).getByRole('button');
    await expect.poll(() => favoriteButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
      .toEqual(['Favorite #456789', 'Favorite #2357AB', 'Favorite #11223380', 'Favorite #FF000000 to #0000FF']);
    await favorite.click();
    await expect(hexInput).toHaveValue('2357ABFF');
    await page.getByRole('textbox', { name: 'HEX color', exact: true }).hover();
    await expect(page.getByRole('button', { name: /^Remove favorite/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Add favorite color', exact: true }).click();
    await expect(favoriteButtons.first()).toHaveAccessibleName('Favorite #2357AB');
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
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue(original!.slice(1).toUpperCase() + (original!.length === 7 ? 'FF' : ''));
    await page.getByRole('button', { name: 'Favorite #2357AB', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(trigger).toHaveAttribute('value', '#2357ab');

    await page.getByTestId('filament-slot-1').click({ button: 'right' });
    await page.getByTestId('filament-edit-1').click();
    await page.getByTestId('preset-editor-input-default_filament_colour').click();
    await expect(page.getByRole('button', { name: 'Favorite #2357AB', exact: true })).toBeVisible();
    await editHex(page, '#654321');
    await dragPicker(page, 60, -30);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('preset-editor-close')).toBeVisible();
    await page.getByTestId('preset-editor-close').click();
    await expect(page.getByTestId('preset-editor-close')).toHaveCount(0);
    await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
    const previewTab = page.locator('#app-tab-preview');
    await previewTab.click();
    await expect(previewTab).toHaveAttribute('aria-selected', 'true');
    const rightSidebarToggle = page.getByTestId('titlebar-toggle-right-sidebar');
    await expect(rightSidebarToggle).toHaveAttribute('aria-pressed', 'true');
    await rightSidebarToggle.click();
    await expect(rightSidebarToggle).toHaveAttribute('aria-pressed', 'false');
    await expectSaved({ ui: { rightSidebarCollapsed: true },
      colorPicker: { favorites: [{ kind: 'solid', color: '#2357AB' }, ...hidden] } });
  } finally {
    const trace = test.info().outputPath('electron-favorites-trace.zip');
    await first.app.context().tracing.stop({ path: trace });
    await test.info().attach('electron-favorites-trace', { path: trace, contentType: 'application/zip' });
    await first.app.close();
  }

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

test('edits seven gradient colors with compact controls and persists palette state and complete favorites', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-seven-color-picker-'));
  const preferences = join(dir, 'preferences.json');
  const printer = 'Bambu Lab X1 Carbon 0.4 nozzle';
  const initial = { representative: '#11223301', multiColour: '#11223301 #44556680 #778899FE', type: '0' };
  writeFileSync(preferences, JSON.stringify({ version: 1,
    selectedProfiles: { printer, print: '0.20mm Standard @BBL X1C' },
    rememberedFilamentRacks: { [printer]: { version: 1, slots: [{ preset: 'Generic PLA @System', colour: initial.representative, native: initial }] } },
  }));
  const colors = ['#FF000001', '#FFFF0080', '#00FF00FE', '#00FFFF00', '#0000FFFF', '#FF00FF40', '#FF8000AA'];
  const normalized = colors.map(hex => hex.endsWith('FF') ? hex.slice(0, 7) : hex);
  const stored = () => JSON.parse(readFileSync(preferences, 'utf8'));
  const first = await launch(preferences);
  // Electron windows are not Playwright's built-in page fixture: enable the
  // browser trace explicitly so a failure includes DOM and input events.
  await first.app.context().tracing.start({ screenshots: true, snapshots: true });
  try {
    const { page } = first;
    await page.getByTestId('filament-colour-1').click();
    const popup = page.locator('[data-slot="popover-content"]');
    const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
    const original = page.getByRole('button', { name: 'Original color', exact: true });
    const favoriteGrid = page.getByLabel('Favorite colors', { exact: true });
    await expect(favoriteGrid.locator(':scope > *')).toHaveCount(16);
    const gridBounds = (await favoriteGrid.boundingBox())!;
    const originalBounds = (await original.boundingBox())!;
    expect(Math.abs(gridBounds.height - originalBounds.height)).toBeLessThan(1);
    const red = page.getByRole('spinbutton', { name: 'R value', exact: true });
    const hue = page.getByRole('spinbutton', { name: 'H value', exact: true });
    const mode = page.getByRole('tablist', { name: 'Color mode', exact: true });
    const controlBackground = await page.getByRole('textbox', { name: 'HEX color', exact: true }).locator('..').evaluate(element => getComputedStyle(element).backgroundColor);
    const selectedBackground = await page.getByRole('button', { name: 'Cancel', exact: true }).evaluate(element => getComputedStyle(element).backgroundColor);
    const selectedForeground = await confirm.evaluate(element => getComputedStyle(element).color);
    await expect(mode).toHaveCSS('background-color', controlBackground);
    await expect(mode.getByRole('tab', { name: 'Gradient', exact: true })).toHaveCSS('background-color', selectedBackground);
    await expect(mode.getByRole('tab', { name: 'Gradient', exact: true })).toHaveCSS('color', selectedForeground);
    await mode.getByRole('tab', { name: 'Solid', exact: true }).click();
    await expect(mode.getByRole('tab', { name: 'Solid', exact: true })).toHaveCSS('background-color', selectedBackground);
    await expect(mode.getByRole('tab', { name: 'Solid', exact: true })).toHaveCSS('color', selectedForeground);
    await mode.getByRole('tab', { name: 'Gradient', exact: true }).click();
    await expect(red).toBeVisible(); await expect(hue).toBeVisible();
    const saturation = page.getByRole('slider', { name: 'Saturation', exact: true });
    await expect(saturation).toHaveAttribute('aria-orientation', 'vertical');
    await saturation.focus(); await saturation.press('End');
    await expect(red).not.toHaveValue('17');
    await original.click();
    await red.fill('999'); await expect(red).toHaveValue('255');
    await red.fill(''); await expect(confirm).toBeDisabled();
    await original.click(); await expect(confirm).toBeEnabled();
    await page.getByRole('spinbutton', { name: 'Alpha value', exact: true }).focus();
    await expect(page.getByRole('slider', { name: 'Opacity', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Gradient color 1', exact: true })).toHaveCount(0);
    await hue.focus();
    await expect(page.getByRole('slider', { name: 'Opacity', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Palettes', exact: true }).click();
    await page.getByRole('combobox', { name: 'Color palette', exact: true }).click();
    await page.getByRole('option', { name: 'Gradients', exact: true }).click();
    await page.getByRole('button', { name: 'Search colors', exact: true }).click();
    const filter = page.getByRole('textbox', { name: 'Filter colors', exact: true });
    await filter.fill('Rainbow');
    await expect(page.getByLabel('Preset colors', { exact: true }).getByRole('button')).toHaveCount(1);
    await page.getByRole('button', { name: 'Nature: Rainbow', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Gradient color 7', exact: true })).toBeVisible();
    await filter.focus(); await filter.press('Escape');
    await expect(popup).toBeVisible(); await expect(filter).toHaveCount(0);
    await original.click();
    for (let i = 0; i < 4; ++i) await page.getByRole('button', { name: 'Add color', exact: true }).click();
    const add = page.getByRole('button', { name: 'Add color', exact: true });
    await expect(add).toBeDisabled();
    await hue.hover(); await add.locator('..').hover(); await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText('Up to 7 colors supported.');
    for (let i = 0; i < colors.length; ++i) {
      const stop = page.getByRole('tab', { name: `Gradient color ${i + 1}`, exact: true });
      await stop.click();
      await expect(stop).toHaveAttribute('aria-selected', 'true');
      await editHex(page, colors[i]);
      // Complete HEX blur normalization before the next stop or save action.
      const hexInput = page.getByRole('textbox', { name: 'HEX color', exact: true });
      await hexInput.blur();
      await expect(hexInput).toHaveValue(colors[i].slice(1));
    }
    const savedGradient = page.getByRole('button', { name: 'Favorite ' + normalized.join(' to '), exact: true });
    await page.getByRole('button', { name: 'Add favorite color', exact: true }).click();
    await expect(savedGradient).toBeVisible();
    await expect(() => expect(stored().colorPicker).toMatchObject({ ui: { sidebarOpen: true, paletteId: 'gradient' },
      favorites: [{ kind: 'linear-gradient', colors: normalized }] })).toPass({ timeout: 5_000 });
    await hue.focus(); await hue.hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
    await popup.screenshot({ path: test.info().outputPath('seven-color-picker.png') });
    await original.click();
    await expect(page.getByRole('tab', { name: 'Gradient color 4', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Favorite ' + normalized.join(' to '), exact: true }).click();
    await page.getByRole('button', { name: 'Remove color', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Gradient color 7', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Favorite ' + normalized.join(' to '), exact: true }).click();
    await confirm.click();
    await expect(() => expect(stored().rememberedFilamentRacks[printer].slots[0].native).toEqual({
      representative: normalized[0].toLowerCase(), multiColour: normalized.join(' ').toLowerCase(), type: '0',
    })).toPass({ timeout: 5_000 });
    await page.getByTestId('filament-colour-1').click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  } finally {
    const trace = test.info().outputPath('electron-gradient-trace.zip');
    await first.app.context().tracing.stop({ path: trace });
    await test.info().attach('electron-gradient-trace', { path: trace, contentType: 'application/zip' });
    await first.app.close();
  }
  const second = await launch(preferences);
  try {
    const { page } = second;
    await page.getByTestId('filament-colour-1').click();
    await expect(page.getByRole('button', { name: 'Palettes', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('combobox', { name: 'Color palette', exact: true })).toContainText('Gradients');
    await expect(page.getByRole('tab', { name: 'Gradient color 7', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Gradient color 3', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('00FF00FE');
    await page.getByRole('tab', { name: 'Gradient color 4', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('00FFFF00');
    await expect(page.getByRole('button', { name: 'Favorite ' + normalized.join(' to '), exact: true })).toBeVisible();
  } finally { await second.app.close(); }
});

test('color picker title bar drags within the viewport and resets position on reopening', async () => {
  const preferences = join(mkdtempSync(join(tmpdir(), 'neo-color-picker-drag-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1,
    selectedProfiles: { printer: 'Bambu Lab X1 Carbon 0.4 nozzle', print: '0.20mm Standard @BBL X1C' },
  }));
  const { app, page } = await launch(preferences);
  try {
    const trigger = page.getByTestId('filament-colour-1');
    const original = await trigger.getAttribute('value');
    await trigger.click();
    const popup = page.locator('[data-slot="popover-content"]');
    const before = await dragPicker(page, 120, 60);
    await expect.poll(async () => Math.abs((await popup.boundingBox())!.x - before.x - 120)).toBeLessThan(2);
    await expect.poll(async () => Math.abs((await popup.boundingBox())!.y - before.y - 60)).toBeLessThan(2);
    const moved = (await popup.boundingBox())!;
    await editHex(page, '#2357AB');
    await page.getByRole('button', { name: 'Palettes', exact: true }).click();
    await expect(page.getByLabel('Preset colors', { exact: true })).toBeVisible();
    await expect.poll(async () => (await popup.boundingBox())!.width).toBeGreaterThan(moved.width + 150);
    await expect.poll(async () => Math.abs((await popup.boundingBox())!.x - moved.x)).toBeLessThan(2);
    await expect.poll(async () => Math.abs((await popup.boundingBox())!.y - moved.y)).toBeLessThan(2);
    const header = page.getByTestId('color-picker-titlebar');
    await header.hover();
    let handle = (await header.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(0, 0, { steps: 6 }); await page.mouse.up();
    await expect(popup).toBeVisible();
    await expect.poll(async () => (await popup.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    await expect.poll(async () => (await popup.boundingBox())!.x).toBeLessThan(12);
    await expect.poll(async () => (await popup.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    await expect.poll(async () => (await popup.boundingBox())!.y).toBeLessThan(12);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await header.hover(); handle = (await header.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(viewport.width - 1, viewport.height - 1, { steps: 6 }); await page.mouse.up();
    const fits = async () => {
      const rect = (await popup.boundingBox())!;
      const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= view.width + 1 && rect.y + rect.height <= view.height + 1;
    };
    await expect.poll(fits).toBe(true);
    await page.setViewportSize({ width: 900, height: 640 });
    await expect.poll(fits).toBe(true);
    const stopped = (await popup.boundingBox())!;
    await page.mouse.move(450, 120);
    expect((await popup.boundingBox())!.x).toBeCloseTo(stopped.x, 0);
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue('2357ABFF');
    await popup.screenshot({ path: test.info().outputPath('draggable-color-picker.png') });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toHaveAttribute('value', original!);
    await trigger.click(); await page.getByTestId('color-picker-titlebar').hover();
    const anchor = (await trigger.boundingBox())!;
    await expect.poll(async () => {
      const rect = (await popup.boundingBox())!;
      return Math.min(Math.abs(rect.x - anchor.x - anchor.width), Math.abs(rect.x + rect.width - anchor.x),
        Math.abs(rect.y - anchor.y - anchor.height), Math.abs(rect.y + rect.height - anchor.y));
    }).toBeLessThan(10);
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue(original!.slice(1).toUpperCase() + (original!.length === 7 ? 'FF' : ''));
  } finally { await app.close(); }
});

test('gradient nodes keep their centers while held down and match the reference proportions', async () => {
  const preferences = join(mkdtempSync(join(tmpdir(), 'neo-gradient-nodes-')), 'preferences.json');
  const printer = 'Bambu Lab X1 Carbon 0.4 nozzle';
  writeFileSync(preferences, JSON.stringify({ version: 1, selectedProfiles: { printer, print: '0.20mm Standard @BBL X1C' },
    colorPicker: { favorites: [], ui: { sidebarOpen: true, paletteId: 'basic' } },
    rememberedFilamentRacks: { [printer]: { version: 1, slots: [{ preset: 'Generic PLA @System', colour: '#0000ff',
      native: { representative: '#0000ff', multiColour: '#0000ff #ff0000', type: '0' } }] } },
  }));
  const { app, page } = await launch(preferences);
  try {
    await page.getByTestId('filament-colour-1').click();
    const popup = page.locator('[data-slot="popover-content"]');
    const track = page.getByRole('tablist', { name: 'Gradient colors', exact: true });
    const paint = track.locator('.color-gradient-track');
    const node = (index: number) => page.getByRole('tab', { name: `Gradient color ${index}`, exact: true });
    await node(2).hover();
    const selected = (await node(1).boundingBox())!, inactive = (await node(2).boundingBox())!;
    const band = (await paint.boundingBox())!, add = (await page.getByRole('button', { name: 'Add color', exact: true }).boundingBox())!;
    expect(selected.height).toBeCloseTo(20, 0);
    expect(selected.width).toBeCloseTo(selected.height, 0);
    expect(inactive.height * 2).toBeCloseTo(selected.height, 0);
    expect(inactive.width).toBeCloseTo(inactive.height, 0);
    expect(band.height).toBeCloseTo(selected.height, 0);
    expect(add.height).toBeCloseTo(band.height, 0);
    expect(add.x - band.x - band.width).toBeCloseTo(10, 0);
    expect(band.width / band.height).toBeGreaterThan(9);
    expect(band.width / band.height).toBeLessThan(9.2);
    expect(selected.x + selected.width / 2 - band.x).toBeCloseTo(10, 0);
    expect(band.x + band.width - inactive.x - inactive.width / 2).toBeCloseTo(10, 0);
    const pressNode = async (index: number) => {
      const target = node(index);
      await target.hover();
      const before = (await target.boundingBox())!, popupBefore = (await popup.boundingBox())!;
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2); await page.mouse.down();
      // Sample every frame while the mouse is held: the former global tab
      // :active rule animated the centering translate away from -50%.
      const frames = await target.evaluate(element => new Promise<{ x: number; y: number }[]>(resolve => {
        const centers: { x: number; y: number }[] = [];
        const sample = () => {
          const rect = element.getBoundingClientRect(); centers.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
          if (centers.length < 12) requestAnimationFrame(sample); else resolve(centers);
        };
        sample();
      }));
      for (const center of frames) {
        expect(center.x).toBeCloseTo(before.x + before.width / 2, 0);
        expect(center.y).toBeCloseTo(before.y + before.height / 2, 0);
      }
      await page.mouse.up();
      await expect(target).toHaveAttribute('aria-selected', 'true');
      const after = (await target.boundingBox())!, popupAfter = (await popup.boundingBox())!;
      expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2, 0);
      expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2, 0);
      expect(popupAfter.x).toBeCloseTo(popupBefore.x, 0); expect(popupAfter.y).toBeCloseTo(popupBefore.y, 0);
    };
    for (const index of [2, 1, 2]) await pressNode(index);
    await popup.screenshot({ path: test.info().outputPath('gradient-nodes-two.png') });
    for (let i = 0; i < 5; ++i) await page.getByRole('button', { name: 'Add color', exact: true }).click();
    for (let index = 1; index <= 7; ++index) await pressNode(index);
    const remove = (await page.getByRole('button', { name: 'Remove color', exact: true }).boundingBox())!;
    const addFull = (await page.getByRole('button', { name: 'Add color', exact: true }).boundingBox())!;
    expect(addFull.x - remove.x - remove.width).toBeCloseTo(6, 0);
    await node(1).focus(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    await expect(node(7)).toHaveAttribute('aria-selected', 'true');
    const trackRect = (await track.boundingBox())!;
    await track.click({ position: { x: 10 + (trackRect.width - 20) * 0.24, y: trackRect.height / 2 } });
    await expect(node(2)).toHaveAttribute('aria-selected', 'true');
    await popup.screenshot({ path: test.info().outputPath('gradient-nodes-seven.png') });
  } finally { await app.close(); }
});
