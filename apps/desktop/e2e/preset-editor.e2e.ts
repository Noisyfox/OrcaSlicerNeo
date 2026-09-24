import { _electron, expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const REAL = process.env.ORCA_E2E_REAL === '1';

async function selectFilamentPreset(page: Page, name: string): Promise<void> {
  const preset = page.getByTestId('filament-preset-1');
  await preset.click();
  await page.getByPlaceholder('Search compatible presets…').fill(name);
  await page.getByRole('option', { name, exact: true }).click();
  await expect(preset).toContainText(name);
}

async function editNumericField(
  page: Page,
  key: string,
  nativeType: 'float' | 'int' | 'percent',
  step: number,
): Promise<{ before: string; after: string }> {
  const field = page.getByTestId(`preset-editor-field-${key}`);
  await expect(field).toHaveAttribute('data-native-scalar-type', nativeType);
  const input = page.getByTestId(`preset-editor-input-${key}`);
  const before = await input.inputValue();
  const current = Number(before);
  if (!Number.isFinite(current)) throw new Error(`expected a native numeric value for ${key}`);
  const minimumText = await field.getAttribute('data-native-min');
  const maximumText = await field.getAttribute('data-native-max');
  const minimum = minimumText === null ? Number.NEGATIVE_INFINITY : Number(minimumText);
  const maximum = maximumText === null ? Number.POSITIVE_INFINITY : Number(maximumText);
  const next = [current + step, current - step]
    .find((candidate) => candidate !== current && candidate >= minimum && candidate <= maximum);
  if (next === undefined) throw new Error(`expected a distinct ${key} value within [${minimum}, ${maximum}]`);
  const after = String(next);
  await input.fill(after);
  await input.press('Enter');
  await expect(input).toHaveValue(after);
  return { before, after };
}

async function editClosedEnumField(page: Page, key: string): Promise<{ before: string; after: string }> {
  const field = page.getByTestId(`preset-editor-field-${key}`);
  await expect(field).toHaveAttribute('data-native-scalar-type', 'enum');
  const input = page.getByTestId(`preset-editor-input-${key}`);
  const before = (await input.textContent())?.trim() ?? '';
  await input.click();
  const options = page.getByRole('option');
  const labels = (await options.allTextContents()).map((label) => label.trim());
  const after = labels.find((label) => label.length > 0 && label !== before);
  if (!after) throw new Error(`expected a distinct native enum option for ${key}`);
  await page.getByRole('option', { name: after, exact: true }).click();
  await expect(input).toContainText(after);
  return { before, after };
}

test('preset editor modal edits Printer and shared Filament drafts without changing slot colors', async () => {
  const env = { ...process.env, ORCA_E2E: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    if (REAL) await selectFilamentPreset(page, 'Generic PLA @System');

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

    const vectorChanges: Record<string, { before: string; after: string }> = {};
    if (REAL) {
      await page.getByTestId('preset-editor-page-tab-filament').click();
      vectorChanges.filament_max_volumetric_speed = await editNumericField(
        page, 'filament_max_volumetric_speed', 'float', 1,
      );
      vectorChanges.filament_adhesiveness_category = await editNumericField(
        page, 'filament_adhesiveness_category', 'int', 1,
      );
      vectorChanges.filament_shrink = await editNumericField(page, 'filament_shrink', 'percent', 0.25);
      await expect(page.getByTestId('preset-editor-field-filament_shrink')).toContainText('%');

      const nullableBool = page.getByTestId('preset-editor-input-filament_adaptive_volumetric_speed');
      await expect(page.getByTestId('preset-editor-field-filament_adaptive_volumetric_speed'))
        .toHaveAttribute('data-native-scalar-type', 'bool');
      vectorChanges.filament_adaptive_volumetric_speed = {
        before: (await nullableBool.textContent())?.trim() ?? '',
        after: '',
      };
      await nullableBool.click();
      await page.getByRole('option', { name: 'Not set', exact: true }).click();
      await expect(nullableBool).toContainText('Not set');
      await nullableBool.click();
      await page.getByRole('option', { name: 'Enabled', exact: true }).click();
      await expect(nullableBool).toContainText('Enabled');
      vectorChanges.filament_adaptive_volumetric_speed.after = 'Enabled';

      await page.getByTestId('preset-editor-page-tab-cooling').click();
      vectorChanges.overhang_fan_threshold = await editClosedEnumField(page, 'overhang_fan_threshold');
    }
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
    if (REAL) {
      await page.getByTestId('preset-editor-page-tab-filament').click();
      for (const key of [
        'filament_max_volumetric_speed', 'filament_adhesiveness_category', 'filament_shrink',
      ]) {
        await expect(page.getByTestId(`preset-editor-input-${key}`)).toHaveValue(vectorChanges[key].after);
      }
      await expect(page.getByTestId('preset-editor-input-filament_adaptive_volumetric_speed'))
        .toContainText(vectorChanges.filament_adaptive_volumetric_speed.after);
      await page.getByTestId('preset-editor-page-tab-cooling').click();
      await expect(page.getByTestId('preset-editor-input-overhang_fan_threshold'))
        .toContainText(vectorChanges.overhang_fan_threshold.after);
    }
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
    if (REAL) {
      for (const key of [
        'filament_max_volumetric_speed', 'filament_adhesiveness_category', 'filament_shrink',
      ]) {
        await expect(page.getByTestId(`preset-editor-input-${key}`)).toHaveValue(vectorChanges[key].before);
      }
      const nullableBool = page.getByTestId('preset-editor-input-filament_adaptive_volumetric_speed');
      await expect(nullableBool).toContainText(vectorChanges.filament_adaptive_volumetric_speed.before);
      await page.getByTestId('preset-editor-page-tab-cooling').click();
      await expect(page.getByTestId('preset-editor-input-overhang_fan_threshold'))
        .toContainText(vectorChanges.overhang_fan_threshold.before);
      await page.getByTestId('preset-editor-close').click();

      await page.getByTestId('history-undo').click();
      await page.getByTestId('filament-actions-2').click();
      await page.getByTestId('filament-edit-2').click();
      await expect(page.getByTestId('preset-editor-project-draft')).toHaveText('Project draft');
      await page.getByTestId('preset-editor-page-tab-filament').click();
      for (const key of [
        'filament_max_volumetric_speed', 'filament_adhesiveness_category', 'filament_shrink',
      ]) {
        await expect(page.getByTestId(`preset-editor-input-${key}`)).toHaveValue(vectorChanges[key].after);
      }
      await expect(page.getByTestId('preset-editor-input-filament_adaptive_volumetric_speed'))
        .toContainText(vectorChanges.filament_adaptive_volumetric_speed.after);
      await page.getByTestId('preset-editor-page-tab-cooling').click();
      await expect(page.getByTestId('preset-editor-input-overhang_fan_threshold'))
        .toContainText(vectorChanges.overhang_fan_threshold.after);
      await page.getByTestId('preset-editor-close').click();

      await page.getByTestId('history-redo').click();
      await page.getByTestId('filament-actions-2').click();
      await page.getByTestId('filament-edit-2').click();
      await expect(page.getByTestId('preset-editor-project-draft')).toHaveCount(0);
      await page.getByTestId('preset-editor-page-tab-filament').click();
      for (const key of [
        'filament_max_volumetric_speed', 'filament_adhesiveness_category', 'filament_shrink',
      ]) {
        await expect(page.getByTestId(`preset-editor-input-${key}`)).toHaveValue(vectorChanges[key].before);
      }
      await expect(page.getByTestId('preset-editor-input-filament_adaptive_volumetric_speed'))
        .toContainText(vectorChanges.filament_adaptive_volumetric_speed.before);
      await page.getByTestId('preset-editor-page-tab-cooling').click();
      await expect(page.getByTestId('preset-editor-input-overhang_fan_threshold'))
        .toContainText(vectorChanges.overhang_fan_threshold.before);
      await expect(page.getByTestId('filament-colour-1')).toHaveValue(initialActualColourValue);
      await expect(secondActualColour).toHaveValue(secondActualColourValue);
    }
  } finally {
    await app.close();
  }
});
