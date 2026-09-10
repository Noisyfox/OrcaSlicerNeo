// Real threaded regression for an imported multi-plate project whose native
// Process config enables a prime tower without a Neo overlay entry.
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DESKTOP_ROOT = resolve(__dirname, '..');
const PROJECT_PATH = process.env.ORCA_E2E_PRIME_TOWER_PROJECT
  ? resolve(process.env.ORCA_E2E_PRIME_TOWER_PROJECT) : '';
const REAL = process.env.ORCA_E2E_REAL === '1';
test.skip(!REAL || !PROJECT_PATH || !existsSync(PROJECT_PATH),
  'requires ORCA_E2E_REAL=1 and ORCA_E2E_PRIME_TOWER_PROJECT');

test('opened project keeps prime-tower UI and first-plate slice in agreement', async () => {
  const exportDir = mkdtempSync(join(tmpdir(), 'orca-prime-tower-e2e-'));
  const exportPath = join(exportDir, 'first-plate.gcode');
  const preferencesPath = join(exportDir, 'preferences.json');
  writeFileSync(preferencesPath, JSON.stringify({
    version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {},
  }));
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_REAL: '1',
    ORCA_E2E_MODEL: PROJECT_PATH,
    ORCA_E2E_EXPORT: exportPath,
    ORCA_E2E_PREFERENCES: preferencesPath,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app: ElectronApplication = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();

    await page.getByTestId('menu-file-trigger').click();
    await page.getByTestId('file-open-project').click();
    // With an empty startup scene the configured load policy opens directly;
    // a dirty scene instead presents the explicit geometry/project choice.
    const choice = page.getByTestId('project-load-choice-dialog');
    if (await choice.isVisible({ timeout: 30_000 }).catch(() => false)) {
      await page.getByTestId('project-load-project').click();
      await page.getByTestId('project-load-confirm').click();
    }
    const confirmation = page.getByTestId('project-load-confirmation-dialog');
    if (await confirmation.isVisible({ timeout: 30_000 }).catch(() => false))
      await page.getByTestId('project-load-confirmation-dialog-continue').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });

    // The loaded project owns eleven plates and the first plate is the active
    // slicing target for this regression.
    await expect(page.getByTestId('current-plate-label')).toHaveText(/Plate 1 \(11\/36\)/, { timeout: 300_000 });
    await expect(page.locator('#enable_prime_tower')).toBeChecked();

    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 300_000 });
    await page.getByTestId('btn-export').click();
    await expect.poll(() => existsSync(exportPath), { timeout: 30_000 }).toBe(true);
    const gcode = readFileSync(exportPath, 'utf8');
    // Match emitted toolpath markers, rather than configuration headers or
    // filament-change/flush templates that may mention a tower without one.
    expect(gcode).toMatch(/^; WIPE_TOWER_START$/m);
    expect(gcode).toMatch(/^; FEATURE: Prime tower$/m);
  } finally {
    await app.close();
  }
});
