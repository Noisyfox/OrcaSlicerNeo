import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { _electron } from './electron-fixture';
import { addPrimitive } from './add-primitive';
import { ready } from './arrangement-journey';
import { openProjectMenu, waitForProjectLoad } from './project-menu';

test('restores painted surfaces on both instances after layer height editing', async () => {
  test.skip(process.env.ORCA_E2E_REAL !== '1', 'Requires the real 3MF importer');
  test.setTimeout(240_000);
  const fixture = resolve(__dirname, '../../../packages/slicer-wasm/fixtures/painted-facet/painted-facet-instances.3mf');
  const preferences = resolve(mkdtempSync(resolve(tmpdir(), 'orca-layer-height-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_MODEL: fixture, ORCA_E2E_PRIME_TOWER_PROJECT: fixture, ORCA_E2E_PREFERENCES: preferences };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await ready(page);
    await openProjectMenu(page, app);
    await waitForProjectLoad(page);
    await page.getByTestId('config-mode-scoped').click();
    const target = await page.getByTestId('object-list').getByTestId(/^object-\d+$/).first().getAttribute('data-testid');
    if (!target) throw new Error('Missing painted object');
    await addPrimitive(page, 'Cube');
    await page.getByTestId(target).getByRole('button').first().click();
    const read = () => page.evaluate(() => {
      const probe = (window as unknown as { __orcaE2e: {
        modelPaintResources(): { id: string; paintGeometryUuid: string; visibleGeometryUuid: string; originalGeometryUuid: string }[];
        modelMaterialColours(): { id: string; stateId: number; colour: string }[];
      } }).__orcaE2e;
      return {
        surfaces: probe.modelPaintResources().map(({ id, paintGeometryUuid, visibleGeometryUuid, originalGeometryUuid }) =>
          ({ id, paintGeometryUuid, visibleGeometryUuid, originalGeometryUuid })),
        colours: probe.modelMaterialColours().map(({ id, stateId, colour }) => ({ id, stateId, colour })),
      };
    });
    await expect.poll(async () => (await read()).colours.length, { timeout: 30_000 }).toBe(11);
    const before = await read();
    const painted = before.surfaces.filter(s => s.paintGeometryUuid);
    expect(painted).toHaveLength(2);
    expect(painted.every(s => s.visibleGeometryUuid === s.paintGeometryUuid)).toBe(true);
    const unrelated = before.surfaces.find(s => !s.paintGeometryUuid)!;
    await page.getByTestId('gizmo-btn-layer-height').click();
    await expect(page.getByTestId('layer-height-bar')).toBeVisible();
    await expect.poll(async () => (await read()).surfaces.filter(s => s.paintGeometryUuid && s.visibleGeometryUuid === s.originalGeometryUuid).length).toBe(2);
    expect((await read()).colours).toEqual(before.colours.filter(c => c.id === unrelated.id));
    const bar = page.getByTestId('layer-height-bar');
    const rect = await bar.boundingBox();
    if (!rect) throw new Error('Missing brush canvas');
    const reset = page.getByRole('region', { name: 'Variable layer height' }).getByRole('button', { name: 'Reset', exact: true });
    await expect(reset).toBeDisabled();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __orcaE2e: { layerHeightLiveLatency(): number | null };
    }).__orcaE2e.layerHeightLiveLatency()), { timeout: 30_000 }).toEqual(expect.any(Number));
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await expect(reset).toBeDisabled();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect.poll(read).toEqual(before);
  } finally { await app.close(); }
});
