import { expect, test } from './browser-fixture';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { booleanMeshes } from '../../desktop/e2e/mesh-boolean-journey';
import { ready, selectPrinter, history } from '../../desktop/e2e/arrangement-journey';
import { meshBooleanSphereFixture } from '../../../packages/slicer-wasm/harness/mesh-boolean-fixtures.mjs';
import { meshBooleanJourney } from '../../desktop/e2e/mesh-boolean-journey';

test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires freshly staged real WASM; run scripts/run-mesh-boolean-e2e.mjs');
test.setTimeout(480_000);
test('real Web Mesh Boolean interaction, history, modal admission and instances', async ({ page, context, browserName }, info) => {
  const variant = process.env.ORCA_WEB_NO_ISOLATION === '1' ? 'serial' : 'threaded';
  const width = browserName === 'webkit' ? 'wasm32/' : '';
  const requests = new Set<string>();
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/\/wasm\/.*orca_slice\.(?:js|wasm|data)$/.test(path)) requests.add(path);
  });
  let servedHash: string | undefined;
  await context.route('**/orca_slice.wasm', async route => {
    const response = await route.fetch(), bytes = await response.body();
    servedHash = createHash('sha256').update(bytes).digest('hex');
    await route.fulfill({ response, body: bytes });
  });
  await page.goto('/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(variant === 'threaded');
  const memory64 = await page.evaluate(() => WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,5,3,1,4,1])));
  expect(memory64, 'qualify the selected width with actual engine capability').toBe(width === '');
  await meshBooleanJourney(page, async () => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('btn-add-model').click();
    await (await chooser).setFiles(resolve(import.meta.dirname, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  }, info);
  const expected = await readFile(resolve(import.meta.dirname, `../../../packages/slicer-wasm/out/${width}${variant}/orca_slice.wasm`));
  expect(servedHash).toBe(createHash('sha256').update(expected).digest('hex'));
  expect([...requests].sort()).toEqual(['data','js','wasm'].map(extension => `/wasm/${width}${variant}/orca_slice.${extension}`).sort());
  if (variant === 'serial') await expect(page.getByTestId('serial-fallback-status')).toBeVisible();
  else await expect(page.getByTestId('serial-fallback-status')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('orca-slicer-neo:preferences')!).meshBooleanKeepPainting)).toBe(true);
});


// A separate opt-in gate crosses the 4 GiB linear-memory boundary through the
// actual browser Worker, renderer geometry publication and modal lifetime.
test('large wasm64 browser Boolean publishes after growing beyond 4 GiB', async ({ page, browserName }, info) => {
  test.skip(process.env.ORCA_MESH_BOOLEAN_LARGE !== '1' || browserName !== 'chromium' || process.env.ORCA_WEB_NO_ISOLATION === '1',
    'explicit large threaded wasm64 gate; set ORCA_MESH_BOOLEAN_LARGE=1');
  const input = meshBooleanSphereFixture(7);
  await page.goto('/'); await ready(page); await selectPrinter(page);
  for (let count = 1; count <= 2; count++) {
    const choosing = page.waitForEvent('filechooser'); await page.getByTestId('btn-add-model').click();
    await (await choosing).setFiles({ name: 'Boolean sphere.stl', mimeType: 'model/stl', buffer: Buffer.from(input.bytes) });
    await expect.poll(async () => (await booleanMeshes(page)).length, { timeout: 60_000 }).toBe(count);
  }
  await page.getByTestId('config-mode-scoped').click();
  const list = page.getByTestId('object-list'), objects = list.locator('div[data-testid^="object-"]');
  await objects.nth(0).getByRole('button').first().click();
  await objects.nth(1).getByRole('button').first().click({ modifiers: ['ControlOrMeta'] });
  await objects.nth(1).getByRole('button').first().click({ button: 'right' });
  await page.getByTestId('objectlist-assemble').click(); await expect(objects).toHaveCount(1);
  const parts = list.locator('div[data-testid^="part-"]');
  if (await parts.count() === 0) await list.locator('[data-testid^="object-expand-"]').click();
  await parts.nth(1).getByRole('button').first().click(); await page.getByTestId('gizmo-btn-move').click();
  for (const [axis,delta] of [['x',15],['y',10],['z',5]] as const) {
    const before = (await history(page)).undoEntries.length, input = page.getByTestId(`move-${axis}`);
    await input.fill(String(Number(await input.inputValue())+delta)); await input.press('Enter');
    await expect.poll(async () => (await history(page)).undoEntries.length, { timeout: 60_000 }).toBe(before+1);
  }
  await objects.first().getByRole('button').first().click(); await page.getByTestId('gizmo-btn-mesh-boolean').click();
  await parts.nth(0).getByRole('button').first().click(); await parts.nth(1).getByRole('button').first().click();
  const before = (await history(page)).undoEntries.length, started = Date.now();
  await page.getByTestId('mesh-boolean-execute').click();
  await expect(page.getByTestId('mesh-boolean-wait')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByTestId('mesh-boolean-wait')).toBeVisible();
  await expect(page.getByTestId('mesh-boolean-wait')).toBeHidden({ timeout: 240_000 });
  const elapsedThroughPublicationMs = Date.now()-started, meshes = await booleanMeshes(page);
  expect(meshes).toHaveLength(1);
  const radius = 20, distance = Math.hypot(15,10,5);
  const ideal = 8*Math.PI*radius**3/3-Math.PI*(4*radius+distance)*(2*radius-distance)**2/12;
  expect(Math.abs(meshes[0].volume-ideal)/ideal).toBeLessThan(.001);
  expect((await history(page)).undoEntries.length).toBe(before+1);
  const memory = await page.evaluate(() => (window as any).__orcaE2e.runtimeMemoryForAcceptance());
  expect(memory.wasmLinearMemoryBytes).toBeGreaterThan(4*2**30);
  await expect(page.getByText('Error: mesh_boolean_busy', { exact: false })).toHaveCount(0);
  const report = JSON.stringify({
    inputTrianglesTotal: 2*input.triangles, output: meshes[0], elapsedThroughPublicationMs, memory,
  }, null, 2);
  await writeFile(info.outputPath('large-boolean.json'), report);
  await info.attach('large-boolean.json', { contentType: 'application/json', body: report });
  await page.screenshot({ path: info.outputPath('large-boolean-result.png') });
});
