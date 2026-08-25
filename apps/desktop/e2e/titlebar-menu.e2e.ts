// Cross-host menu contract exercised through the shared Electron titlebar.
// This intentionally uses the existing mock bridge so the test proves the
// renderer/host boundary without requiring a real WASM build.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');

async function launchMenuApp(): Promise<ElectronApplication> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-titlebar-e2e-'));
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: MODEL_PATH,
    ORCA_E2E_EXPORT: join(dir, 'out.gcode'),
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
}

async function openFileMenu(page: Page): Promise<void> {
  await page.getByTestId('menu-file-trigger').click();
  await expect(page.getByTestId('file-add-model')).toBeVisible();
}

test('Windows/Linux custom titlebar tracks shared model and result state', async () => {
  const app = await launchMenuApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('titlebar')).toBeVisible();
    await expect(page.getByTestId('titlebar-menu')).toBeVisible();
    await expect(page.getByTestId('menu-file-trigger')).toHaveClass(/no-drag/);
    await expect(page.getByTestId('menu-help-trigger')).toHaveClass(/no-drag/);

    await expect(page.getByTestId('preset-select')).toBeVisible();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
    await openFileMenu(page);

    await expect(page.getByTestId('file-add-model')).toBeEnabled();
    await expect(page.getByTestId('file-clear-scene')).toBeDisabled();
    await expect(page.getByTestId('file-slice')).toBeDisabled();
    await expect(page.getByTestId('file-export-gcode')).toBeDisabled();
    await expect(page.getByTestId('file-quit')).toHaveText('Exit');
    await expect(page.getByTestId('file-quit')).toBeEnabled();
    await page.getByTestId('file-add-model').click();

    await expect(page.getByTestId('btn-slice')).toBeEnabled();
    await openFileMenu(page);
    await expect(page.getByTestId('file-add-model')).toBeEnabled();
    await expect(page.getByTestId('file-clear-scene')).toBeEnabled();
    await expect(page.getByTestId('file-slice')).toBeEnabled();
    await expect(page.getByTestId('file-export-gcode')).toBeDisabled();
    await page.getByTestId('file-slice').click();

    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced');
    await openFileMenu(page);
    await expect(page.getByTestId('file-export-gcode')).toBeEnabled();

    await page.getByTestId('file-clear-scene').click();
    await expect(page.getByTestId('btn-slice')).toBeDisabled();
    await openFileMenu(page);
    await expect(page.getByTestId('file-clear-scene')).toBeDisabled();
    await expect(page.getByTestId('file-slice')).toBeDisabled();
    await expect(page.getByTestId('file-export-gcode')).toBeDisabled();
  } finally {
    await app.close();
  }
});
