// apps/desktop/e2e/slice-error.e2e.ts — the slice-error surfacing contract.
// Real-module only (skipped in mock builds): slicing a model that libslic3r
// rejects must surface the REAL message in the status bar, not the bare
// SlicingErrors category ("Errors") that the bridge used to return
// (bridge.cpp error_json_from_exception + Toolbar errorText — see
// doc/2026-08-15-slice-error-surfacing.md).
// Run with the real module build: ORCA_E2E_REAL=1 playwright test e2e/slice-error.e2e.ts
// (test:e2e:real runs it in the e2e-real CI job; the default mock build
// skips — the mock always slices successfully).
import { _electron, test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const REAL = process.env.ORCA_E2E_REAL === '1';
const PRESET_READY_TIMEOUT = REAL ? 300_000 : 30_000;
const BAD_MODEL = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');

test.skip(!REAL, 'real-module only (mock module slices successfully)');

test('a rejecting model surfaces its real error message in the status bar', async () => {
  const exportDir = mkdtempSync(join(tmpdir(), 'orca-err-'));
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: BAD_MODEL,
    ORCA_E2E_EXPORT: join(exportDir, 'out.gcode'),
    ORCA_E2E_PRINTER: 'Creality Ender-3 0.4 nozzle',
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;

  const app: ElectronApplication = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  const page: Page = await app.firstWindow();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: PRESET_READY_TIMEOUT });
    await page.locator('#app-tab-prepare').click();

    // The real module parses the complete preset tree before this appears.
    await page.getByTestId('preset-select').waitFor({ timeout: PRESET_READY_TIMEOUT });
    await page.getByTestId('btn-add-model').click();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid=btn-slice]')?.hasAttribute('disabled'),
      { timeout: 30000 },
    );

    // Invalid layer height is rejected by the real bridge's config
    // validation. This remains a real-artifact error path without relying on
    // a profile-specific floating-geometry heuristic.
    const layerHeight = page.locator('#layer_height');
    await expect(layerHeight).toBeVisible();
    await layerHeight.fill('0');
    await page.getByTestId('btn-slice').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid=slicer-status]');
      return el && el.textContent !== 'Slicing…';
    }, { timeout: 120000 });

    await expect(page.getByTestId('slicer-status')).toHaveText('Error');
    // The destructive span must carry the REAL per-object message — the
    // regression showed the bare SlicingErrors category ("Error: Errors").
    await expect(page.locator('.text-destructive')).toHaveText(
      /layer|height|invalid|value/i, { timeout: 10_000 });
    await expect(page.locator('.text-destructive')).not.toHaveText(/^Error: Errors$/);
    // Export stays gated after a failed slice.
    await expect(page.getByTestId('btn-export')).toBeDisabled();

    // The guard rejects before entering the worker, so a retry is immediate;
    // it must remain a recoverable, descriptive error and never abort WASM.
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Error');
    await expect(page.locator('.text-destructive')).toHaveText(/layer|height|invalid|value/i);
  } finally {
    await app.close();
  }
});
