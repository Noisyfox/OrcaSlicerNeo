import { expect, type Page, type TestInfo } from '@playwright/test';
import { camera, history, ready, selectPrinter } from './arrangement-journey';

type Mesh = { objectId: number; volumeId: number; instanceId: number; volume: number; triangles: number;
  bounds: { min: number[]; max: number[] } };
export const booleanMeshes = (page: Page): Promise<Mesh[]> => page.evaluate(() =>
  (window as any).__orcaE2e.meshBooleanMeshes());
const state = (page: Page): Promise<any> => page.evaluate(() => (window as any).__orcaE2e.meshBooleanState());

/** Real UI inputs and native geometry; the probe only reads scene facts. */
export async function meshBooleanJourney(page: Page, addCube: () => Promise<void>, info: TestInfo) {
  await ready(page); await selectPrinter(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
  for (let count = 1; count <= 2; count++) {
    await addCube(); await expect.poll(async () => (await booleanMeshes(page)).length, { timeout: 30_000 }).toBe(count);
  }
  await page.getByTestId('config-mode-scoped').click();
  const list = page.getByTestId('object-list'), objects = list.locator('div[data-testid^="object-"]');
  await expect(objects).toHaveCount(2);
  await objects.nth(0).getByRole('button').first().click();
  await objects.nth(1).getByRole('button').first().click({ modifiers: ['ControlOrMeta'] });
  await objects.nth(1).getByRole('button').first().click({ button: 'right' });
  await page.getByTestId('objectlist-assemble').click();
  await expect(objects).toHaveCount(1);
  const parts = list.locator('div[data-testid^="part-"]');
  if (await parts.count() === 0) await list.locator('[data-testid^="object-expand-"]').click();
  await expect(parts).toHaveCount(2);
  await parts.nth(1).getByRole('button').first().click();
  await page.getByTestId('gizmo-btn-move').click();
  for (const [axis, delta] of [['x', 7.5], ['y', 5], ['z', 2.5]] as const) {
    const before = (await history(page)).undoEntries.length;
    const input = page.getByTestId(`move-${axis}`);
    await input.fill(String(Number(await input.inputValue()) + delta)); await input.press('Enter');
    await expect.poll(async () => (await history(page)).undoEntries.length, { timeout: 30_000 }).toBe(before + 1);
  }
  const original = await booleanMeshes(page);
  await page.evaluate(center => (window as any).__orcaE2e.setCameraView([center[0], center[1], 300], [center[0], center[1], 0]),
    original[0].bounds.min.map((value, axis) => (value + original[0].bounds.max[axis]) / 2));
  await objects.first().getByRole('button').first().click();
  await page.getByTestId('gizmo-btn-mesh-boolean').click();
  const panel = page.getByTestId('mesh-boolean-panel'); await expect(panel).toBeVisible();
  await expect(panel.getByLabel('Keep painting', { exact: true })).not.toBeChecked();
  await panel.getByLabel('Keep painting', { exact: true }).check();
  await panel.getByRole('button', { name: 'Difference', exact: true }).click();
  await expect(panel.getByLabel('Delete input B', { exact: true })).not.toBeChecked();
  const beforePicks = await history(page);
  // Pick the exposed corner of A with an actual viewport pointer; B is offset
  // positively along every axis, so it cannot occlude this corner from above.
  const point = await page.evaluate(p => (window as any).__orcaE2e.projectWorldToScreen(p),
    [original[0].bounds.min[0] + 1, original[0].bounds.min[1] + 1, original[0].bounds.max[2]]);
  const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]'), rect = await canvas.boundingBox();
  await page.mouse.click(rect!.x + point.x, rect!.y + point.y);
  await expect.poll(async () => (await state(page)).a).toBe(original[0].volumeId);
  await parts.nth(1).getByRole('button').first().click();
  await expect.poll(async () => (await state(page)).b).toBe(original[1].volumeId);
  for (const operation of ['Intersection', 'Union', 'Difference'])
    await panel.getByRole('button', { name: operation, exact: true }).click();
  expect((await history(page)).undoEntries).toEqual(beforePicks.undoEntries);
  await page.screenshot({ path: info.outputPath('mesh-boolean-operands.png') });
  const picked = await state(page);
  for (const tab of ['home', 'device']) {
    await page.locator(`#app-tab-${tab}`).click(); await page.locator('#app-tab-prepare').click();
    await expect(panel).toBeVisible(); expect(await state(page)).toEqual(picked);
  }
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.getByTestId('gizmo-btn-mesh-boolean').click();
  await expect(panel.getByLabel('Keep painting', { exact: true })).toBeChecked();
  expect(await state(page)).toMatchObject({ a: null, b: null, picking: 'a' });
  await panel.getByRole('button', { name: 'Difference', exact: true }).click();
  await parts.nth(0).getByRole('button').first().click(); await parts.nth(1).getByRole('button').first().click();
  expect((await history(page)).undoEntries).toEqual(beforePicks.undoEntries);
  // Observe the genuine operation without adding a sleep or a test hook to
  // hold the native calculation. Input attempts run in the modal's DOM turn.
  await page.evaluate(() => {
    const w = window as any;
    w.booleanModalObservation = null;
    const observer = new MutationObserver(() => {
      const popup = document.querySelector('[data-testid="mesh-boolean-wait"]');
      if (!popup || !w.__orcaE2e.meshBooleanState().publishing || w.booleanModalObservation) return;
      const before = JSON.stringify(w.__orcaE2e.cameraState());
      const picks = JSON.stringify(w.__orcaE2e.meshBooleanState());
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      (document.activeElement ?? document.body).dispatchEvent(escape);
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
      document.querySelector<HTMLButtonElement>('#app-tab-home')?.click();
      document.querySelector<HTMLButtonElement>('[data-testid="gizmo-btn-move"]')?.click();
      document.querySelector('[data-testid="viewport"] canvas')?.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
      w.booleanModalObservation = { escapeBlocked: escape.defaultPrevented, cancelButtons: popup.querySelectorAll('button').length,
        indeterminate: !popup.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow'),
        cameraUnchanged: before === JSON.stringify(w.__orcaE2e.cameraState()), picksUnchanged: picks === JSON.stringify(w.__orcaE2e.meshBooleanState()),
        prepareSelected: document.querySelector('#app-tab-prepare')?.getAttribute('aria-selected') === 'true' };
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
  await page.getByTestId('mesh-boolean-execute').click();
  await expect(page.getByTestId('mesh-boolean-wait')).toBeHidden({ timeout: 120_000 });
  await expect.poll(async () => (await booleanMeshes(page)).find(mesh => mesh.volumeId !== original[1].volumeId)?.volume,
    { timeout: 30_000 }).toBeCloseTo(4718.75, 0);
  expect(await page.evaluate(() => (window as any).booleanModalObservation)).toEqual({
    escapeBlocked: true, cancelButtons: 0, indeterminate: true, cameraUnchanged: true, picksUnchanged: true, prepareSelected: true,
  });
  await expect(panel).toBeVisible(); expect(await state(page)).toMatchObject({ a: null, b: null, picking: 'a' });
  await expect(page.getByTestId('mesh-boolean-execute')).toBeDisabled();
  expect((await history(page)).undoEntries.length).toBe(beforePicks.undoEntries.length + 1);
  await page.getByTestId('history-undo').click();
  await expect.poll(() => booleanMeshes(page)).toEqual(original);
  await page.getByTestId('history-redo').click();
  await expect.poll(async () => (await booleanMeshes(page)).find(mesh => mesh.volumeId !== original[1].volumeId)?.volume).toBeCloseTo(4718.75, 0);
  await page.getByTestId('history-undo').click(); await expect.poll(() => booleanMeshes(page)).toEqual(original);
  await objects.first().getByRole('button').first().click({ button: 'right' });
  await page.getByTestId('objectlist-add-instance').click();
  await expect.poll(async () => (await booleanMeshes(page)).length).toBe(4);
  const instances = [...new Set((await booleanMeshes(page)).map(mesh => mesh.instanceId))].sort();
  await objects.first().getByRole('button').first().click({ button: 'right' });
  await page.getByTestId('objectlist-mesh-boolean').click();
  await expect.poll(async () => (await booleanMeshes(page)).length, { timeout: 120_000 }).toBe(2);
  await expect(page.getByTestId('mesh-boolean-wait')).toBeHidden({ timeout: 120_000 });
  const combined = await booleanMeshes(page);
  expect([...new Set(combined.map(mesh => mesh.instanceId))].sort()).toEqual(instances);
  expect(new Set(combined.map(mesh => mesh.volumeId)).size).toBe(1);
  combined.forEach(mesh => expect(mesh.volume).toBeCloseTo(12718.75, 0));
  await expect(panel).toBeHidden();
  await expect(page.getByText('Error: mesh_boolean_busy', { exact: false })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('mesh-boolean-result.png') });
  // Preview starts a real slice and subsequent background result reads. Check
  // its tool-closing behavior after the Boolean success path; conflicting
  // native work deliberately rejects Boolean admission instead of queuing it.
  await page.getByTestId('history-undo').click();
  await expect.poll(async () => (await booleanMeshes(page)).length).toBe(4);
  // Restore the original single-instance object for the tool-entry check.
  await page.getByTestId('history-undo').click();
  await expect.poll(async () => (await booleanMeshes(page)).length).toBe(2);
  await objects.first().getByRole('button').first().click();
  const booleanTool = page.getByTestId('gizmo-btn-mesh-boolean');
  await expect(booleanTool).toBeEnabled(); await booleanTool.click();
  await expect(panel).toBeVisible();
  await page.locator('#app-tab-preview').click(); await page.locator('#app-tab-prepare').click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
  expect(errors).toEqual([]);
}
