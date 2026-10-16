import { waitForProjectLoad } from '../../desktop/e2e/project-menu';
import { test, expect } from './browser-fixture';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const project = fileURLToPath(new URL('../../../packages/slicer-wasm/fixtures/multi-filament/independent-reader-basic.3mf', import.meta.url));

test('Web Home opens a local project but keeps recent history empty after returning and reloading', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await expect(page.getByTestId('home-recent-empty')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('home.png') });
  await page.getByTestId('home-new-project').click();
  await expect(page.locator('#app-panel-workspace')).toHaveAttribute('aria-hidden', 'false');
  await page.locator('#app-tab-home').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('home-open-project').click();
  // Cancellation exercises the browser picker seam without touching native state.
  await (await chooser).setFiles([]);
  await expect(page.getByTestId('home-page')).toBeVisible();
  await expect(page.getByTestId('home-open-project')).toBeEnabled();
  await expect(page.getByTestId('home-recent-empty')).toBeVisible();
  const opened = page.waitForEvent('filechooser');
  await page.getByTestId('home-open-project').click();
  await (await opened).setFiles(project);
  await waitForProjectLoad(page);
  await expect(page.getByTestId('titlebar-project-name')).toHaveText('independent-reader-basic');
  const evidence = await page.evaluate(() => (window as unknown as {
    __orcaE2e?: { projectLoadEvidence(): { receipt: { sourceDisplayName: string; sourceByteLength: number } | null } };
  }).__orcaE2e?.projectLoadEvidence().receipt);
  expect(evidence).toMatchObject({ sourceDisplayName: 'independent-reader-basic.3mf', sourceByteLength: statSync(project).size });
  await page.locator('#app-tab-home').click();
  await expect(page.getByTestId('home-recent-empty')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await expect(page.getByTestId('home-recent-empty')).toBeVisible();
});
