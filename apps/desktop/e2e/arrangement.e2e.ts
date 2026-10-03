import { _electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertCubePacking, centers, completed, expectSameCenters, history, ready, selectPrinter } from './arrangement-journey';

test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires freshly staged real WASM; run scripts/run-arrangement-e2e.mjs');
test.setTimeout(480_000);

const expectedVariant = process.env.ORCA_E2E_ARRANGEMENT_EXPECT_VARIANT ?? 'serial';
if (expectedVariant !== 'serial' && expectedVariant !== 'threaded') throw new Error('Unknown arrangement runtime expectation');
const expectedCancelCount = expectedVariant === 'threaded' ? 1 : 0;

test(`real ${expectedVariant} arrangement settings, atomic layout, history and current-plate entry`, async () => {
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-arrangement-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_PREFERENCES: preferences,
    ORCA_E2E_MODEL: resolve(__dirname, '../../../packages/slicer-wasm/fixtures/cube.stl') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await ready(page); await selectPrinter(page);
    for (let count = 1; count <= 4; count++) {
      await page.getByTestId('btn-add-model').click();
      await expect.poll(async () => (await centers(page)).length, { timeout: 30_000 }).toBe(count);
    }
    await page.getByTestId('arrange-menu').click();
    await expect(page.getByTestId('arrange-distance')).toHaveValue('0');
    await expect(page.getByTestId('arrange-rotate')).not.toBeChecked();
    await expect(page.getByTestId('arrange-multiple-materials')).toBeChecked();
    await expect(page.getByTestId('arrange-align-y')).toBeChecked();
    await page.getByTestId('arrange-distance').fill('125');
    await page.getByTestId('arrange-distance').press('Tab');
    await page.getByTestId('arrange-rotate').click();
    await expect(page.getByTestId('arrange-align-y')).not.toBeChecked();
    await expect(page.getByTestId('arrange-align-y')).toBeDisabled();
    await page.getByTestId('arrange-multiple-materials').click();
    await expect.poll(() => JSON.parse(readFileSync(preferences, 'utf8')).arrangement).toMatchObject({
      byLayer: { distance: 125, rotate: true }, multipleMaterials: false,
    });
    await page.getByTestId('arrange-reset').click();
    await expect(page.getByTestId('arrange-distance')).toHaveValue('0');
    await expect(page.getByTestId('arrange-rotate')).not.toBeChecked();
    await expect(page.getByTestId('arrange-align-y')).toBeChecked();
    await expect(page.getByTestId('arrange-multiple-materials')).toBeChecked();
    // Disable derived Y alignment too, so the independent 20 mm AABB oracle
    // below does not need to assume the native dominant-axis orientation.
    await page.getByTestId('arrange-align-y').click();
    const before = await centers(page), beforeHistory = await history(page);
    await page.evaluate(() => {
      const observations: Array<{ cancelCount: number; disabled: boolean }> = [];
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[data-testid="arrangement-status"]')?.textContent?.includes('Arranging models')) return;
        observations.push({ cancelCount: document.querySelectorAll('[data-testid="arrange-cancel"]').length,
          disabled: (document.querySelector('[data-testid="arrangement-edit-boundary"]') as HTMLFieldSetElement)?.disabled });
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      (window as unknown as { arrangementObservation: () => typeof observations }).arrangementObservation = () => {
        observer.disconnect(); return observations;
      };
    });
    await page.getByTestId('arrange-all').click();
    if (expectedVariant === 'serial') await expect(page.getByTestId('arrange-cancel')).toHaveCount(0);
    await completed(page);
    const busyObservations = await page.evaluate(() => (window as unknown as {
      arrangementObservation(): Array<{ cancelCount: number; disabled: boolean }>;
    }).arrangementObservation());
    expect(busyObservations.length, 'observe the real operation while it is running').toBeGreaterThan(0);
    expect(busyObservations.every(sample => sample.cancelCount === expectedCancelCount && sample.disabled)).toBe(true);
    const after = await assertCubePacking(page, before);
    await expect.poll(async () => (await history(page)).undoEntries.length).toBe(beforeHistory.undoEntries.length + 1);
    await page.screenshot({ path: test.info().outputPath(`${expectedVariant}-arranged.png`) });
    await page.getByTestId('history-undo').click();
    await expect.poll(() => centers(page)).toEqual(before);
    expectSameCenters(await centers(page), before);
    await page.getByTestId('history-redo').click();
    await expect.poll(() => centers(page)).toEqual(after);
    expectSameCenters(await centers(page), after);
    // Undo restores the overlapping inputs; the separate plate control must
    // run the same real algorithm without adding another plate.
    await page.getByTestId('history-undo').click();
    await expect.poll(() => centers(page)).toEqual(before);
    await page.getByTestId('arrange-current-plate').click();
    await completed(page); await assertCubePacking(page, before);
    await expect(page.getByTestId('current-plate-label')).toHaveText('Plate 1 (1/36)');
    await expect.poll(() => JSON.parse(readFileSync(preferences, 'utf8')).arrangement).toMatchObject({
      byLayer: { distance: 0, rotate: false }, multipleMaterials: true,
    });
  } finally { await app.close(); }
});
