// This is intentionally separate from viewport assertions: it proves the
// real 3MF selected by the Electron host became the native project session.
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DESKTOP_ROOT = resolve(__dirname, '..');
const configuredProjectPath = process.env.ORCA_E2E_PRIME_TOWER_PROJECT?.trim();
const PROJECT_PATH = configuredProjectPath ? resolve(configuredProjectPath) : '';
const PROJECT_FILE_NAME = basename(PROJECT_PATH);
const PROJECT_NAME = PROJECT_FILE_NAME.replace(/\.3mf$/i, '');
const REAL = process.env.ORCA_E2E_REAL === '1';

test.skip(!REAL || !existsSync(PROJECT_PATH),
  'requires ORCA_E2E_REAL=1 and ORCA_E2E_PRIME_TOWER_PROJECT');

type ProjectLoadEvidence = {
  receipt: {
    sourceDisplayName: string;
    sourceByteLength: number;
    commitRoute: 'load-project';
    nativeResult: {
      ok: boolean;
      mode?: string;
      displayName?: string;
      objects: number;
      instances: number;
      projectSettingsAvailable?: boolean;
      multiPlate?: boolean;
      plateCount?: number;
    };
  } | null;
  session: { projectName: string; hasContent: boolean; scope: string; hasLocation: boolean };
};

test('commits the requested multi-plate project before dependent E2E assertions', async () => {
  const preferencesPath = join(mkdtempSync(join(tmpdir(), 'orca-project-load-proof-')), 'preferences.json');
  // The native dialog cannot be driven through Playwright. The main process
  // accepts this only behind ORCA_E2E and reads the exact path below.
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

    const readEvidence = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { projectLoadEvidence?: () => ProjectLoadEvidence } })
        .__orcaE2e?.projectLoadEvidence?.() ?? null,
    );
    await page.getByTestId('menu-file-trigger').click();
    await page.getByTestId('file-open-project').click();

    await expect(page.getByTestId('project-progress-dialog')).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => page.evaluate(() => {
      const evidence = (window as unknown as {
        __orcaE2e?: { projectLoadEvidence?: () => ProjectLoadEvidence };
      }).__orcaE2e?.projectLoadEvidence?.() ?? null;
      const dialog = document.querySelector('[data-testid="project-progress-dialog"]');
      const message = document.querySelector('[data-testid="project-progress-message"]')?.textContent ?? '';
      const progress = Number(document.querySelector('[data-testid="project-progress"]')?.getAttribute('aria-valuenow'));
      const nativeStage = /Reading project metadata|Loading project model|Reading project settings|Applying project settings|Finalizing project/.test(message);
      return dialog && evidence?.receipt === null && nativeStage && progress > 0 && progress < 100
        ? 'native-progress-before-result'
        : `waiting:${evidence?.receipt === null}:${progress}:${message}`;
    }), { timeout: 300_000 }).toBe('native-progress-before-result');

    const confirmation = page.getByTestId('project-load-confirmation-dialog');
    if (await confirmation.isVisible({ timeout: 30_000 }).catch(() => false))
      await page.getByTestId('project-load-confirmation-dialog-continue').click();

    await expect.poll(readEvidence, { timeout: 300_000 }).toMatchObject({
      receipt: {
        sourceDisplayName: PROJECT_FILE_NAME,
        sourceByteLength: statSync(PROJECT_PATH).size,
        commitRoute: 'load-project',
        nativeResult: {
          ok: true,
          mode: 'project',
          displayName: PROJECT_FILE_NAME,
          projectSettingsAvailable: true,
          multiPlate: true,
        },
      },
      session: {
        projectName: PROJECT_NAME,
        hasContent: true,
        scope: 'project',
        hasLocation: true,
      },
    });
    const evidence = await readEvidence();
    expect(evidence?.receipt?.nativeResult.objects).toBeGreaterThan(0);
    expect(evidence?.receipt?.nativeResult.instances).toBeGreaterThan(0);
    expect(evidence?.receipt?.nativeResult.plateCount).toBeGreaterThan(1);
  } finally {
    await app.close();
  }
});
