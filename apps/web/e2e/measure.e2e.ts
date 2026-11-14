import { expect, test } from './browser-fixture';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { booleanMeshes } from '../../desktop/e2e/mesh-boolean-journey';
import { ready, selectPrinter } from '../../desktop/e2e/arrangement-journey';

test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires freshly staged real WASM; run scripts/run-measure-e2e.mjs');
test.setTimeout(480_000);

test('real Web Measure selects the runtime and copies its result', async ({ page, context, browserName }) => {
  const variant = process.env.ORCA_WEB_NO_ISOLATION === '1' ? 'serial' : 'threaded';
  const width = browserName === 'webkit' ? 'wasm32/' : '';
  const requests = new Set<string>();
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/\/wasm\/.*orca_slice\.(?:js|wasm|data)$/.test(path)) requests.add(path);
  });
  const errors: string[] = [];
  page.on('pageerror', error => {
    // WebKit reports deferred ResizeObserver notifications as a page error
    // during normal layout; retain every other error for the acceptance gate.
    if (browserName === 'webkit' && error.message === 'ResizeObserver loop completed with undelivered notifications.') return;
    errors.push(String(error));
  });
  let servedHash: string | undefined;
  await context.route('**/orca_slice.wasm', async route => {
    const response = await route.fetch(), bytes = await response.body();
    servedHash = createHash('sha256').update(bytes).digest('hex');
    await route.fulfill({ response, body: bytes });
  });
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(variant === 'threaded');
  const memory64 = await page.evaluate(() => WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1])));
  expect(memory64).toBe(width === '');
  await ready(page); await selectPrinter(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(import.meta.dirname, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect.poll(async () => (await booleanMeshes(page)).length, { timeout: 60_000 }).toBe(1);
  await page.getByTestId('config-mode-scoped').click();
  await page.getByTestId('object-list').locator('div[data-testid^="object-"]').first().getByRole('button').first().click();
  const bounds = (await booleanMeshes(page))[0].bounds;
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
    await page.mouse.click(box.x + projected.x, box.y + projected.y);
  };
  await page.keyboard.down('Shift');
  await clickWorld([center[0] - 4, center[1] - 4, bounds.max[2]]);
  await expect(page.getByTestId('measure-first')).toContainText('Point on plane');
  await clickWorld([center[0] + 4, center[1] + 4, bounds.max[2]]);
  await page.keyboard.up('Shift');
  await expect(page.getByTestId('measure-second')).toContainText('Point on plane');
  const dimension = await page.getByTestId('measure-dimension').innerText();
  // Playwright's native pointer coordinates are quantized differently by each
  // browser. Bound the world-space error by one screen pixel on each axis for
  // the two clicks, plus the displayed value's rounding.
  const pixels = await page.evaluate(([x, y, z]) => {
    const project = (window as any).__orcaE2e.projectWorldToScreen;
    const origin = project([x, y, z]), alongX = project([x + 1, y, z]), alongY = project([x, y + 1, z]);
    return [Math.hypot(alongX.x - origin.x, alongX.y - origin.y),
      Math.hypot(alongY.x - origin.x, alongY.y - origin.y)];
  }, [center[0], center[1], bounds.max[2]]);
  expect(pixels[0]).toBeGreaterThan(0); expect(pixels[1]).toBeGreaterThan(0);
  const pixelBound = Math.hypot(1 / pixels[0], 1 / pixels[1]) + .001;
  expect(Math.abs(Number.parseFloat(dimension) - Math.sqrt(128))).toBeLessThan(pixelBound);
  const row = panel.getByTestId('measure-result').filter({ hasText: dimension });
  await expect(row).toHaveCount(1);
  if (browserName === 'chromium') {
    const original = await page.evaluate(() => navigator.clipboard.readText());
    try {
      await row.getByRole('button', { name: /^Copy / }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe((await row.innerText()).trim());
    } finally { await page.evaluate(text => navigator.clipboard.writeText(text), original); }
  }
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(page.getByTestId('measure-second')).toContainText('None');
  const expected = await readFile(resolve(import.meta.dirname, `../../../packages/slicer-wasm/out/${width}${variant}/orca_slice.wasm`));
  expect(servedHash).toBe(createHash('sha256').update(expected).digest('hex'));
  expect([...requests].sort()).toEqual(['data', 'js', 'wasm'].map(extension => `/wasm/${width}${variant}/orca_slice.${extension}`).sort());
  if (variant === 'serial') await expect(page.getByTestId('serial-fallback-status')).toBeVisible();
  else await expect(page.getByTestId('serial-fallback-status')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('serial Web does not queue Measure while a slice is running', async ({ page }) => {
  test.skip(process.env.ORCA_WEB_NO_ISOLATION !== '1', 'serial runtime admission');
  await page.goto('/'); await ready(page); await selectPrinter(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(import.meta.dirname, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect.poll(async () => (await booleanMeshes(page)).length, { timeout: 60_000 }).toBe(1);
  await page.getByTestId('config-mode-scoped').click();
  await page.getByTestId('object-list').locator('div[data-testid^="object-"]').first().getByRole('button').first().click();
  await page.getByTestId('gizmo-btn-scale').click();
  const height = page.getByTestId('scale-size-z'); await height.fill('200'); await height.press('Enter');
  await expect.poll(async () => {
    const { min, max } = (await booleanMeshes(page))[0].bounds;
    return max[2] - min[2];
  }, { timeout: 60_000 }).toBeCloseTo(200, 1);
  await page.getByTestId('gizmo-btn-move').click(); await page.getByTestId('move-drop-bed').click();
  await expect.poll(async () => (await booleanMeshes(page))[0].bounds.min[2], { timeout: 60_000 }).toBeCloseTo(0, 1);
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Slicing…', { timeout: 60_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('gizmo-btn-measure')).toBeDisabled();
  await page.keyboard.press('u');
  await expect(page.getByTestId('measure-panel')).toBeHidden();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 300_000 });
  await expect(page.getByTestId('gizmo-btn-measure')).toBeEnabled();
  await expect(page.getByTestId('measure-panel')).toBeHidden();
  await page.getByTestId('gizmo-btn-measure').click();
  await expect(page.getByTestId('measure-panel')).toBeVisible();
});
