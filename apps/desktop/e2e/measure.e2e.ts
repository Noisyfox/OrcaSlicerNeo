import { _electron } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { history, ready, selectPrinter } from './arrangement-journey';
import { booleanMeshes } from './mesh-boolean-journey';

test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires the freshly staged threaded WASM');
test.setTimeout(480_000);

test('real Electron Measure selects native features and preserves scene/history ownership', async ({}, info) => {
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-measure-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_PREFERENCES: preferences,
    ORCA_E2E_MODEL: resolve(__dirname, '../../../packages/slicer-wasm/fixtures/cube.stl') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow(); await ready(page); await selectPrinter(page);
    const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
    await page.getByTestId('btn-add-model').click();
    await expect.poll(async () => (await booleanMeshes(page)).length, { timeout: 60_000 }).toBe(1);
    await page.getByTestId('config-mode-scoped').click();
    const objects = page.getByTestId('object-list').locator('div[data-testid^="object-"]');
    await objects.first().getByRole('button').first().click();
    const before = await booleanMeshes(page), beforeHistory = await history(page);
    const bounds = before[0].bounds;
    const center = bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2);
    await page.evaluate(c => (window as any).__orcaE2e.setCameraView([c[0], c[1], 300], [c[0], c[1], 0]), center);
    await page.getByTestId('gizmo-btn-measure').click();
    const panel = page.getByTestId('measure-panel'); await expect(panel).toBeVisible();
    await expect(panel.getByRole('status')).toHaveCount(0, { timeout: 60_000 });
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const clickWorld = async (point: number[]) => {
      const projected = await page.evaluate(p => (window as any).__orcaE2e.projectWorldToScreen(p), point);
      const box = await canvas.boundingBox();
      if (!box || !projected) throw new Error('model point is not visible');
      await page.mouse.move(box.x + projected.x, box.y + projected.y);
      await page.mouse.click(box.x + projected.x, box.y + projected.y);
    };
    await clickWorld([center[0], center[1], bounds.max[2]]);
    await expect(page.getByTestId('measure-first')).toContainText('Plane', { timeout: 30_000 });
    await clickWorld([bounds.min[0], center[1], bounds.max[2]]);
    await expect(page.getByTestId('measure-second')).toContainText('Midpoint of edge', { timeout: 30_000 });
    await clickWorld([bounds.min[0], bounds.min[1] + (bounds.max[1] - bounds.min[1]) * 0.25, bounds.max[2]]);
    await expect(page.getByTestId('measure-second')).toContainText('Edge', { timeout: 30_000 });
    expect(await booleanMeshes(page)).toEqual(before);
    expect((await history(page)).undoEntries).toEqual(beforeHistory.undoEntries);
    await page.screenshot({ path: info.outputPath('measure-features.png') });
    for (const tab of ['home', 'device']) {
      await page.locator(`#app-tab-${tab}`).click(); await page.locator('#app-tab-prepare').click();
      await expect(page.getByTestId('measure-second')).toContainText('Edge');
    }
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('measure-first')).toContainText('None');
    await expect(page.getByTestId('measure-second')).toContainText('None');
    expect(await booleanMeshes(page)).toEqual(before);
    await page.keyboard.press('Escape'); await expect(panel).toBeHidden();
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
