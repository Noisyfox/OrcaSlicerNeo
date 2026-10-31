import { expect, type Page, type Locator } from '@playwright/test';

/** Export journeys explicitly choose their output instead of relying on the print default. */
export async function selectGcodeOutput(page: Page, mode: 'export' | 'send' | 'send-and-print', options?: { timeout?: number; noWaitAfter?: boolean }) {
  if (await page.getByTestId(`btn-${mode}`).isVisible()) return;
  await page.getByTestId('output-mode-select').click(options);
  const label = { export: 'Export', send: 'Send', 'send-and-print': 'Send & Print' }[mode];
  await page.getByRole('menuitemradio', { name: label, exact: true }).click(options);
  await expect(page.getByTestId(`btn-${mode}`)).toBeVisible({ timeout: options?.timeout });
}

/** Preserve current-plate identity assertions after the toolbar became a count. */
export async function expectCurrentPlate(page: Page, name: string, count: number, options?: { timeout?: number }) {
  const list = page.getByTestId('preview-plate-list');
  await expect(list.locator('[role="option"]')).toHaveCount(count, options);
  await expect(list.locator('[role="option"][aria-selected="true"]').getByText(name, { exact: true })).toHaveCount(1, options);
}

/** Plate actions live in Plates; return to the caller's configuration surface. */
export async function clickPlateControl(page: Page, testId: string, options?: Parameters<Locator['click']>[0]) {
  const mode = page.getByRole('tablist', { name: 'Configuration mode' });
  const previous = await mode.locator('[aria-selected="true"]').getAttribute('data-testid');
  await page.getByTestId('config-mode-plates').click();
  if (testId === 'delete-plate') await page.getByTestId('plate-menu').click();
  await page.getByTestId(testId).click(options);
  if (previous && previous !== 'config-mode-plates') await page.getByTestId(previous).click();
}
