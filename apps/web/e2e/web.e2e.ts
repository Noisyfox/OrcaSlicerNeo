import playwright from '../../desktop/node_modules/@playwright/test/index.js';
const { test, expect } = playwright;
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));

// This suite intentionally has no mock mode. The staging step must have
// published both real wasm64 variants before either invocation is run.
test('real Web flow: import DRC → profile → slice → layer → G-code download', async ({ page }) => {
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __orcaOpenedSources: string[] }).__orcaOpenedSources = opened;
    window.open = ((url?: string | URL) => {
      if (url !== undefined) opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (error) => console.log(`[browser:error] ${String(error)}`));
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await expect(page.locator('#app-panel-home')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.getByTestId('home-page')).toBeAttached();
  await expect(page.locator('#app-panel-workspace')).toHaveAttribute('aria-hidden', 'true');
  await page.locator('#app-tab-prepare').click();
  if (process.env.ORCA_WEB_NO_ISOLATION === '1') {
    await expect(page.getByTestId('serial-fallback-status')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('serial-fallback-status')).toContainText('serial wasm64 fallback');
  } else {
    await expect(page.getByTestId('serial-fallback-status')).toHaveCount(0);
  }
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
  await expect(page.getByTestId('titlebar-menu')).toBeVisible();
  await expect(page.getByTestId('menu-file-trigger')).toBeVisible();
  await expect(page.getByTestId('menu-help-trigger')).toBeVisible();
  await page.getByTestId('menu-file-trigger').click();
  await expect(page.getByTestId('file-add-model')).toBeEnabled();
  await expect(page.getByTestId('file-clear-scene')).toBeDisabled();
  await expect(page.getByTestId('file-slice')).toBeDisabled();
  await expect(page.getByTestId('file-export-gcode')).toBeDisabled();
  await expect(page.getByTestId('file-quit')).toHaveCount(0);
  await page.getByTestId('menu-help-trigger').click();
  // Activate the visible menu item programmatically. In headless Chrome the
  // popup's visual layer can be geometrically overlapped by the tab strip.
  await page.getByTestId('help-source').evaluate((element) => (element as HTMLElement).click());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __orcaOpenedSources?: string[] }).__orcaOpenedSources ?? [])).toEqual([
    'https://github.com/Noisyfox/OrcaSlicerNeo',
  ]);
  expect(page.url()).toContain('127.0.0.1:4173');
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);

  await page.getByTestId('preset-select').click();
  const picker = page.locator('[data-slot="combobox-content"]');
  await picker.locator('input').fill('Creality Ender-3 0.4 nozzle');
  await picker.locator('[data-slot="combobox-item"]').filter({ hasText: 'Creality Ender-3 0.4 nozzle' }).click();

  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(
    here,
    '../../../packages/slicer-wasm/fixtures/drc/test_nm.obj.edgebreaker.cl4.2.2.drc',
  ));
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
  await page.getByTestId('menu-file-trigger').click();
  await expect(page.getByTestId('file-clear-scene')).toBeEnabled();
  await expect(page.getByTestId('file-slice')).toBeEnabled();
  await expect(page.getByTestId('file-export-gcode')).toBeDisabled();
  await page.getByTestId('menu-file-trigger').click();
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  const layerHeight = page.locator('#layer_height');
  if (await layerHeight.count()) await layerHeight.fill('0.21');
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
  // The default gate prefers streaming. A capable browser reports ready;
  // optional backend failures are accepted only with an explicit B2 reason.
  await expect.poll(() => page.evaluate(() => {
    const hooks = (window as unknown as {
      __orcaE2e?: {
        gpuStreamingStatus?: () => string;
        gpuStreamingDiagnostic?: () => { reason?: string } | null;
      };
    }).__orcaE2e;
    const status = hooks?.gpuStreamingStatus?.();
    return status === 'ready' || (status === 'b2' && Boolean(hooks?.gpuStreamingDiagnostic?.()?.reason));
  }), { timeout: 20_000 }).toBe(true);
  await page.setViewportSize({ width: 720, height: 520 });
  await page.getByTestId('menu-file-trigger').click();
  await expect(page.getByTestId('file-export-gcode')).toBeEnabled();
  await page.getByTestId('menu-file-trigger').click();
  await expect(page.getByTestId('viewport')).toBeVisible();
  const scrubber = page.getByTestId('layer-scrubber');
  await expect(scrubber).toBeAttached({ timeout: 30_000 });
  await scrubber.scrollIntoViewIfNeeded();
  await expect(scrubber.locator('input[type="range"]')).toBeAttached();
  const range = scrubber.locator('input[type="range"]');
  if (await range.count()) {
    const before = await range.inputValue();
    await range.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = input.max === '0' ? '0' : '1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(await range.inputValue()).not.toBe(before);
  }

  // Phase-B Orca-style overlay contract: feature legend uses hide/show
  // semantics, travel is a global toggle, layer/move controls are present,
  // and the camera-facing marker is in the scene at the inspection position.
  await page.locator('#app-tab-preview').click();
  await expect(page.getByTestId('preview-controls')).toBeVisible({ timeout: 30_000 });
  const feature = page.locator('[data-testid^="preview-feature-visibility-"]').first();
  await expect(feature).toHaveAttribute('aria-pressed', 'true');
  await feature.click();
  await expect(feature).toHaveAttribute('aria-pressed', 'false');
  await feature.click();
  await expect(feature).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('preview-travel-toggle').click();
  await expect(page.getByTestId('preview-travel-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('preview-travel-toggle').click();
  await expect(page.getByTestId('preview-travel-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('preview-layer-range')).toBeVisible();
  await expect(page.getByTestId('preview-move-range')).toBeVisible();
  const overlayGeometry = await page.evaluate(() => {
    const controls = document.querySelector('[data-testid="preview-controls"]')?.getBoundingClientRect();
    const layer = document.querySelector('[data-testid="preview-layer-range"]')?.getBoundingClientRect();
    if (!controls || !layer) return null;
    return {
      intersects: controls.left < layer.right && controls.right > layer.left
        && controls.top < layer.bottom && controls.bottom > layer.top,
    };
  });
  expect(overlayGeometry).not.toBeNull();
  expect(overlayGeometry?.intersects).toBe(false);
  const moveInputs = page.getByTestId('preview-move-range').locator('input[type="range"]');
  await expect(moveInputs).toHaveCount(1);
  await expect(page.getByTestId('preview-move-range').locator('[role="group"]')).toHaveAttribute('aria-label', 'Active layer move end');
  const moveInput = moveInputs.first();
  await moveInput.focus();
  await page.keyboard.press('Home');
  await expect(moveInput).toHaveValue('0');
  const layerInputs = page.getByTestId('preview-layer-range').locator('input[type="range"]');
  await expect(layerInputs).toHaveCount(2);
  await layerInputs.nth(1).focus();
  await page.keyboard.press('Home');
  await expect(layerInputs.nth(1)).toHaveValue('0');

  // Single-layer inspection keeps the vertical control dual-thumb. Starting
  // from a multi-layer range, both thumbs collapse to the active layer and
  // either thumb can then move that layer without reversing the range.
  const singleLayerToggle = page.getByTestId('preview-single-layer');
  await singleLayerToggle.click();
  await expect(singleLayerToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(layerInputs.nth(0)).toHaveValue(await layerInputs.nth(1).inputValue());
  await layerInputs.nth(0).focus();
  await page.keyboard.press('Home');
  await expect(layerInputs.nth(0)).toHaveValue('0');
  await expect(layerInputs.nth(1)).toHaveValue('0');
  await layerInputs.nth(1).focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => layerInputs.nth(0).inputValue()).toBe('1');
  await expect(layerInputs.nth(1)).toHaveValue('1');
  await expect(singleLayerToggle).toHaveAttribute('aria-pressed', 'true');
  await singleLayerToggle.click();
  await expect(singleLayerToggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => Number(await layerInputs.nth(0).inputValue()) <= Number(await layerInputs.nth(1).inputValue())).toBe(true);

  const currentLayer = await layerInputs.nth(1).inputValue();
  await layerInputs.nth(1).focus();
  await page.keyboard.press('Home');
  await expect.poll(() => layerInputs.nth(1).inputValue()).not.toBe(currentLayer);
  await expect.poll(() => moveInput.inputValue()).toBe(await moveInput.getAttribute('max'));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __orcaE2e?: { previewMarkerPresent?: () => boolean } }).__orcaE2e?.previewMarkerPresent?.() ?? false)).toBe(true);
  const themeToken = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-card').trim());
  expect(themeToken).not.toBe('');
  await page.evaluate(() => document.documentElement.classList.toggle('dark'));
  await expect(page.getByTestId('preview-controls')).toBeVisible();

  // A settings override invalidates the old toolpath and therefore export.
  if (await layerHeight.count()) {
    await layerHeight.fill('0.2');
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
    await expect(page.getByTestId('btn-export')).toBeDisabled();
    // The invalidated G-code preview is cleared as well: the toolpath leaves
    // the scene and the scrubber unmounts with it (spec §8).
    await expect(scrubber).toBeAttached({ attached: false });
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
    await expect(scrubber).toBeAttached({ timeout: 30_000 });
  }

  const download = page.waitForEvent('download');
  await page.getByTestId('btn-export').click();
  const result = await download;
  expect(result.suggestedFilename()).toMatch(/\.gcode$/);
  expect(await result.path()).toBeTruthy();
});

