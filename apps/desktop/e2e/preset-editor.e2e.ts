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
    await expect(page.getByTestId('preset-editor-title')).toHaveText('Bambu Lab X1 Carbon 0.4 nozzle');
    const printableHeight = page.getByTestId('preset-editor-input-printable_height');
    await printableHeight.fill('260');
    await printableHeight.press('Enter');
    await expect(printableHeight).toHaveValue('260');
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveText('Project draft');
    await page.getByTestId('preset-editor-reset-preset').click();
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveCount(0);
    await expect(printableHeight).toHaveValue('256');
    await page.getByTestId('preset-editor-close').click();

    const initialActualColour = page.getByTestId('filament-colour-1');
    await expect(initialActualColour).toHaveValue('#f2754e');
    await page.getByTestId('filament-actions-1').click();
    await page.getByTestId('filament-edit-1').click();
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('preset-editor-title')).toHaveText('Generic PLA @System');
    const defaultColour = page.getByTestId('preset-editor-input-default_filament_colour');
    await defaultColour.evaluate((element) => {
      const input = element as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '#123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(defaultColour).toHaveValue('#123456');
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveText('Project draft');
    await expect(initialActualColour).toHaveValue('#f2754e');
    await page.getByTestId('preset-editor-close').click();

    await page.getByTestId('filament-add').click();
    await expect(page.getByTestId('filament-slot-2')).toBeVisible();
    await page.getByTestId('filament-actions-2').click();
    await page.getByTestId('filament-edit-2').click();
    await expect(page.getByTestId('preset-editor-title')).toHaveText('Generic PLA @System');
    await expect(page.getByTestId('preset-editor-slot-reference'))
      .toHaveText('Used by slot 1 and slot 2. Editing this source affects those slots.');
    await expect(page.getByTestId('preset-editor-input-default_filament_colour')).toHaveValue('#123456');
    await expect(page.getByTestId('filament-colour-1')).toHaveValue('#f2754e');
    await expect(page.getByTestId('filament-colour-2')).toHaveValue('#f2754e');

    await page.getByTestId('preset-editor-reset-preset').click();
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveCount(0);
    await expect(page.getByTestId('preset-editor-input-default_filament_colour')).toHaveValue('#f2754e');
    await expect(page.getByTestId('filament-colour-1')).toHaveValue('#f2754e');
    await expect(page.getByTestId('filament-colour-2')).toHaveValue('#f2754e');
  } finally {
    await app.close();
  }
});
