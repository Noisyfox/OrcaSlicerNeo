// apps/desktop/e2e/app.e2e.ts — the full v1 flow against the built app.
// Mock mode (default): expects the mock gcode marker. Real mode
// (ORCA_E2E_REAL=1, CI e2e-real job): expects real extruder moves (G1).
// The ORCA_E2E env contract replaces native dialogs in main (see
// apps/desktop/src/main/index.ts) — Playwright cannot drive them.
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');
const REAL = process.env.ORCA_E2E_REAL === '1';

interface LaunchResult {
  app: ElectronApplication;
  exportPath: string;
}

async function launchApp(): Promise<LaunchResult> {
  const exportDir = mkdtempSync(join(tmpdir(), 'orca-e2e-'));
  const exportPath = join(exportDir, 'out.gcode');
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: MODEL_PATH,
    ORCA_E2E_EXPORT: exportPath,
  } as Record<string, string>;
  // Ambient shells sometimes carry ELECTRON_RUN_AS_NODE=1, which forces
  // Electron to run as plain node (the app cannot boot) — never valid here.
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    args: ['.'],
    cwd: DESKTOP_ROOT,
    env,
  });
  return { app, exportPath };
}

test('full v1 flow: open model → slice → preview → export gcode', async () => {
  const { app, exportPath } = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });

    // App ready: settings panel rendered from bridge metadata (mock presets).
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');

    // Slice gated until a model is loaded.
    await expect(page.getByTestId('btn-slice')).toBeDisabled();
    await expect(page.getByTestId('btn-export')).toBeDisabled();

    // Open model (ORCA_E2E stub returns the fixture path).
    await page.getByTestId('btn-open').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });

    // Slice → status flips to Sliced, preview + scrubber appear, export unlocks.
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 60_000 });
    await expect(page.getByTestId('viewport')).toBeVisible();
    await expect(page.getByTestId('layer-scrubber')).toBeVisible();
    await expect(page.getByTestId('btn-export')).toBeEnabled();

    // Export → file on disk with the expected gcode contents.
    await page.getByTestId('btn-export').click();
    await expect.poll(() => existsSync(exportPath), { timeout: 30_000 }).toBe(true);
    const gcode = readFileSync(exportPath, 'utf8');
    if (REAL) {
      expect(gcode).toContain('G1'); // real module: extruder moves
      expect(gcode).not.toContain('; mock gcode');
    } else {
      expect(gcode).toContain('; mock gcode (unit-test fixture)');
    }
  } finally {
    await app.close();
  }
});
