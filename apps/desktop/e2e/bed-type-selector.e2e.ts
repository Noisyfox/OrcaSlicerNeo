import { _electron } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('bed memory survives Electron reload/restart and New Project without clobbering preferences', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'neo-bed-memory-')), 'preferences.json');
  writeFileSync(file, JSON.stringify({ version: 1, ui: { sidebarWidth: 320 }, colorPicker: { favorites: [{ kind: 'solid', color: '#112233' }] } }));
  const launch = async () => {
    const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_PREFERENCES: file } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    return { app, page };
  };
  let host = await launch();
  try {
    const bed = host.page.getByTestId('global-bed-type-select');
    await expect(bed).toBeVisible();
    const original = await bed.innerText();
    await bed.click();
    await host.page.getByRole('option', { name: 'Smooth High Temp Plate', exact: true }).click();
    await expect(bed).toContainText('Smooth High Temp Plate');
    await expect(() => {
      const prefs = JSON.parse(readFileSync(file, 'utf8'));
      expect(Object.values(prefs.rememberedBedTypes)).toContain('High Temp Plate');
      expect(prefs.colorPicker.favorites).toEqual([{ kind: 'solid', color: '#112233' }]);
    }).toPass({ timeout: 5000 });
    await host.page.getByTestId('history-undo').click();
    await expect(bed).toContainText(original);
    expect(Object.values(JSON.parse(readFileSync(file, 'utf8')).rememberedBedTypes)).toContain('High Temp Plate');
    await host.page.reload();
    await expect(host.page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await host.page.locator('#app-tab-prepare').click();
    await expect(bed).toContainText('Smooth High Temp Plate');
    await host.app.close();
    host = await launch();
    await expect(host.page.getByTestId('global-bed-type-select')).toContainText('Smooth High Temp Plate');
    await host.page.getByTestId('config-mode-plates').click();
    await host.page.getByTestId('config-input-curr_bed_type').click();
    await host.page.getByRole('option', { name: 'Engineering Plate', exact: true }).click();
    await expect(host.page.getByTestId('history-undo')).toBeEnabled();
    await host.page.getByTestId('titlebar-menu-trigger').click();
    await host.page.getByTestId('menu-file-trigger').hover();
    await host.page.locator('[data-slot="menubar-sub-content"]').hover({ position: { x: 8, y: 8 } });
    await host.page.getByTestId('file-new-project').click();
    await expect(host.page.getByTestId('project-dirty-dialog')).toBeVisible();
    await host.page.getByTestId('project-dirty-dont-save').click();
    await expect(host.page.getByTestId('preset-select')).toBeEnabled();
    await expect(host.page.getByTestId('global-bed-type-select')).toContainText('Smooth High Temp Plate');
    await expect(host.page.getByTestId('history-undo')).toBeDisabled();
  } finally { await host.app.close(); }
});
