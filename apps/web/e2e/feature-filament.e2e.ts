import { test } from './browser-fixture';
import { verifyFeatureFilamentRouting } from '../../desktop/e2e/feature-filament-flow';

test('edits feature filament routes with the real Web Worker', async ({ page }) => {
  await page.goto('/');
  await verifyFeatureFilamentRouting(page);
});
