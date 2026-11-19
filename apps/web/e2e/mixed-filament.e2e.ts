import { test } from './browser-fixture';
import { verifyMixedFilamentEditor } from '../../desktop/e2e/mixed-filament-flow';

test('creates, edits and deletes a mixed filament with the real Web Worker', async ({ page }) => {
  await page.goto('/');
  await verifyMixedFilamentEditor(page);
});
