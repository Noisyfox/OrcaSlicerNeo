import { test, expect } from './browser-fixture';
import { waitForProjectLoad } from '../../desktop/e2e/project-menu';
import { cutDraftJourney, cutProjectJourney } from '../../desktop/e2e/cut-journey';
test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires built Cut WASM');
test.setTimeout(300_000);
test('Cut draft in Prepare', async ({ page }) => {
  await page.goto('/');
  await cutDraftJourney(page);
});

test('applied Cut survives project history, Web 3MF download, reopen and slicing', async ({ page }, info) => {
  await page.goto('/');
  await cutProjectJourney(page, async () => {
    const download = page.waitForEvent('download');
    await page.keyboard.press('Control+Shift+s');
    const exported = await download, path = info.outputPath('web-cut.3mf');
    await exported.saveAs(path);
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('titlebar-menu-trigger').click(); await page.getByTestId('menu-file-trigger').hover();
    await page.locator('[data-slot="menubar-sub-content"]').hover({position:{x:8,y:8}});
    await page.getByTestId('file-open-project').click();
    await (await chooser).setFiles(path);
    await waitForProjectLoad(page);
    await expect.poll(() => page.evaluate(() => (window as any).__orcaE2e.projectLoadEvidence().receipt))
      .toMatchObject({ sourceDisplayName: 'web-cut.3mf', nativeResult: { ok: true, objects: 2 } });
  });
});
