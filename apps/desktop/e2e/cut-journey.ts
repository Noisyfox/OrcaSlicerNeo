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
  await expect(panel.getByRole('combobox', { name: /^Side / })).toHaveCount(0);
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

export async function cutProjectJourney(page: Page, roundtrip: () => Promise<void>) {
  const { objects, panel } = await openCutCube(page);
  const initial = (await history(page)).undoEntries.length;
  const height = panel.getByRole('spinbutton', { name: 'Cut position Z' });
  await height.fill('8'); await height.press('Enter');
  await panel.getByRole('button', { name: 'Perform cut' }).click();
  await expect(panel).toBeHidden({ timeout: 60_000 });
  await expect(objects).toHaveCount(2);
  await expect.poll(async () => (await history(page)).undoEntries.length).toBe(initial+1);
  await page.getByTestId('history-undo').click(); await expect(objects).toHaveCount(1);
  await page.getByTestId('history-redo').click(); await expect(objects).toHaveCount(2);
  // Place both cut faces on the bed with enough clearance for independent toolpaths.
  await page.getByTestId('arrange-menu').click(); await page.getByTestId('arrange-all').click();
  await expect.poll(async () => (await history(page)).undoEntries.length, { timeout: 60_000 }).toBe(initial+2);
  const before = await centers(page);
  await roundtrip();
  await expect.poll(async () => (await centers(page)).length, { timeout: 60_000 }).toBe(2);
  const after = await centers(page);
  for (let i = 0; i < before.length; i++) {
    after[i].forEach((value, axis) => expect(value).toBeCloseTo(before[i][axis], 4));
  }
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 180_000 });
}

export async function cutGrooveJourney(page: Page) {
  const { panel, objects } = await openCutCube(page);
  await panel.getByRole('combobox',{name:'Cut mode'}).selectOption('dovetail');
  const status=panel.getByTestId('cut-groove-status'), count=panel.getByRole('spinbutton',{name:'Groove count'});
  await expect(status).toHaveText('Mating surfaces ready',{timeout:60_000});
  await count.fill('100'); await expect(status).toHaveText('Editing groove'); await count.press('Enter');
  await expect(status).toContainText('outside',{timeout:30_000});
  await expect(panel.getByRole('button',{name:'Perform cut'})).toBeDisabled();
  await count.fill('2'); await count.press('Enter');
  await expect(status).toHaveText('Mating surfaces ready',{timeout:60_000});
  await panel.getByRole('button',{name:'Perform cut'}).click();
  await expect(objects).toHaveCount(2,{timeout:60_000});
}
