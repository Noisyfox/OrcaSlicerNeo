import { readZipEntries } from '../../../packages/slicer-wasm/harness/native-3mf-parser.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { selectFixturePrinter } from '../../desktop/e2e/printer-selection';
import { test, expect } from './browser-fixture';

test('real Web Worker settles Auto Drop and preserves it through history', async ({ page, context }) => {
  const variant = process.env.ORCA_WEB_NO_ISOLATION === '1' ? 'serial' : 'threaded';
  let servedHash: string | undefined;
  await context.route('**/wasm/*/orca_slice.wasm', async (route) => {
    const response = await route.fetch(), bytes = await response.body();
    expect(new URL(route.request().url()).pathname).toContain(`/wasm/${variant}/`);
    servedHash = createHash('sha256').update(bytes).digest('hex');
    await route.fulfill({ response, body: bytes });
  });
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  const artifact = await readFile(resolve(import.meta.dirname, `../../../packages/slicer-wasm/out/${variant}/orca_slice.wasm`));
  expect(servedHash).toBe(createHash('sha256').update(artifact).digest('hex'));
  await page.locator('#app-tab-prepare').click();
  await selectFixturePrinter(page, 'Creality Ender-3 0.4 nozzle');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(import.meta.dirname, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('config-mode-scoped').click();
  const row = page.getByTestId('object-list').locator('section[data-testid^="plate-group-"] > div[data-testid^="object-"]').first();
  await row.getByRole('button').first().click();
  await page.getByTestId('gizmo-btn-move').click();
  const z = page.getByTestId('move-z');
  const initial = Number(await z.inputValue());
  const rest = initial.toFixed(3), raised = (initial + 10).toFixed(3);
  const previousUndo = await page.getByTestId('history-undo').getAttribute('aria-label');
  await z.fill(raised); await z.press('Enter');
  await expect(z).toHaveValue(rest);
  await expect(page.getByTestId('history-undo')).toHaveAttribute('aria-label', previousUndo!);
  const toggle = async () => {
    await row.getByRole('button').first().click({ button: 'right' });
    await page.getByTestId('objectlist-auto-drop').click();
  };
  await toggle();
  await expect(page.getByTestId('history-undo')).toHaveAttribute('aria-label', 'Undo Disable Auto Drop');
  await z.fill(raised); await z.press('Enter');
  await expect(page.getByTestId('history-undo')).toHaveAttribute('aria-label', 'Undo Move');
  await expect(z).toHaveValue(raised);
  await toggle();
  await expect(page.getByTestId('history-undo')).toHaveAttribute('aria-label', 'Undo Enable Auto Drop');
  await expect(z).toHaveValue(rest);
  await page.getByTestId('history-undo').click(); await expect(z).toHaveValue(raised);
  await page.getByTestId('history-redo').click(); await expect(z).toHaveValue(rest);

  const save = page.getByTestId('titlebar-save-project');
  const savedTranslation = async (action: () => Promise<void>) => {
    const download = page.waitForEvent('download');
    await action();
    const file = await download;
    const entries = readZipEntries(await readFile((await file.path())!));
    const model = entries.find((entry: { name: string }) => entry.name === '3D/3dmodel.model');
    const xml = new TextDecoder().decode(model.content);
    const transform = /<item\b[^>]*\btransform="([^"]+)"/.exec(xml);
    expect(transform).not.toBeNull();
    await expect(save).toBeDisabled();
    return transform![1].trim().split(/\s+/).slice(9, 12).map(Number);
  };
  const baseline = await savedTranslation(() => page.keyboard.press('ControlOrMeta+Shift+s'));
  const x = page.getByTestId('move-x');
  const originalX = Number(await x.inputValue());
  const draftX = (originalX + 7).toFixed(3);

  // A committed edit enables ordinary Save while the next value is still being typed.
  await x.fill((originalX + 3).toFixed(3));
  await x.press('Enter');
  await expect(save).toBeEnabled();
  await x.fill(draftX);
  await expect(x).toBeFocused();
  await expect(x).toHaveValue(draftX);
  const keyboardSave = await savedTranslation(() => page.keyboard.press('ControlOrMeta+s'));
  expect(keyboardSave[0]).toBeCloseTo(baseline[0] + 3);

  // Clicking Z releases X. Clicking Save then releases Z and must export its bed correction.
  await x.fill(draftX);
  await z.fill(raised);
  await expect(save).toBeEnabled();
  const clickedSave = await savedTranslation(() => save.click());
  expect(clickedSave[0]).toBeCloseTo(baseline[0] + 7);
  expect(clickedSave[2]).toBeCloseTo(baseline[2]);
  await expect(z).toHaveValue(rest);

  await z.fill(raised);
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  const afterSlice = await savedTranslation(() => page.keyboard.press('ControlOrMeta+Shift+s'));
  expect(afterSlice).toEqual(clickedSave);
  await expect(page.getByTestId('history-undo')).toHaveAttribute('aria-label', 'Undo Move');
});
