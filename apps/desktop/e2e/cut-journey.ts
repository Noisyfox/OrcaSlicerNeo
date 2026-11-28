import { expect, type Page } from '@playwright/test';
import { centers, history, ready, selectPrinter } from './arrangement-journey';

export async function openCutCube(page: Page) {
  await ready(page);
  await selectPrinter(page, 'Bambu Lab P1P 0.4 nozzle');
  const viewport = page.getByTestId('viewport');
  const canvas = await viewport.locator('canvas[data-engine^="three.js"]').boundingBox();
  if (!canvas) throw new Error('missing viewport');
  await page.mouse.click(canvas.x + canvas.width - 40, canvas.y + 80, { button: 'right' });
  await page.getByTestId('btn-add-primitive').click();
  await page.getByTestId('btn-add-cube').click();
  await page.getByTestId('config-mode-scoped').click();
  const objects = page.getByTestId('object-list').locator('section[data-testid^="plate-group-"] > div[data-testid^="object-"]');
  await objects.first().getByRole('button').first().click();
  await viewport.focus();
  await page.keyboard.press('c');
  const panel = page.getByTestId('cut-panel');
  await expect(panel).toBeVisible();
  return { objects, viewport, panel };
}

export async function cutDraftJourney(page: Page) {
  const { viewport, panel } = await openCutCube(page);
  const count = (await history(page)).undoEntries.length;
  const height = panel.getByRole('spinbutton', { name: 'Cut position Z' });
  const initial = Number(await height.inputValue());
  await height.fill('8'); await height.press('Enter');
  await viewport.focus(); await page.keyboard.press('ArrowUp');
  await expect(height).toHaveValue('9');
  await page.getByTestId('history-undo').click(); await expect(height).toHaveValue('8');
  await page.getByTestId('history-redo').click(); await expect(height).toHaveValue('9');
  await panel.getByRole('combobox', { name: 'Side A' }).selectOption('discard');
  await panel.getByRole('checkbox', { name: 'Cut to parts' }).check();
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  await page.getByTestId('gizmo-btn-move').click(); await page.getByTestId('gizmo-btn-cut').click();
  await expect(height).toHaveValue('9');
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByTestId('history-undo')).toBeDisabled();
  await panel.getByRole('button', { name: 'Reset plane' }).click();
  await expect(height).toHaveValue(String(initial));
  const [center] = await centers(page);
  await page.evaluate(c => (window as any).__orcaE2e.setCameraView([c[0], c[1], 300], [c[0], c[1], 0]), center);
  const point = await page.evaluate(c => (window as any).__orcaE2e.projectWorldToScreen(c), center);
  const rect = await viewport.locator('canvas[data-engine^="three.js"]').boundingBox();
  const corner = await page.evaluate(() => {
    const probe = (window as any).__orcaE2e;
    const { max } = probe.selectionBoundsWorld();
    return { ...probe.projectWorldToScreen(max), z: max[2] };
  });
  await page.mouse.click(rect!.x + corner.x, rect!.y + corner.y);
  await expect(height).toHaveValue(String(Number(corner.z.toFixed(4))));
  await page.getByTestId('history-undo').click();
  await expect(height).toHaveValue(String(initial));
  await page.keyboard.down('Shift');
  await page.mouse.move(rect!.x + point.x - 32, rect!.y + point.y);
  await page.mouse.down(); await page.mouse.move(rect!.x + point.x + 32, rect!.y + point.y, { steps: 8 });
  await page.mouse.up(); await page.keyboard.up('Shift');
  await viewport.focus(); await page.keyboard.press('ArrowUp');
  // A line drawn in the top view defines a vertical plane. The normal step
  // moves that plane horizontally while the center Z field stays fixed.
  await expect(height).toHaveValue(String(initial));
  await panel.getByRole('button', { name: 'Flip plane' }).click();
  expect((await history(page)).undoEntries.length).toBe(count);
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByTestId('gizmo-btn-cut').click();
  await expect(height).toHaveValue(String(initial));
}
