import playwright from '../../desktop/node_modules/@playwright/test/index.js';
import { configuredFixtureActivation } from '../../desktop/e2e/electron-fixture';
export const configuredActivation = configuredFixtureActivation(true);
/** Normal Web suites begin from explicit configured preferences. */
export const test = playwright.test.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(profileActivation => {
      const key = 'orca-slicer-neo:preferences';
      const current = JSON.parse(localStorage.getItem(key) || '{"version":1,"selectedProfiles":{},"ui":{}}');
      if (!current.profileActivation) localStorage.setItem(key, JSON.stringify({ ...current, profileActivation }));
    }, configuredActivation);
    await use(page);
  },
});
export const expect = playwright.expect;
