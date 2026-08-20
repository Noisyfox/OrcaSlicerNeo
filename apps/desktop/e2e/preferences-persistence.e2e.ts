import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');
const PRINTER = 'Bambu Lab P1S 0.4 nozzle';

async function launch(preferences: string, exportPath: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env = {
    ...process.env, ORCA_E2E: '1', ORCA_E2E_MODEL: MODEL_PATH,
    ORCA_E2E_EXPORT: exportPath, ORCA_E2E_PREFERENCES: preferences,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  const page = await app.firstWindow();
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 30_000 });
  return { app, page };
}

test('persists shared profile/sidebar preferences but not session work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-preferences-e2e-'));
  const preferences = join(dir, 'preferences.json');
  const firstExport = join(dir, 'first.gcode');
  const secondExport = join(dir, 'second.gcode');
  const first = await launch(preferences, firstExport);
  try {
    const printer = first.page.getByTestId('preset-select');
    await printer.click();
    await first.page.getByPlaceholder('Search presets…').fill(PRINTER);
    await first.page.getByRole('option', { name: PRINTER }).click();
    await expect(printer).toContainText(PRINTER);

    const resizer = first.page.getByTestId('sidebar-resizer');
    await resizer.focus();
    await resizer.press('ArrowRight');
    await resizer.press('ArrowRight');
    await expect(resizer).toHaveAttribute('aria-valuenow', '320');

    // These are deliberately session-only: they must disappear after relaunch.
    await first.page.getByTestId('btn-add-model').click();
    await expect(first.page.getByTestId('btn-slice')).toBeEnabled();
    const layerHeight = first.page.locator('#layer_height');
    if (await layerHeight.count()) await layerHeight.fill('0.21');
    await first.page.getByTestId('btn-slice').click();
    await expect(first.page.getByText('Sliced')).toBeVisible({ timeout: 10_000 });
    await first.page.getByTestId('btn-export').click();
    await expect.poll(() => existsSync(firstExport)).toBe(true);
  } finally {
    await first.app.close();
  }

  const second = await launch(preferences, secondExport);
  try {
    await expect(second.page.getByTestId('preset-select')).toContainText(PRINTER);
    await expect(second.page.getByTestId('sidebar-resizer')).toHaveAttribute('aria-valuenow', '320');
    await expect(second.page.getByTestId('btn-add-model')).toBeEnabled();
    await expect(second.page.getByTestId('btn-slice')).toBeDisabled();
    await expect(second.page.getByTestId('btn-export')).toBeDisabled();
    if (await second.page.locator('#layer_height').count()) {
      await expect(second.page.locator('#layer_height')).not.toHaveValue('0.21');
    }
    expect(existsSync(secondExport)).toBe(false);
  } finally {
    await second.app.close();
  }
});
