import { selectFixturePrinter } from '../../desktop/e2e/printer-selection';
import playwright from '../../desktop/node_modules/@playwright/test/index.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { test, expect } = playwright;
const here = dirname(fileURLToPath(import.meta.url));
const artifacts = resolve(here, '../../../packages/slicer-wasm/out/threaded');

test('unchanged shared threaded artifacts keep browser temporary files in MEMFS', async ({ page, context }) => {
  test.skip(process.env.ORCA_WEB_NO_ISOLATION === '1', 'requires threaded browser isolation');
  // Web production already sanitizes Node branches in the generated loader.
  // Serve the exact build outputs here to prove NODEFS needs no Web-specific
  // compilation or loader rewrite. Normal Web flows separately test packaging.
  const served = new Set<string>();
  const hashes: Record<string, string> = {};
  await context.route('**/wasm/threaded/*', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (!['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data'].includes(name)) return route.continue();
    const body = await readFile(resolve(artifacts, name));
    hashes[name] = createHash('sha256').update(body).digest('hex');
    served.add(name);
    await route.fulfill({ body, contentType: name.endsWith('.js') ? 'text/javascript'
      : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await expect(page.getByTestId('serial-fallback-status')).toHaveCount(0);
  await page.locator('#app-tab-prepare').click();
  const printer = 'Creality Ender-3 0.4 nozzle';
  await selectFixturePrinter(page, printer);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { gpuStreamingStatus?(): string };
  }).__orcaE2e?.gpuStreamingStatus?.())).toBe('ready');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('btn-export').click();
  const output = await downloadPromise;
  const bytes = await readFile((await output.path())!);
  expect(bytes.toString('utf8')).toContain('G1');

  await page.getByTestId('titlebar-menu-trigger').click();
  await page.getByTestId('menu-help-trigger').hover();
  await page.getByTestId('help-file-manager').click();
  const manager = page.getByTestId('file-manager-window');
  await manager.locator('[data-entry-name="tmp"][data-entry-type="directory"]').dblclick();
  await expect(page.getByTestId('file-manager-path')).toHaveText('/tmp');
  const result = manager.locator('[data-entry-name^="plate-result-"][data-entry-name$=".gcode"]');
  await expect(result).toHaveCount(1);
  const tempDownload = page.waitForEvent('download');
  await result.dblclick();
  expect(await readFile((await (await tempDownload).path())!)).toEqual(bytes);
  expect([...served].sort()).toEqual(['orca_slice.data', 'orca_slice.js', 'orca_slice.wasm']);
  expect(errors).toEqual([]);
  console.log('[nodefs-web-shared-artifacts]', JSON.stringify({ hashes, gcodeBytes: bytes.length }));
});
