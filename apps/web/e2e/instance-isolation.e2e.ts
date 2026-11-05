import { expect, test } from './browser-fixture';
import { resolve } from 'node:path';
import { instanceIsolationJourney } from '../../desktop/e2e/instance-isolation-journey';

test.skip(process.env.ORCA_E2E_REAL !== '1', 'run scripts/run-painting-e2e.mjs with production WASM artifacts');
test.setTimeout(480_000);
test('real Web tools share instance isolation and restore source geometry and Prime Towers', async ({ page, browserName }, info) => {
  const serial = process.env.ORCA_WEB_NO_ISOLATION === '1', width = browserName === 'webkit' ? 'wasm32/' : '';
  const requests = new Set<string>();
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/\/wasm\/.*orca_slice\.(?:js|wasm|data)$/.test(path)) requests.add(path);
  });
  await page.goto('/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(!serial);
  expect(await page.evaluate(() => WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,5,3,1,4,1])))).toBe(width === '');
  await instanceIsolationJourney(page, async () => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('titlebar-menu-trigger').click(); await page.getByTestId('menu-file-trigger').hover();
    await page.getByTestId('file-open-project').click();
    await (await chooser).setFiles(resolve(import.meta.dirname, '../../../packages/slicer-wasm/fixtures/painted-facet/painted-facet-instances.3mf'));
  }, info);
  expect([...requests].sort()).toEqual(['data', 'js', 'wasm'].map(extension => `/wasm/${width}${serial ? 'serial' : 'threaded'}/orca_slice.${extension}`).sort());
});
