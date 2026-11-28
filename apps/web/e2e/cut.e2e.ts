import { test } from './browser-fixture';
import { cutDraftJourney } from '../../desktop/e2e/cut-journey';
test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires built Cut WASM');
test.setTimeout(300_000);
test('Cut draft in Prepare', async ({ page }) => {
  await page.goto('/');
  await cutDraftJourney(page);
});
