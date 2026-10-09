import { expect, type Page } from '@playwright/test';
import { selectFixturePrinter } from './printer-selection';

export type Point = [number, number, number];
export const centers = (page: Page): Promise<Point[]> => page.evaluate(() =>
  (window as unknown as { __orcaE2e: { modelWorldCenters(): Point[] } }).__orcaE2e.modelWorldCenters());
export const history = (page: Page): Promise<{ undoEntries: Array<{ label: string }>; redoEntries: Array<{ label: string }> }> => page.evaluate(() =>
  (window as unknown as { __orcaE2e: { historyNativeStatus(): any } }).__orcaE2e.historyNativeStatus());
export const camera = (page: Page): Promise<{ position: number[]; target: number[]; controlsEnabled: boolean }> => page.evaluate(() =>
  (window as unknown as { __orcaE2e: { cameraState(): any } }).__orcaE2e.cameraState());

export async function ready(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
  await page.locator('#app-tab-prepare').click();
}

export async function selectPrinter(page: Page, name = 'Creality Ender-3 0.4 nozzle') {
  await selectFixturePrinter(page, name);
}

export async function completed(page: Page) {
  await expect(page.getByTestId('arrangement-status')).toContainText(/arranged|complete|finished/i, { timeout: 120_000 });
  await expect(page.getByTestId('history-undo')).toBeEnabled();
  await expect(page.locator('[data-slot="popover-content"]')).toBeHidden();
}

export function expectSameCenters(actual: Point[], expected: Point[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, index) => point.forEach((value, axis) => expect(value).toBeCloseTo(expected[index][axis], 5)));
}

export async function assertCubePacking(page: Page, before: Point[]) {
  await expect.poll(() => centers(page)).not.toEqual(before);
  const after = await centers(page);
  expect(after).toHaveLength(before.length);
  const beds = await page.evaluate(() => (window as unknown as { __orcaE2e: {
    bedPlateStates(): Array<{ outOfBounds: boolean; bounds: { minX: number; maxX: number; minY: number; maxY: number } }>;
  } }).__orcaE2e.bedPlateStates().filter(bed => !bed.outOfBounds));
  for (const point of after) {
    expect(point[2]).toBeCloseTo(10, 4);
    expect(beds.some(({ bounds: b }) => point[0] - 10 >= b.minX - 0.01 && point[0] + 10 <= b.maxX + 0.01 &&
      point[1] - 10 >= b.minY - 0.01 && point[1] + 10 <= b.maxY + 0.01), '20 mm cube stays inside a real bed').toBe(true);
  }
  for (let i = 0; i < after.length; i++) for (let j = i + 1; j < after.length; j++) {
    expect(Math.abs(after[i][0] - after[j][0]) >= 19.99 || Math.abs(after[i][1] - after[j][1]) >= 19.99,
      `axis-aligned cube footprints ${i} and ${j} do not overlap`).toBe(true);
  }
  return after;
}
