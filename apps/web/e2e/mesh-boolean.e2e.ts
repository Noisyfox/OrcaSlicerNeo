import { expect, test } from './browser-fixture';
import { resolve } from 'node:path';
import { meshBooleanJourney } from '../../desktop/e2e/mesh-boolean-journey';

test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires freshly staged real WASM; run scripts/run-mesh-boolean-e2e.mjs');
test.setTimeout(480_000);
test('real Web Mesh Boolean interaction, history, modal admission and instances', async ({ page }, info) => {
  await page.goto('/');
  await meshBooleanJourney(page, async () => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('btn-add-model').click();
    await (await chooser).setFiles(resolve(import.meta.dirname, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  }, info);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orca-slicer-neo:preferences')!).meshBooleanKeepPainting)).toBe(true);
});
