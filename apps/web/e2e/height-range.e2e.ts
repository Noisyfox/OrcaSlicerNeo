import { test } from './browser-fixture';
import { verifyHeightRanges } from '../../desktop/e2e/height-range-journey';
test('edits and copies height ranges in the Web Worker', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await verifyHeightRanges(page);
});
