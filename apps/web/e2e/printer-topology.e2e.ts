import playwright from '../../desktop/node_modules/@playwright/test/index.js';
import type { Page } from '../../desktop/node_modules/@playwright/test/index.js';
const { test, expect } = playwright;

async function openPrinter(page: Page, vendor: string, model: string) {
  await page.addInitScript(({vendor,model}) => {
    localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({version:1,ui:{},profileActivation:{
      models:[{vendor,model,nozzle_diameter:['0.4']}],filaments:['Generic PLA @System'],
    }}));
  }, {vendor,model});
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready',{timeout:120_000});
  await page.locator('#app-tab-prepare').click();
  await page.getByTestId('preset-edit-printer').click();
  await page.getByTestId('preset-editor-page-tab-multimaterial').click();
}

test('native generic Printer topology edits, SEMM locks, joint reset and history stay synchronized', async ({page}) => {
  await openPrinter(page,'Creality','Creality Ender-3');
  const semm=page.getByTestId('preset-editor-input-single_extruder_multi_material');
  if (await semm.getAttribute('aria-checked') === 'true') await semm.click();
  const count=page.getByTestId('preset-editor-input-extruders_count');
  await expect(count).toHaveValue('1');
  await count.fill('3'); await count.press('Enter');
  await expect(count).toHaveValue('3');
  await expect(page.getByTestId('filament-slot-3')).toBeAttached();
  await expect(page.getByTestId('preset-editor-option-label-extruders_count')).toHaveAttribute('data-draft-override-highlight','true');
  await count.fill('2.5'); await count.press('Enter');
  await expect(page.getByTestId('preset-editor-error-extruders_count')).toContainText('valid number');
  await expect(page.getByTestId('preset-editor-effective-extruders_count')).toHaveText('3');
  await count.fill('3'); await count.press('Enter');
  await page.getByTestId('preset-editor-page-tab-extruder').click();
  await page.getByTestId('preset-editor-extruder-3').click();
  await expect(page.getByTestId('preset-editor-extruder-3')).toHaveAttribute('aria-pressed','true');
  await page.getByTestId('preset-editor-page-tab-multimaterial').click();
  await semm.click();
  await expect(semm).toHaveAttribute('aria-checked','true');
  await expect(count).toHaveCount(0);
  await expect(page.getByTestId('preset-editor-effective-extruders_count')).toHaveText('1');
  await expect(page.getByTestId('filament-slot-3')).toBeAttached();
  await semm.click();
  await expect(count).toHaveValue('1');
  await expect(page.getByTestId('filament-slot-2')).toHaveCount(0);
  await count.fill('2'); await count.press('Enter');
  await expect(count).toHaveValue('2');
  await page.getByTestId('preset-editor-page-tab-extruder').click();
  await expect(page.getByTestId('preset-editor-extruder-3')).toHaveCount(0);
  await expect(page.getByTestId('preset-editor-extruder-1')).toHaveAttribute('aria-pressed','true');
  await expect(page.getByTestId('preset-editor-extruder-2')).toBeVisible();
  await page.getByTestId('preset-editor-close').click();
  await page.getByTestId('history-undo').click();
  await expect(page.getByTestId('filament-slot-2')).toHaveCount(0);
  await page.getByTestId('history-redo').click();
  await expect(page.getByTestId('filament-slot-2')).toBeAttached();
  await page.getByTestId('preset-edit-printer').click();
  await page.getByTestId('preset-editor-page-tab-multimaterial').click();
  await expect(count).toHaveValue('2');
  await page.getByTestId('preset-editor-reset-category-multimaterial').click();
  await expect(page.getByTestId('preset-editor-effective-extruders_count')).toHaveText('1');
  await expect(page.getByTestId('preset-editor-option-label-extruders_count')).toHaveAttribute('data-draft-override-highlight','false');
});

test('native Bambu multi-head SEMM retains its heads and independently edits count', async ({page}) => {
  await openPrinter(page,'BBL','Bambu Lab H2D');
  const semm=page.getByTestId('preset-editor-input-single_extruder_multi_material');
  const count=page.getByTestId('preset-editor-input-extruders_count');
  await expect(semm).toHaveAttribute('aria-checked','true');
  await expect(count).toHaveValue('2');
  await semm.click(); await expect(semm).toHaveAttribute('aria-checked','false');
  await expect(count).toHaveValue('2');
  await semm.click(); await expect(semm).toHaveAttribute('aria-checked','true');
  await expect(count).toHaveValue('2');
  await count.fill('3'); await count.press('Enter');
  await expect(count).toHaveValue('3');
  await expect(semm).toHaveAttribute('aria-checked','true');
  await page.getByTestId('preset-editor-reset-field-extruders_count').click();
  await expect(count).toHaveValue('2');
  await expect(semm).toHaveAttribute('aria-checked','true');
});
