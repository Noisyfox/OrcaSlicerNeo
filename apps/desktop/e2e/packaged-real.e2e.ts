// Real packaged Step8 acceptance. This file is intentionally separate from
// packaged.e2e.ts: the latter uses the tiny JS bridge stub for a fast asset and
// failure probe, while this spec must be run only after staging the current
// dual real artifacts with `node scripts/stage.mjs`.
import { _electron, expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test.describe.configure({ timeout: 300_000 });

const DESKTOP_ROOT = resolve(__dirname, '..');
const PACKAGED_ROOT = resolve(DESKTOP_ROOT, process.env.ORCA_E2E_PACKAGED_ROOT ?? 'release/step8-real/win-unpacked');
const EXE = process.platform === 'win32' ? resolve(PACKAGED_ROOT, 'OrcaSlicerNeo.exe') : resolve(PACKAGED_ROOT, 'OrcaSlicerNeo');
const MODEL = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');

test('real packaged threaded runtime loads dual artifacts and completes slice/export', async () => {
  expect(existsSync(EXE), `real packaged app missing — stage real WASM and run package:dir (${EXE})`).toBe(true);
  expect(existsSync(MODEL)).toBe(true);
  const exportDir = mkdtempSync(join(tmpdir(), 'orca-packaged-real-'));
  const exportPath = join(exportDir, 'real.gcode');
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_MODEL: MODEL, ORCA_E2E_EXPORT: exportPath } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: EXE, env });
  try {
    const page = await app.firstWindow();
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 300_000 });
    const resourceUrls = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name));
    const threaded = [...requests, ...resourceUrls].filter((url) => url.includes('/wasm/threaded/'));
    expect(threaded.some((url) => url.endsWith('/orca_slice.js'))).toBe(true);
    expect(threaded.some((url) => url.endsWith('/orca_slice.wasm'))).toBe(true);
    expect(threaded.some((url) => url.endsWith('/orca_slice.data'))).toBe(true);
    await expect(page.getByTestId('btn-add-model')).toBeVisible();
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
    await expect(page.getByTestId('btn-export')).toBeEnabled();
    await page.getByTestId('btn-export').click();
    await expect.poll(() => existsSync(exportPath)).toBe(true);
    expect(readFileSync(exportPath, 'utf8')).toMatch(/G1/);
  } finally {
    await app.close();
  }
});
