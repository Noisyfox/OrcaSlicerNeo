import { _electron } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { history, ready, selectPrinter } from './arrangement-journey';
import { booleanMeshes } from './mesh-boolean-journey';

test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires the freshly staged threaded WASM');
test.setTimeout(480_000);

test('real Electron Measure selects native features and preserves scene/history ownership', async ({}, info) => {
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-measure-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_PREFERENCES: preferences,
    ORCA_E2E_MODEL: resolve(__dirname, '../../../packages/slicer-wasm/fixtures/cube.stl') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow(); await ready(page); await selectPrinter(page);
    const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
    await page.getByTestId('btn-add-model').click();
    await expect.poll(async () => (await booleanMeshes(page)).length, { timeout: 60_000 }).toBe(1);
    await page.getByTestId('config-mode-scoped').click();
    const objects = page.getByTestId('object-list').locator('div[data-testid^="object-"]');
    await objects.first().getByRole('button').first().click();
    const before = await booleanMeshes(page), beforeHistory = await history(page);
    const bounds = before[0].bounds;
    const center = bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2);
    await page.evaluate(c => (window as any).__orcaE2e.setCameraView([c[0], c[1], 300], [c[0], c[1], 0]), center);
    await page.getByTestId('gizmo-btn-measure').click();
    const panel = page.getByTestId('measure-panel'); await expect(panel).toBeVisible();
    await expect(panel.getByRole('status')).toHaveCount(0, { timeout: 60_000 });
    await objects.first().getByRole('button').first().click({ button: 'right' });
    await page.getByTestId('objectlist-delete').click();
    await expect(panel.getByRole('alert')).toContainText('Close Measure before changing its target');
    expect(await booleanMeshes(page)).toEqual(before);
    expect((await history(page)).undoEntries).toEqual(beforeHistory.undoEntries);
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const clickWorld = async (point: number[]) => {
      const projected = await page.evaluate(p => (window as any).__orcaE2e.projectWorldToScreen(p), point);
      const box = await canvas.boundingBox();
      if (!box || !projected) throw new Error('model point is not visible');
      await page.mouse.move(box.x + projected.x, box.y + projected.y);
      await page.mouse.click(box.x + projected.x, box.y + projected.y);
    };
    await clickWorld([center[0], center[1], bounds.max[2]]);
    await expect(page.getByTestId('measure-first')).toContainText('Plane', { timeout: 30_000 });
    await clickWorld([bounds.min[0], center[1], bounds.max[2]]);
    await expect(page.getByTestId('measure-second')).toContainText('Midpoint of edge', { timeout: 30_000 });
    await clickWorld([bounds.min[0], bounds.min[1] + (bounds.max[1] - bounds.min[1]) * 0.25, bounds.max[2]]);
    await expect(page.getByTestId('measure-second')).toContainText('Edge', { timeout: 30_000 });
    expect(await booleanMeshes(page)).toEqual(before);
    expect((await history(page)).undoEntries).toEqual(beforeHistory.undoEntries);
    await page.screenshot({ path: info.outputPath('measure-features.png') });
    for (const tab of ['home', 'device']) {
      await page.locator(`#app-tab-${tab}`).click(); await page.locator('#app-tab-prepare').click();
      await expect(page.getByTestId('measure-second')).toContainText('Edge');
    }
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('measure-first')).toContainText('None');
    await expect(page.getByTestId('measure-second')).toContainText('None');
    expect(await booleanMeshes(page)).toEqual(before);
    await clickWorld([bounds.min[0], center[1] - 5, bounds.max[2]]);
    await expect(page.getByTestId('measure-first')).toContainText('Edge');
    await clickWorld([center[0] + 5, bounds.min[1] + 0.1, bounds.max[2]]);
    await expect(page.getByTestId('measure-second')).toContainText('Edge');
    await expect(page.getByTestId('measure-angle-dimension')).toHaveText('90.000°');
    await page.screenshot({ path: info.outputPath('measure-angle.png') });
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('measure-first')).toContainText('None');
    await page.keyboard.down('Shift');
    await clickWorld([center[0] - 4, center[1] - 4, bounds.max[2]]);
    await expect(page.getByTestId('measure-first')).toContainText('Point on plane');
    await clickWorld([center[0] + 4, center[1] + 4, bounds.max[2]]);
    await page.keyboard.up('Shift');
    await expect(page.getByTestId('measure-second')).toContainText('Point on plane');
    const dimension = page.getByTestId('measure-dimension');
    await expect(dimension).toContainText('mm');
    const displayedDistance = await dimension.innerText();
    expect(Number.parseFloat(displayedDistance)).toBeCloseTo(Math.sqrt(128), 2);
    await expect(panel.getByTestId('measure-result').filter({ hasText: displayedDistance })).toContainText('distance');
    await page.screenshot({ path: info.outputPath('measure-distance.png') });
    await page.getByRole('button', { name: 'Copy Direct distance' }).hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]').filter({ hasText: 'Copy Direct distance' })).toBeVisible();
    const edit = page.getByTestId('measure-edit-scale');
    await edit.hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]').filter({ hasText: 'Edit to scale' })).toBeVisible();
    await edit.focus(); await edit.press('Enter');
    const scaleDialog = page.getByTestId('measure-scale-dialog');
    await expect(scaleDialog).toBeVisible();
    await expect(page.getByTestId('measure-scale-value')).toBeFocused();
    await expect.poll(() => scaleDialog.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    const dimensionBox = await dimension.boundingBox();
    if (!dimensionBox) throw new Error('measurement label is not visible');
    const dialogCoversDimension = await page.evaluate(({ x, y }) =>
      !!document.elementFromPoint(x, y)?.closest('[data-testid="measure-scale-dialog"]'),
    { x: dimensionBox.x + dimensionBox.width / 2, y: dimensionBox.y + dimensionBox.height / 2 });
    expect(dialogCoversDimension, 'the modal must appear above the 3D dimension').toBe(true);
    await page.screenshot({ path: info.outputPath('measure-scale-dialog.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('measure-scale-dialog')).toBeHidden();
    await expect(page.getByTestId('measure-second')).toContainText('Point on plane');
    await page.setViewportSize({ width: 1100, height: 480 });
    const options = page.getByTestId('gizmo-options');
    await expect.poll(() => options.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await panel.getByRole('button', { name: 'Done' }).scrollIntoViewIfNeeded();
    await expect(panel.getByRole('button', { name: 'Done' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('measure-short-window.png') });
    await edit.click(); await expect(scaleDialog).toBeVisible();
    await expect.poll(() => scaleDialog.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    const dialogBox = await scaleDialog.boundingBox();
    if (!dialogBox) throw new Error('scale dialog is not visible');
    expect(dialogBox.x).toBeGreaterThanOrEqual(0); expect(dialogBox.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(1100);
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(480);
    await page.keyboard.press('Escape'); await expect(scaleDialog).toBeHidden();
    await page.setViewportSize({ width: 1400, height: 900 });
    const openScale = async () => {
      await page.getByTestId('measure-edit-scale').click();
      await expect(page.getByTestId('measure-scale-dialog')).toBeVisible();
    };
    const scaleHistory = await history(page);
    await openScale(); await page.getByTestId('measure-scale-value').press('Enter');
    await expect(page.getByTestId('measure-scale-dialog')).toBeHidden();
    expect((await history(page)).undoEntries).toEqual(scaleHistory.undoEntries);
    for (const value of ['0', '-1']) {
      await openScale(); await page.getByTestId('measure-scale-value').fill(value);
      await page.getByTestId('measure-scale-value').press('Enter');
      await expect(page.getByTestId('measure-scale-dialog')).toBeHidden();
      expect((await history(page)).undoEntries).toEqual(scaleHistory.undoEntries);
    }
    await openScale(); await page.getByTestId('measure-scale-value').fill('300');
    await page.getByTestId('measure-scale-value').press('Backspace');
    await expect(page.getByTestId('measure-scale-value')).toHaveValue('30');
    await page.keyboard.press('Escape'); await expect(page.getByTestId('measure-scale-dialog')).toBeHidden();
    await expect(page.getByTestId('measure-second')).toContainText('Point on plane');
    expect((await history(page)).undoEntries).toEqual(scaleHistory.undoEntries);
    await openScale(); await page.getByTestId('measure-scale-value').fill('20');
    await page.getByTestId('measure-scale-value').press('Enter');
    await expect(page.getByTestId('measure-scale-dialog')).toBeHidden({ timeout: 60_000 });
    await expect(page.getByTestId('measure-dimension')).toHaveText('20.000 mm', { timeout: 60_000 });
    await expect(page.getByTestId('measure-first')).toContainText('Point on plane');
    await expect(page.getByTestId('measure-second')).toContainText('Point on plane');
    await expect.poll(async () => (await history(page)).undoEntries.length).toBe(scaleHistory.undoEntries.length + 1);
    await page.screenshot({ path: info.outputPath('measure-scaled.png') });
    const scaledSession = await panel.getAttribute('data-session-id');
    await page.getByTestId('history-undo').click();
    await expect.poll(async () => (await history(page)).undoEntries.length, { timeout: 60_000 }).toBe(scaleHistory.undoEntries.length);
    await expect.poll(() => panel.getAttribute('data-session-id'), { timeout: 60_000 }).not.toBe(scaledSession);
    await expect(panel).toHaveAttribute('data-phase', 'idle', { timeout: 60_000 });
    const undoneSession = await panel.getAttribute('data-session-id');
    await expect(page.getByTestId('measure-first')).toContainText('None', { timeout: 60_000 });
    await expect(page.getByTestId('measure-second')).toContainText('None');
    await page.getByTestId('history-redo').click();
    await expect.poll(async () => (await history(page)).undoEntries.length, { timeout: 60_000 }).toBe(scaleHistory.undoEntries.length + 1);
    await expect.poll(() => panel.getAttribute('data-session-id'), { timeout: 60_000 }).not.toBe(undoneSession);
    await expect(panel).toHaveAttribute('data-phase', 'idle', { timeout: 60_000 });
    await expect(page.getByTestId('measure-first')).toContainText('None', { timeout: 60_000 });
    await expect(page.getByTestId('measure-second')).toContainText('None');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('real Electron Measure remains usable during a running slice and scale invalidates it', async () => {
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-measure-slice-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_PREFERENCES: preferences,
    ORCA_E2E_MODEL: resolve(__dirname, '../../../packages/slicer-wasm/fixtures/cube.stl') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow(); await ready(page); await selectPrinter(page);
    const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
    await page.getByTestId('btn-add-model').click();
    await expect.poll(async () => (await booleanMeshes(page)).length, { timeout: 60_000 }).toBe(1);
    await page.getByTestId('config-mode-scoped').click();
    await page.getByTestId('object-list').locator('div[data-testid^="object-"]').first().getByRole('button').first().click();
    // A tall but simple model keeps the real slicer occupied without requiring
    // a large or user-provided project fixture.
    await page.getByTestId('gizmo-btn-scale').click();
    const height = page.getByTestId('scale-size-z'); await height.fill('200'); await height.press('Enter');
    await expect.poll(async () => {
      const { min, max } = (await booleanMeshes(page))[0].bounds;
      return max[2] - min[2];
    }, { timeout: 60_000 }).toBeCloseTo(200, 1);
    await page.getByTestId('gizmo-btn-move').click();
    await page.getByTestId('move-drop-bed').click();
    await expect.poll(async () => (await booleanMeshes(page))[0].bounds.min[2], { timeout: 60_000 }).toBeCloseTo(0, 1);
    const bounds = (await booleanMeshes(page))[0].bounds;
    const center = bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2);
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Slicing…', { timeout: 60_000 });
    await page.locator('#app-tab-prepare').click();
    await page.evaluate(c => (window as any).__orcaE2e.setCameraView([c[0], c[1], 300], [c[0], c[1], 0]), center);
    await page.getByTestId('gizmo-btn-measure').click();
    const panel = page.getByTestId('measure-panel'); await expect(panel).toBeVisible();
    await expect(panel.getByRole('status')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Slicing…');
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const clickWorld = async (point: number[]) => {
      const projected = await page.evaluate(p => (window as any).__orcaE2e.projectWorldToScreen(p), point);
      const box = await canvas.boundingBox();
      if (!box || !projected) throw new Error('model point is not visible');
      await page.mouse.click(box.x + projected.x, box.y + projected.y);
    };
    await page.keyboard.down('Shift');
    await clickWorld([center[0] - 4, center[1] - 4, bounds.max[2]]);
    await expect(page.getByTestId('measure-first')).toContainText('Point on plane');
    await clickWorld([center[0] + 4, center[1] + 4, bounds.max[2]]);
    await page.keyboard.up('Shift');
    await expect(page.getByTestId('measure-second')).toContainText('Point on plane');
    await expect(page.getByTestId('slicer-status')).toHaveText('Slicing…');
    await page.getByTestId('measure-edit-scale').click();
    await page.getByTestId('measure-scale-value').fill('13');
    await expect(page.getByTestId('slicer-status')).toHaveText('Slicing…');
    await page.getByTestId('measure-scale-value').press('Enter');
    await expect(page.getByTestId('measure-dimension')).toHaveText('13.000 mm', { timeout: 60_000 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
    await expect(page.getByTestId('btn-export')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
