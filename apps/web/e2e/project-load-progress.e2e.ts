import playwright from '../../desktop/node_modules/@playwright/test/index.js';
const { test, expect } = playwright;
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const configuredProjectPath = process.env.ORCA_E2E_PRIME_TOWER_PROJECT?.trim();
const PROJECT_PATH = configuredProjectPath ? resolve(configuredProjectPath) : '';
const PROJECT_FILE_NAME = basename(PROJECT_PATH);

test.skip(!existsSync(PROJECT_PATH), 'requires ORCA_E2E_PRIME_TOWER_PROJECT');

type ProjectLoadEvidence = {
  receipt: { sourceDisplayName: string; sourceByteLength: number } | null;
};

test('renders native project progress before the real load result commits', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({
      version: 1,
      projectLoadBehaviour: 'load_all',
      selectedProfiles: {},
      ui: {},
    }));
  });
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });

  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('menu-file-trigger').click();
  await page.getByTestId('file-open-project').click();
  await (await chooser).setFiles(PROJECT_PATH);

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
  }), { timeout: 120_000 }).toBe('native-progress-before-result');

  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __orcaE2e?: { projectLoadEvidence?: () => ProjectLoadEvidence } })
      .__orcaE2e?.projectLoadEvidence?.() ?? null,
  ), { timeout: 120_000 }).toMatchObject({
    receipt: {
      sourceDisplayName: PROJECT_FILE_NAME,
      sourceByteLength: statSync(PROJECT_PATH).size,
    },
  });
});
