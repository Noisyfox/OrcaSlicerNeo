import { test, expect } from './browser-fixture';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { selectFixturePrinter } from '../../desktop/e2e/printer-selection';

test('wasm32 fallback downloads only its selected variant and slices locally', async ({ page, context, browserName }, info) => {
  test.skip(browserName !== 'webkit', 'run with playwright.wasm32.config.ts and a WebKit build without Memory64');
  const variant = process.env.ORCA_WEB_NO_ISOLATION === '1' ? 'serial' : 'threaded';
  const requested = new Set<string>();
  const states: boolean[] = [];
  await page.addInitScript(() => {
    (window as any).__fallbackRuntimeStates = [];
    const post = Worker.prototype.postMessage;
    const seen = new WeakSet<Worker>();
    Worker.prototype.postMessage = function (...args: any[]) {
      if (!seen.has(this)) {
        seen.add(this);
        this.addEventListener('message', event => {
          if (event.data?.type === 'runtime-state') (window as any).__fallbackRuntimeStates.push(event.data.threaded);
        });
      }
      return Reflect.apply(post, this, args as any);
    };
  });
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/\/wasm\/.*orca_slice\.(js|wasm|data)$/.test(path)) requested.add(path);
  });
  let servedHash: string | undefined;
  await context.route('**/orca_slice.wasm', async route => {
    const response = await route.fetch(), bytes = await response.body();
    servedHash = createHash('sha256').update(bytes).digest('hex');
    await route.fulfill({ response, body: bytes });
  });
  await page.goto('/');
  expect(await page.evaluate(() => WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1])))).toBe(false);
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  const expected = await readFile(new URL(`../../../packages/slicer-wasm/out/wasm32/${variant}/orca_slice.wasm`, import.meta.url));
  expect(servedHash).toBe(createHash('sha256').update(expected).digest('hex'));
  await page.locator('#app-tab-prepare').click();
  await selectFixturePrinter(page, 'Creality Ender-3 0.4 nozzle');
  const chooser = page.waitForEvent('filechooser'); await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(fileURLToPath(new URL('../../../packages/slicer-wasm/fixtures/cube.stl', import.meta.url)));
  await expect(page.getByTestId('btn-slice')).toBeEnabled(); await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
  const downloading = page.waitForEvent('download'); await page.getByTestId('btn-export').click();
  const download = await downloading;
  expect((await readFile((await download.path())!, 'utf8'))).toContain('G1');
  states.push(...await page.evaluate(() => (window as any).__fallbackRuntimeStates));
  expect(states).toContain(variant === 'threaded');
  expect([...requested].sort()).toEqual(['data', 'js', 'wasm'].map(ext => `/wasm/wasm32/${variant}/orca_slice.${ext}`).sort());
  await info.attach('selected-wasm-downloads', { body: JSON.stringify({ variant, requested: [...requested], servedHash, states }), contentType: 'application/json' });
});
