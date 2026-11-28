import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { _electron } from './electron-fixture';
import { cutProjectJourney } from './cut-journey';
import { openProjectMenu, waitForProjectLoad } from './project-menu';

test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires staged Cut WASM');
test.setTimeout(300_000);
test('applied Cut survives project history, Electron 3MF save, reopen and slicing', async ({}, info) => {
  const path = info.outputPath('desktop-cut.3mf');
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_MODEL: path, ORCA_E2E_PROJECT_SAVE: path,
    ORCA_E2E_PREFERENCES: info.outputPath('preferences.json') } as Record<string,string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await cutProjectJourney(page, async () => {
      if (process.platform === 'darwin')
        await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('file-save-project-as')!.click());
      else await page.keyboard.press('Control+Shift+s');
      await expect.poll(async () => (await stat(path).catch(() => null))?.size ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
      await openProjectMenu(page, app); await waitForProjectLoad(page);
      await expect.poll(() => page.evaluate(() => (window as any).__orcaE2e.projectLoadEvidence().receipt))
        .toMatchObject({ sourceDisplayName: 'desktop-cut.3mf', nativeResult: { ok: true, objects: 2 } });
    });
  } finally { await app.close(); }
});
