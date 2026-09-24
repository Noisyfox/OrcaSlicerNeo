import { _electron, expect, test } from '@playwright/test';
import { resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');

test('preset editor modal edits Printer and shared Filament drafts without changing slot colors', async () => {
  const env = { ...process.env, ORCA_E2E: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();

    await page.getByTestId('preset-edit-printer').click();
    const dialog = page.getByTestId('preset-editor-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('preset-editor-title')).not.toBeEmpty();
    const printerSourceHeight = await page.getByTestId('preset-editor-source-printable_height').textContent();
    const initialPrinterHeight = await page.getByTestId('preset-editor-effective-printable_height').textContent();
    if (printerSourceHeight === null || initialPrinterHeight === null) throw new Error('expected Printer source/effective height');
    const printableHeight = page.getByTestId('preset-editor-input-printable_height');
    const printerHeightField = page.getByTestId('preset-editor-field-printable_height');
    const minimumText = await printerHeightField.getAttribute('data-native-min');
    const maximumText = await printerHeightField.getAttribute('data-native-max');
    const minimum = minimumText === null ? Number.NEGATIVE_INFINITY : Number(minimumText);
    const maximum = maximumText === null ? Number.POSITIVE_INFINITY : Number(maximumText);
    const initialPrinterHeightNumber = Number(initialPrinterHeight);
    const editedPrinterHeightNumber = initialPrinterHeightNumber + 1 <= maximum
      ? initialPrinterHeightNumber + 1
      : initialPrinterHeightNumber - 1;
    if (!Number.isFinite(initialPrinterHeightNumber)
      || editedPrinterHeightNumber < minimum
      || editedPrinterHeightNumber > maximum
      || editedPrinterHeightNumber === initialPrinterHeightNumber) {
      throw new Error(`expected a distinct printable_height within [${minimum}, ${maximum}]`);
    }
    const editedPrinterHeight = String(editedPrinterHeightNumber);
    await printableHeight.fill(editedPrinterHeight);
    await printableHeight.press('Enter');
    await expect(printableHeight).toHaveValue(editedPrinterHeight);
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveText('Project draft');
    await page.getByTestId('preset-editor-reset-preset').click();
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveCount(0);
    await expect(printableHeight).toHaveValue(printerSourceHeight);
    await page.getByTestId('preset-editor-close').click();

    const initialActualColour = page.getByTestId('filament-colour-1');
    const initialActualColourValue = await initialActualColour.inputValue();
    await expect(initialActualColour).toHaveValue(initialActualColourValue);
    await page.getByTestId('filament-actions-1').click();
    await page.getByTestId('filament-edit-1').click();
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('preset-editor-title')).not.toBeEmpty();
    const filamentSourceName = await page.getByTestId('preset-editor-title').textContent();
    if (!filamentSourceName) throw new Error('expected Filament canonical source name');
    const defaultColour = page.getByTestId('preset-editor-input-default_filament_colour');
    const initialDefaultColour = await defaultColour.inputValue();
    await defaultColour.evaluate((element) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '#123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(defaultColour).toHaveValue('#123456');
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveText('Project draft');
    await expect(initialActualColour).toHaveValue(initialActualColourValue);
    await page.getByTestId('preset-editor-page-tab-advanced').click();
    const filamentStartGcode = page.getByTestId('preset-editor-input-filament_start_gcode');
    const initialFilamentStartGcode = await filamentStartGcode.inputValue();
    await filamentStartGcode.fill('G28\nM104 S205\nM140 S60\n');
    await filamentStartGcode.press('Control+Enter');
    await expect(filamentStartGcode).toHaveValue('G28\nM104 S205\nM140 S60\n');
    await expect(initialActualColour).toHaveValue(initialActualColourValue);
    await page.getByTestId('preset-editor-close').click();

    await page.getByTestId('filament-add').click();
    await expect(page.getByTestId('filament-slot-2')).toBeVisible();
    const secondActualColour = page.getByTestId('filament-colour-2');
    const secondActualColourValue = await secondActualColour.inputValue();
    await page.getByTestId('filament-actions-2').click();
    await page.getByTestId('filament-edit-2').click();
    await expect(page.getByTestId('preset-editor-title')).toHaveText(filamentSourceName);
    await expect(page.getByTestId('preset-editor-slot-reference'))
      .toHaveText('Used by slot 1 and slot 2. Editing this source affects those slots.');
    await expect(page.getByTestId('preset-editor-input-default_filament_colour')).toHaveValue('#123456');
    await expect(page.getByTestId('filament-colour-1')).toHaveValue(initialActualColourValue);
    await expect(secondActualColour).toHaveValue(secondActualColourValue);
    await page.getByTestId('preset-editor-page-tab-advanced').click();
    await expect(page.getByTestId('preset-editor-input-filament_start_gcode'))
      .toHaveValue('G28\nM104 S205\nM140 S60\n');

    await page.getByTestId('preset-editor-reset-preset').click();
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveCount(0);
    await expect(page.getByTestId('preset-editor-input-filament_start_gcode')).toHaveValue(initialFilamentStartGcode);
    await page.getByTestId('preset-editor-page-tab-filament').click();
    await expect(page.getByTestId('preset-editor-input-default_filament_colour')).toHaveValue(initialDefaultColour);
    await expect(page.getByTestId('filament-colour-1')).toHaveValue(initialActualColourValue);
    await expect(secondActualColour).toHaveValue(secondActualColourValue);
  } finally {
    await app.close();
  }
});
