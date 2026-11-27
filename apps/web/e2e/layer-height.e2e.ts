import { test } from './browser-fixture';
import { verifyLayerHeight } from '../../desktop/e2e/layer-height-journey';
test('applies variable layer heights in the Web Worker', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await verifyLayerHeight(page);
});
