import { expect, type Page } from '@playwright/test';

/** Select the standard numeric-nozzle profiles used by existing E2E fixtures.
 * This is fixture syntax only; application matching remains native-owned. */
export async function selectFixturePrinter(page: Page, canonicalName: string) {
  const fixture = canonicalName.match(/^(.+) ([0-9.]+) nozzle$/);
  if (!fixture) throw new Error(`Unsupported Printer test fixture: ${canonicalName}`);
  const [, model, variant] = fixture;
  const printer = page.getByTestId('preset-select');
  await printer.click();
  const popup = page.locator('[data-slot="combobox-content"]');
  await popup.getByPlaceholder('Search presets…').fill(model);
  await popup.getByRole('option', { name: model, exact: true }).click();
  await expect(printer).toBeEnabled();
  await expect(printer).toContainText(model);
  const nozzle = page.getByTestId('nozzle-variant-select');
  if ((await nozzle.locator('[data-slot="select-value"]').innerText()).trim() !== variant) {
    await nozzle.click();
    await page.getByRole('option', { name: variant, exact: true }).click();
  }
  await expect(nozzle).toBeEnabled();
  await expect(nozzle.locator('[data-slot="select-value"]')).toHaveText(variant);
}
