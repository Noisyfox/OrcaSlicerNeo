import { expect, test } from './browser-fixture';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ready, selectPrinter } from '../../desktop/e2e/arrangement-journey';
import { assemblyJourney } from '../../desktop/e2e/assembly-journey';

test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires freshly built and staged real WASM');
test.setTimeout(240_000);
test('real Web Assemble preserves unselected instances through the browser Worker', async ({ page, context }) => {
  const variant = process.env.ORCA_WEB_NO_ISOLATION === '1' ? 'serial' : 'threaded';
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
  const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
  await page.goto('/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(variant === 'threaded');
  await ready(page); await selectPrinter(page);
  await assemblyJourney(page, async () => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('btn-add-model').click();
    await (await chooser).setFiles(resolve(import.meta.dirname, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  });
  const expected = await readFile(resolve(import.meta.dirname, `../../../packages/slicer-wasm/out/${variant}/orca_slice.wasm`));
  expect(servedHash).toBe(createHash('sha256').update(expected).digest('hex'));
  expect([...requests].sort()).toEqual(['data', 'js', 'wasm'].map(extension => `/wasm/${variant}/orca_slice.${extension}`).sort());
  if (variant === 'serial') await expect(page.getByTestId('serial-fallback-status')).toBeVisible();
  expect(errors).toEqual([]);
});
