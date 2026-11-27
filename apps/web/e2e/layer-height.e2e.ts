import { expect, test } from './browser-fixture';
import { verifyLayerHeight } from '../../desktop/e2e/layer-height-journey';

test('applies variable layer heights in the Web Worker', async ({ page }, info) => {
  test.setTimeout(240_000);
  const modules = new Set<string>();
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/orca_slice.wasm')) modules.add(path);
  });
  await page.goto('/');
  await verifyLayerHeight(page);
  const [threading, architecture] = (info.config.metadata.runtime as string).split('-');
  expect([...modules]).toEqual([`/wasm/${architecture === 'wasm32' ? 'wasm32/' : ''}${threading}/orca_slice.wasm`]);
});