// Opt-in migration smoke; the ordinary Web flow intentionally exercises the
// production B2 default. This only checks ownership/fallback, not performance.
test('GPU streaming preview: explicit gate selects backend or fallback', async ({ page }) => {
  test.skip(process.env.ORCA_E2E_GPU_STREAMING !== '1', 'opt-in GPU streaming migration smoke');
  await page.addInitScript(() => {
    (window as unknown as { __orcaE2e?: Record<string, unknown> }).__orcaE2e = { gpuStreamingEnabled: true };
  });
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 120_000 });
  const picker = page.getByTestId('preset-select');
  await picker.click();
  await page.locator('[data-slot="combobox-content"] input').fill('Creality Ender-3 0.4 nozzle');
  await page.locator('[data-slot="combobox-content"] [data-slot="combobox-item"]')
    .filter({ hasText: 'Creality Ender-3 0.4 nozzle' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/drc/test_nm.obj.edgebreaker.cl4.2.2.drc'));
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
  await expect.poll(() => page.evaluate(() => {
    const hooks = (window as unknown as {
      __orcaE2e?: {
        gpuStreamingStatus?: () => string;
        gpuStreamingDiagnostic?: () => { reason?: string } | null;
      };
    }).__orcaE2e;
    const status = hooks?.gpuStreamingStatus?.();
    return status === 'ready' || (status === 'b2' && Boolean(hooks?.gpuStreamingDiagnostic?.()?.reason));
  }), { timeout: 20_000 }).toBe(true);
});
