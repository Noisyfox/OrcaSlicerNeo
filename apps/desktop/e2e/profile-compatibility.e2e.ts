import { _electron } from './electron-fixture';
// Compatibility UI coverage uses the desktop E2E mock's fixed preset graph.
// Native compatible_printers / condition / compatible_prints interpretation is
// separately proven by the real-WASM fixture harness; this test proves the
// shared application's snapshot replacement, picker locking, and slice-state
// invalidation without reproducing compatibility filtering in TypeScript.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clickPlateControl, expectCurrentPlate } from './plate-controls.helpers';
import { selectFixturePrinter } from './printer-selection';

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

test('profile changes preserve the camera on unchanged beds and frame resized beds around the current plate', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    await clickPlateControl(page, 'add-plate');
    await expectCurrentPlate(page, 'Plate 2', 2);
    await expect.poll(() => page.evaluate(() => Boolean(
      (window as any).__orcaE2e?.cameraState?.(),
    ))).toBe(true);

    const readCamera = () => page.evaluate(() => {
      const state = (window as any).__orcaE2e.cameraState();
      const round = (values: number[]) => values.map((value) => Math.round(value * 1e6) / 1e6);
      return { position: round(state.position), quaternion: round(state.quaternion), target: round(state.target) };
    });
    // Establish a distinct orbit/pan/zoom through the existing scene probe.
    await page.evaluate(() => (window as any).__orcaE2e.setCameraView([620, -500, 420], [410, -190, 0]));
    const before = await readCamera();
    await page.getByTestId('process-preset-select').click();
    await page.locator('[data-slot="combobox-content"]')
      .getByRole('option', { name: '0.16mm Optimal @BBL X1C', exact: true }).click();
    await expect(page.getByTestId('process-preset-select')).toContainText('0.16mm Optimal');
    await expect(page.getByTestId('process-preset-select')).toBeEnabled();
    await expectCurrentPlate(page, 'Plate 2', 2);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await readCamera()).toEqual(before);

    await selectFixturePrinter(page, 'Bambu Lab P1S 0.4 nozzle');
    await expectCurrentPlate(page, 'Plate 2', 2);
    await expect.poll(async () => {
      const current = await page.evaluate(() =>
        (window as any).__orcaE2e.bedPlateStates().find((plate: { current: boolean }) => plate.current),
      );
      const camera = await readCamera();
      return current && {
        currentPlateOffset: current.position[0] > 0,
        centerError: [
          camera.target[0] - current.position[0] - (current.bounds.minX + current.bounds.maxX) / 2,
          camera.target[1] - current.position[1] - (current.bounds.minY + current.bounds.maxY) / 2,
          camera.target[2],
        ],
      };
    }).toEqual({ currentPlateOffset: true, centerError: [0, 0, 0] });
  } finally {
    await app.close();
  }
});

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
    await popup.getByPlaceholder('Search presets…').fill('Bambu Lab P1S');
    await popup.getByRole('option', { name: 'Bambu Lab P1S', exact: true }).click();

    // The e2e mock delays profile selection and atomic Printer replies. This verifies that a
    // stale Process or Filament popup cannot be selected while the C++-shaped
    // atomic snapshot is still in flight.
    await expect(page.getByTestId('preset-transition-region')).toHaveAttribute('aria-busy', 'true');
    expect((await page.getByTestId('process-preset-select').boundingBox())?.y).toBe(processTopBeforeTransition);
    await expect(page.getByTestId('preset-select')).toBeDisabled();
    await expect(page.getByTestId('nozzle-variant-select')).toBeDisabled();
    await expect(page.getByTestId('process-preset-select')).toBeDisabled();
    await expect(page.getByTestId('filament-preset-select')).toHaveCount(0);

    await expect(page.getByTestId('preset-transition-region')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByTestId('preset-select')).toContainText('Bambu Lab P1S');
    await expect(page.getByTestId('nozzle-variant-select')).toContainText('0.4');
    await expect(page.getByTestId('nozzle-variant-select')).toBeEnabled();
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
    await expect(page.getByTestId('filament-preset-1')).toContainText('Generic PLA');
    await expect(page.getByTestId('filament-preset-1')).toHaveAttribute('title', 'Generic PLA @System');

    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
    await expect(page.getByTestId('btn-export')).toHaveCount(0);
    await expect(page.getByTestId('layer-scrubber')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
