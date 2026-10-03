import playwright from '../../desktop/node_modules/@playwright/test/index.js';
const { test, expect } = playwright;
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeStoredZip } from '../../../packages/slicer-wasm/harness/native-3mf-parser.mjs';
import { assertCubePacking, camera, centers, completed, history, ready, selectPrinter } from '../../desktop/e2e/arrangement-journey';

test.skip(process.env.ORCA_E2E_REAL !== '1' || process.env.ORCA_WEB_NO_ISOLATION === '1',
  'requires freshly staged threaded WASM; run scripts/run-arrangement-e2e.mjs');
test.setTimeout(480_000);

function cylinderInstances() {
  // Real convex geometry and 192 overlapping instances keep the native solver
  // occupied long enough to exercise cancellation without pausing or mocking it.
  const sides = 24, vertices: string[] = [], triangles: string[] = [];
  for (const z of [0, 10]) for (let i = 0; i < sides; i++) {
    const angle = 2 * Math.PI * i / sides;
    vertices.push(`<vertex x="${8 * Math.cos(angle)}" y="${8 * Math.sin(angle)}" z="${z}"/>`);
  }
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    triangles.push(`<triangle v1="${i}" v2="${next}" v3="${next + sides}"/>`,
      `<triangle v1="${i}" v2="${next + sides}" v3="${i + sides}"/>`);
  }
  for (let i = 1; i < sides - 1; i++) triangles.push(
    `<triangle v1="0" v2="${i + 1}" v3="${i}"/>`,
    `<triangle v1="${sides}" v2="${sides + i}" v3="${sides + i + 1}"/>`);
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="Arrangement cylinders"><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object></resources><build>${Array.from({ length: 192 }, () => '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 110 110 0"/>').join('')}</build></model>`;
  const path = join(mkdtempSync(join(tmpdir(), 'orca-arrangement-web-')), 'arrangement-cylinders.3mf');
  writeFileSync(path, writeStoredZip([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>' },
    { name: '_rels/.rels', content: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: '3D/3dmodel.model', content: model },
  ]));
  return path;
}

test('real threaded Web arrangement, editing guards, camera and cancellation', async ({ page }) => {
  const workerErrors: string[] = [];
  page.on('pageerror', error => workerErrors.push(String(error)));
  await page.goto('/'); await ready(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.getByTestId('serial-fallback-status')).toHaveCount(0);
  await selectPrinter(page);
  const cube = resolve(import.meta.dirname, '../../../packages/slicer-wasm/fixtures/cube.stl');
  for (let count = 1; count <= 4; count++) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('btn-add-model').click(); await (await chooser).setFiles(cube);
    await expect.poll(async () => (await centers(page)).length, { timeout: 30_000 }).toBe(count);
  }
  await page.getByTestId('arrange-menu').click();
  await page.getByTestId('arrange-reset').click();
  if (await page.getByTestId('arrange-align-y').isChecked()) await page.getByTestId('arrange-align-y').click();
  const cubesBefore = await centers(page);
  await page.getByTestId('arrange-all').click(); await completed(page);
  await assertCubePacking(page, cubesBefore);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click(); await (await chooser).setFiles(cylinderInstances());
  // Add Model imports this standard geometry-only 3MF through the real browser
  // file picker. No project configuration or synthetic runtime calls are used.
  await expect.poll(async () => (await centers(page)).length, { timeout: 60_000 }).toBe(196);
  const before = await centers(page), beforeHistory = await history(page), cameraBefore = await camera(page);
  await page.getByTestId('arrange-menu').click();
  await page.getByTestId('arrange-rotate').check();
  await page.getByTestId('arrange-all').click();
  await expect(page.getByTestId('arrange-cancel')).toBeVisible();
  // Observe the busy boundary and every editing control in one browser turn:
  // the real solver can finish between separate cross-process assertions.
  const editingControls = ['btn-add-model', 'btn-slice', 'add-plate', 'preset-select', 'history-undo', 'history-redo', 'arrange-menu'];
  await expect.poll(() => page.evaluate(ids => ({
    active: (document.querySelector('[data-testid="arrangement-edit-boundary"]') as HTMLFieldSetElement).disabled,
    disabled: Object.fromEntries(ids.map(id => [id,
      document.querySelector(`[data-testid="${id}"]`)?.matches(':disabled') ?? false])),
  }), editingControls), { message: 'every editing control is blocked in the same active arrangement' }).toEqual({
    active: true,
    disabled: Object.fromEntries(editingControls.map(id => [id, true])),
  });
  // The global history shortcut must obey the same gate as its disabled button.
  await page.keyboard.press('Control+z');
  expect(await centers(page), 'the renderer never publishes intermediate packing').toEqual(before);
  expect((await camera(page)).controlsEnabled).toBe(true);
  const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
  const box = await canvas.boundingBox();
  expect(box!.width).toBeGreaterThan(300); expect(box!.height).toBeGreaterThan(300);
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5);
  await page.mouse.wheel(0, -300);
  // Cancel immediately after the real gesture; camera polling and screenshots
  // must not spend the remaining lifetime of the native computation.
  await page.getByTestId('arrange-cancel').click({ timeout: 5_000 });
  await expect.poll(async () => (await camera(page)).position).not.toEqual(cameraBefore.position);
  await expect(page.getByTestId('arrangement-status')).toContainText(/cancel/i, { timeout: 30_000 });
  await expect(page.getByTestId('arrangement-edit-boundary')).toHaveJSProperty('disabled', false);
  await expect(page.getByTestId('btn-add-model')).toBeEnabled();
  expect(await centers(page), 'cancellation preserves every original transform').toEqual(before);
  expect((await history(page)).undoEntries).toEqual(beforeHistory.undoEntries);
  expect((await history(page)).redoEntries).toEqual(beforeHistory.redoEntries);
  expect(workerErrors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('threaded-arrangement-cancelled.png') });
});
