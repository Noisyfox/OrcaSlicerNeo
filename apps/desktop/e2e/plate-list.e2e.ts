import { _electron, expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('plate cards render model thumbnails without changing surrounding layout', async () => {
  test.setTimeout(90000);
  const desktop = resolve(__dirname, '..');
  const env = { ...process.env, ORCA_E2E: '1',
    ORCA_E2E_USER_DATA: mkdtempSync(join(tmpdir(), 'orca-plate-list-')),
    ORCA_E2E_MODEL: resolve(desktop, '../../packages/slicer-wasm/fixtures/cube.stl') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: desktop, env });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled();
    await page.getByTestId('config-mode-plates').click();
    const before = await page.getByTestId('sidebar-settings-panel').boundingBox();
    const thumbnail = page.getByTestId('preview-plate-list').locator('img').first();
    await expect(thumbnail).toBeVisible({ timeout: 15000 });
    const imageEvidence = await thumbnail.evaluate(async (element: HTMLImageElement) => {
      await element.decode();
      const canvas = document.createElement('canvas'); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
      const context = canvas.getContext('2d')!; context.drawImage(element, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0, transparent = 0;
      for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] > 0) opaque++; else transparent++; }
      return { opaque, transparent, square: canvas.width === canvas.height };
    });
    expect(imageEvidence.square).toBe(true);
    expect(imageEvidence.opaque).toBeGreaterThan(100);
    expect(imageEvidence.transparent).toBeGreaterThan(100);
    await expect(page.getByTestId('preview-plate-list').getByRole('option')).toHaveCount(1);
    expect(await page.getByTestId('sidebar-settings-panel').boundingBox()).toEqual(before);
    const originalPlateId = await page.getByTestId('preview-plate-list').getByRole('option').getAttribute('id');
    const plateId = originalPlateId!.replace('preview-plate-', '');
    await page.getByTestId('add-plate').click();
    await expect(page.getByTestId('preview-plate-list').getByRole('option', { selected: true })).toHaveText('Plate 2');
    await page.getByTestId(`plate-time-${plateId}`).click();
    await expect(page.getByTestId('preview-plate-list').getByRole('option', { selected: true })).toHaveText('Plate 1');
    await page.getByTestId('preview-plate-list').getByRole('option', { name: /^Plate 2,/ }).click();
    await expect(page.getByTestId('preview-plate-list').getByRole('option', { selected: true })).toHaveText('Plate 2');
    await page.getByTestId(`plate-slice-${plateId}`).click();
    await expect(page.getByTestId('preview-plate-list').locator('[data-plate-state="sliced"]'),
      'Explicit plate slicing should finish successfully').toHaveCount(1, { timeout: 30000 });
    if (process.env.ORCA_E2E_REAL === '1') {
      await expect(page.getByTestId(`plate-time-${plateId}`)).not.toHaveText('—');
      await expect(page.getByTestId('preview-plate-list')).toContainText(/\d+\.\d+m \| \d+\.\d+g/);
    }
    await expect(page.getByTestId('preview-plate-list').getByRole('option', { selected: true })).toHaveText('Plate 2');
    await page.getByTestId(`plate-print-${plateId}`).click();
    await expect(page.getByTestId('send-gcode-dialog')).toBeVisible();
    await expect(page.getByTestId('preview-plate-list').getByRole('option', { selected: true })).toHaveText('Plate 2');
    await page.getByTestId('send-close').click();
    await page.getByTestId('plate-search-toggle').click();
    await page.getByTestId('plate-search').fill('plate 1');
    await expect(page.getByTestId('preview-plate-list').getByRole('option')).toHaveCount(1);
    await expect(page.getByTestId('preview-plate-list').getByRole('option', { selected: true })).toHaveCount(0);
    await page.getByTestId('plate-search').fill('no such plate');
    await expect(page.getByText('No matching plates', { exact: true })).toBeVisible();
    await page.getByTestId('plate-search-toggle').click();
    await expect(page.getByTestId('preview-plate-list').getByRole('option', { selected: true })).toHaveText('Plate 2');
    expect(await page.getByTestId('sidebar-settings-panel').boundingBox()).toEqual(before);
    await expect(page.getByRole('button', { name: 'Send All', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Print All', exact: true })).toHaveCount(0);
    await page.getByTestId('sidebar-settings-panel').screenshot({ path: join(desktop, '.vitest/plate-list.png') });
    await test.info().attach('plate-list', { body: await page.getByTestId('sidebar-settings-panel').screenshot(), contentType: 'image/png' });
  } catch (error) { console.error(errors.join('\n')); throw error; }
  finally { await app.close(); }
});
