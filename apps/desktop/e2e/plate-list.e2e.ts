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
    const card = page.getByTestId('preview-plate-list').locator('.plate-list-card').first();
    const initialCard = (await card.boundingBox())!;
    const addPlateButton = (await page.getByTestId('add-plate').boundingBox())!;
    expect(initialCard.y - addPlateButton.y - addPlateButton.height).toBeCloseTo(4, 1);
    const optionsBounds = (await page.getByTestId('configuration-options-scroll').boundingBox())!;
    expect(initialCard.x).toBe(optionsBounds.x);
    expect(initialCard.x + initialCard.width).toBe(optionsBounds.x + optionsBounds.width);
    const initialThumbnail = (await thumbnail.boundingBox())!;
    const leftInset = initialThumbnail.x - initialCard.x;
    expect(initialThumbnail.y - initialCard.y).toBeCloseTo(leftInset, 1);
    expect(initialCard.y + initialCard.height - initialThumbnail.y - initialThumbnail.height).toBeCloseTo(leftInset, 1);
    const initialImageUrl = await thumbnail.getAttribute('src');
    const resizer = page.getByTestId('sidebar-resizer');
    await resizer.focus();
    for (let index = 0; index < 6; index++) await resizer.press('ArrowRight');
    const widerCard = (await card.boundingBox())!;
    expect(widerCard.width).toBeGreaterThan(initialCard.width);
    expect(widerCard.height).toBe(initialCard.height);
    expect((await thumbnail.boundingBox())!.width).toBe(initialThumbnail.width);
    expect((await thumbnail.boundingBox())!.height).toBe(initialThumbnail.height);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await thumbnail.getAttribute('src')).toBe(initialImageUrl);
    for (let index = 0; index < 6; index++) await resizer.press('ArrowLeft');
    expect((await card.boundingBox())!.height).toBe(initialCard.height);
    expect(await thumbnail.getAttribute('src')).toBe(initialImageUrl);
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
    const initialSidebarWidth = Number(await resizer.getAttribute('aria-valuenow'));
    for (let index = 0; index < 8; index++) await resizer.press('ArrowLeft');
    const narrowCard = (await card.boundingBox())!;
    expect(narrowCard.height).toBe(initialCard.height);
    expect((await thumbnail.boundingBox())!.width).toBe(initialThumbnail.width);
    const printBox = (await page.getByTestId(`plate-print-${plateId}`).boundingBox())!;
    expect(printBox.x + printBox.width).toBeLessThanOrEqual(narrowCard.x + narrowCard.width);
    while (Number(await resizer.getAttribute('aria-valuenow')) < initialSidebarWidth) await resizer.press('ArrowRight');
    // Restore exactly when the minimum-width clamp is not aligned to the keyboard step.
    const restoredSidebarWidth = Number(await resizer.getAttribute('aria-valuenow'));
    if (restoredSidebarWidth !== initialSidebarWidth) {
      const divider = (await resizer.boundingBox())!;
      await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
      await page.mouse.down();
      await page.mouse.move(divider.x + divider.width / 2 + initialSidebarWidth - restoredSidebarWidth, divider.y + divider.height / 2);
      await page.mouse.up();
    }
    if (process.env.ORCA_E2E_REAL === '1') {
      await expect(page.getByTestId(`plate-time-${plateId}`)).not.toHaveText('—');
      await expect(page.getByTestId('preview-plate-list')).toContainText(/\d+\.\d+m \| \d+\.\d+g/);
    }
    const statsFit = await card.locator('.plate-list-details').evaluate(element => {
      const details = element.getBoundingClientRect();
      const metrics = element.querySelector('[data-slot="card-description"]')!.lastElementChild!;
      const range = document.createRange(); range.selectNodeContents(metrics);
      return {
        textFits: range.getBoundingClientRect().bottom <= details.bottom,
        contentFits: element.scrollHeight <= element.clientHeight,
        fontSize: getComputedStyle(metrics).fontSize,
      };
    });
    expect(statsFit).toEqual({ textFits: true, contentFits: true, fontSize: '13px' });
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
    // The full catalogue and expanded search have a fixed budget. Only the
    // area below the title and toolbar counts toward the half-height cap.
    const options = page.getByTestId('plate-options-section');
    for (const height of [900, 360, 900]) {
      await page.setViewportSize({ width: 1280, height });
      await expect.poll(() => options.evaluate(element => {
        const panel = element.closest('[data-testid="scoped-configuration-panel"]')!;
        const list = panel.querySelector('[data-testid="configuration-plate-list-scroll"]')!;
        const expected = Math.min(170, Math.max(0, panel.getBoundingClientRect().bottom - list.getBoundingClientRect().top) / 2);
        return Math.abs(element.getBoundingClientRect().height - expected) <= 1 ? '' : JSON.stringify({
          actual: element.getBoundingClientRect().height, expected, maxHeight: (element as HTMLElement).style.maxHeight });
      })).toBe('');
    }
    const optionsHeight = (await options.boundingBox())!.height;
    const lastCardBounds = (await page.getByTestId('preview-plate-list').locator('.plate-list-card').last().boundingBox())!;
    const optionsTop = (await options.boundingBox())!.y;
    expect(optionsTop - lastCardBounds.y - lastCardBounds.height).toBeLessThanOrEqual(13);
    expect(optionsTop).toBeGreaterThan(lastCardBounds.y + lastCardBounds.height);
    const listBounds = (await page.getByTestId('configuration-plate-list-scroll').boundingBox())!;
    const dividerWidth = await page.getByTestId('configuration-plate-list-scroll').evaluate(element =>
      Number.parseFloat(getComputedStyle(element).borderBottomWidth));
    expect(listBounds.y + listBounds.height - lastCardBounds.y - lastCardBounds.height).toBeCloseTo(8 + dividerWidth, 1);
    expect(optionsTop - listBounds.y - listBounds.height).toBeCloseTo(4, 1);
    const listHeight = (await page.getByTestId('configuration-plate-list-scroll').boundingBox())!.height;
    // Bed selection is capability-dependent; print sequence remains a
    // plate option for both single-bed and selectable-bed printers.
    const firstOption = page.getByTestId('config-field-print_sequence');
    await expect(firstOption).toBeVisible();
    const collapsedOptionTop = (await firstOption.boundingBox())!.y;
    await options.getByRole('button', { name: 'Search settings', exact: true }).click();
    expect((await firstOption.boundingBox())!.y).toBeGreaterThan(collapsedOptionTop);
    await page.getByTestId('scoped-config-search').fill('no matching option');
    await expect(page.getByTestId('scoped-config-empty')).toBeVisible();
    expect((await options.boundingBox())!.height).toBe(optionsHeight);
    expect((await page.getByTestId('configuration-plate-list-scroll').boundingBox())!.height).toBe(listHeight);
    await options.getByRole('button', { name: 'Search settings', exact: true }).click();
    expect((await firstOption.boundingBox())!.y).toBe(collapsedOptionTop);
    await page.getByTestId('sidebar-settings-panel').screenshot({ path: join(desktop, '.vitest/plate-list.png') });
    await test.info().attach('plate-list', { body: await page.getByTestId('sidebar-settings-panel').screenshot(), contentType: 'image/png' });
  } catch (error) { console.error(errors.join('\n')); throw error; }
  finally { await app.close(); }
});
