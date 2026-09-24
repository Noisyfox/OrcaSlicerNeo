// Compatibility UI coverage uses the desktop E2E mock's fixed preset graph.
// Native compatible_printers / condition / compatible_prints interpretation is
// separately proven by the real-WASM fixture harness; this test proves the
// shared application's snapshot replacement, picker locking, and slice-state
// invalidation without reproducing compatibility filtering in TypeScript.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');

async function launchApp(): Promise<ElectronApplication> {
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: MODEL_PATH,
    ORCA_E2E_EXPORT: join(mkdtempSync(join(tmpdir(), 'orca-profile-compat-e2e-')), 'out.gcode'),
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
}

async function optionNames(page: Page, triggerTestId: string): Promise<string[]> {
  await page.getByTestId(triggerTestId).click();
  const popup = page.locator('[data-slot="combobox-content"]');
  await expect(popup).toBeVisible();
  const names = await popup.locator('[data-slot="combobox-item"]').allTextContents();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  return names;
}

test('printer transitions atomically replace the Process picker while the Filament rack remains authoritative', async () => {
  test.setTimeout(120_000);
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('filament-rack')).toBeVisible();
    await expect(page.getByTestId('filament-slot-1')).toBeVisible();
    await expect(page.getByTestId('filament-preset-select')).toHaveCount(0);
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');

    // Establish a completed result first, so the transition can prove it
    // invalidates the old profile combination's G-code/export state.
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled();
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced');
    await expect(page.getByTestId('btn-export')).toBeEnabled();

    const processTopBeforeTransition = (await page.getByTestId('process-preset-select').boundingBox())?.y;
    expect(processTopBeforeTransition).toBeDefined();

    await page.getByTestId('preset-select').click();
    const popup = page.locator('[data-slot="combobox-content"]');
    await popup.getByPlaceholder('Search presets…').fill('Bambu Lab P1S 0.4 nozzle');
    await popup.getByRole('option', { name: 'Bambu Lab P1S 0.4 nozzle', exact: true }).click();

    // The e2e mock delays profile selection and atomic Printer replies. This verifies that a
    // stale Process or Filament popup cannot be selected while the C++-shaped
    // atomic snapshot is still in flight.
    await expect(page.getByTestId('preset-transition-region')).toHaveAttribute('aria-busy', 'true');
    expect((await page.getByTestId('process-preset-select').boundingBox())?.y).toBe(processTopBeforeTransition);
    await expect(page.getByTestId('preset-select')).toBeDisabled();
    await expect(page.getByTestId('process-preset-select')).toBeDisabled();
    await expect(page.getByTestId('filament-preset-select')).toHaveCount(0);

    await expect(page.getByTestId('preset-transition-region')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByTestId('preset-select')).toContainText('Bambu Lab P1S 0.4 nozzle');
    await expect(page.getByTestId('process-preset-select')).toContainText('0.20mm Standard @BBL P1S');
    await expect(page.getByTestId('filament-preset-select')).toHaveCount(0);
    await expect(page.getByTestId('preset-select')).toBeEnabled();
    await expect(page.getByTestId('process-preset-select')).toBeEnabled();

    // Exact mock graph candidates: old X1C Process entries must not survive
    // the printer switch. The filament rack remains the only filament
    // selection surface in Prepare.
    await expect(optionNames(page, 'process-preset-select')).resolves.toEqual([
      '0.20mm Standard @BBL P1S',
    ]);
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('filament-rack')).toBeVisible();
    await expect(page.getByTestId('filament-slot-1')).toBeVisible();
    await expect(page.getByTestId('filament-preset-1')).toContainText('Generic PLA @System');

    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
    await expect(page.getByTestId('btn-export')).toBeDisabled();
    await expect(page.getByTestId('layer-scrubber')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
