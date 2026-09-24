import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DESKTOP_ROOT = resolve(__dirname, '..');
const PROJECT_PATH = process.env.ORCA_E2E_PREPARE_COLOUR_PROJECT?.trim() ?? '';
const REAL = process.env.ORCA_E2E_REAL === '1';

test.skip(!REAL || !PROJECT_PATH || !existsSync(PROJECT_PATH),
  'requires ORCA_E2E_REAL=1 and ORCA_E2E_PREPARE_COLOUR_PROJECT');
test.setTimeout(480_000);

test('imported opaque RGBA slots colour Prepare models like the filament rack', async () => {
  const preferencesPath = join(mkdtempSync(join(tmpdir(), 'orca-prepare-colour-')), 'preferences.json');
  writeFileSync(preferencesPath, JSON.stringify({
    version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {},
  }));
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_REAL: '1',
    ORCA_E2E_PRIME_TOWER_PROJECT: PROJECT_PATH,
    ORCA_E2E_MODEL: PROJECT_PATH,
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
    const confirmation = page.getByTestId('project-load-confirmation-dialog');
    if (await confirmation.isVisible({ timeout: 30_000 }).catch(() => false))
      await page.getByTestId('project-load-confirmation-dialog-continue').click();

    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __orcaE2e?: { projectLoadEvidence?: () => {
        receipt: { sourceDisplayName: string; sourceByteLength: number; commitRoute: string; nativeResult: { ok: boolean; mode?: string } } | null;
      } };
    }).__orcaE2e?.projectLoadEvidence?.() ?? null), { timeout: 300_000 }).toMatchObject({
      receipt: {
        sourceDisplayName: basename(PROJECT_PATH),
        sourceByteLength: statSync(PROJECT_PATH).size,
        commitRoute: 'load-project',
        nativeResult: { ok: true, mode: 'project' },
      },
    });
    await expect(page.getByTestId('filament-colour-1')).toHaveValue('#e72f1d');
    await expect(page.getByTestId('filament-colour-2')).toHaveValue('#f4c032');
    await expect(page.getByTestId('filament-colour-3')).toHaveValue('#e5e5e5');

    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelMaterialColours?: () => Array<{ colour: string }> } })
        .__orcaE2e?.modelMaterialColours?.().map((entry) => entry.colour.toLowerCase()) ?? [],
    ), { timeout: 300_000 }).toEqual(expect.arrayContaining(['#e72f1d', '#f4c032', '#e5e5e5']));
  } finally {
    await app.close();
  }
});
