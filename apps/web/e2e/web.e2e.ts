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
    localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({
      version: 1,
      projectLoadBehaviour: 'always_ask',
      selectedProfiles: {},
      ui: {},
    }));
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
  // A file drop over the nested object list must reach the shared Open
  // Project action even though that target stops propagation for text drags.
  const urlBeforeDrop = page.url();
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([80, 75, 3, 4])], 'dropped.3mf'));
    const target = document.querySelector('[data-testid="object-list"]') ?? document;
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.getByTestId('project-load-choice-dialog')).toBeVisible();
  expect(page.url()).toBe(urlBeforeDrop);
  await page.getByTestId('project-load-cancel').click();
  await expect(page.getByTestId('project-load-choice-dialog')).toBeHidden();
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
  // The native SegmentTemplate renderer is the sole preview backend. A
  // capability/context failure is surfaced as an explicit diagnostic.
  await expect.poll(() => page.evaluate(() => {
    const hooks = (window as unknown as {
      __orcaE2e?: {
        gpuStreamingStatus?: () => string;
        gpuStreamingDiagnostic?: () => { reason?: string } | null;
      };
    }).__orcaE2e;
    const status = hooks?.gpuStreamingStatus?.();
    return status === 'ready' || (status === 'unavailable' && Boolean(hooks?.gpuStreamingDiagnostic?.()?.reason));
  }), { timeout: 20_000 }).toBe(true);
  await page.setViewportSize({ width: 720, height: 520 });
  await page.getByTestId('menu-file-trigger').click();
  await expect(page.getByTestId('file-export-gcode')).toBeEnabled();
  await page.getByTestId('menu-file-trigger').click();
  await expect(page.getByTestId('viewport')).toBeVisible();
  const scrubber = page.getByTestId('layer-scrubber');
  await expect(scrubber).toBeAttached({ timeout: 30_000 });
  await scrubber.scrollIntoViewIfNeeded();
  // The layer control has two thumbs; target the end thumb by its stable
  // semantic test id instead of relying on an ambiguous descendant locator.
  const range = scrubber.getByTestId('layer-scrubber-end').locator('input[type="range"]');
  await expect(range).toBeAttached();
  const before = await range.inputValue();
  await range.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = input.max === '0' ? '0' : '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(await range.inputValue()).not.toBe(before);

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
  const layerStartInput = page.getByTestId('layer-scrubber-start').locator('input[type="range"]');
  const layerEndInput = page.getByTestId('layer-scrubber-end').locator('input[type="range"]');
  await expect(layerStartInput).toBeAttached();
  await expect(layerEndInput).toBeAttached();
  await layerEndInput.focus();
  await page.keyboard.press('Home');
  await expect(layerEndInput).toHaveValue('0');

  // Single-layer inspection keeps the vertical control dual-thumb. Starting
  // from a multi-layer range, both thumbs collapse to the active layer and
  // either thumb can then move that layer without reversing the range.
  const singleLayerToggle = page.getByTestId('preview-single-layer');
  await singleLayerToggle.click();
  await expect(singleLayerToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(layerStartInput).toHaveValue(await layerEndInput.inputValue());
  await layerStartInput.focus();
  await page.keyboard.press('Home');
  await expect(layerStartInput).toHaveValue('0');
  await expect(layerEndInput).toHaveValue('0');
  await layerEndInput.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => layerStartInput.inputValue()).toBe('1');
  await expect(layerEndInput).toHaveValue('1');
  await expect(singleLayerToggle).toHaveAttribute('aria-pressed', 'true');
  await singleLayerToggle.click();
  await expect(singleLayerToggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => Number(await layerInputs.nth(0).inputValue()) <= Number(await layerInputs.nth(1).inputValue())).toBe(true);

  const currentLayer = await layerEndInput.inputValue();
  await layerEndInput.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => layerEndInput.inputValue()).not.toBe(currentLayer);
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

test('multi-plate Prepare grid interactions use authoritative plates and preserve camera', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({
      version: 1,
      projectLoadBehaviour: 'always_ask',
      selectedProfiles: {},
      ui: {},
    }));
  });
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('plate-controls')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('delete-plate')).toBeDisabled();
  const readBeds = () => page.evaluate(() =>
    (window as unknown as {
      __orcaE2e?: {
        bedPlateStates?: () => Array<{
          plateId?: string;
          current: boolean;
          outOfBounds: boolean;
          position: [number, number, number];
        }>;
      };
    }).__orcaE2e?.bedPlateStates?.() ?? [],
  );
  const readModels = () => page.evaluate(() =>
    (window as unknown as { __orcaE2e?: { modelWorldCenters?: () => Array<[number, number, number]> } })
      .__orcaE2e?.modelWorldCenters?.() ?? [],
  );
  const readCamera = () => page.evaluate(() => {
    const value = (window as unknown as { __orcaE2e?: { cameraState?: () => { position: number[]; target: number[] } } }).__orcaE2e?.cameraState?.();
    if (!value) return undefined;
    const round = (n: number) => Math.round(n * 100) / 100;
    return { position: value.position.map(round), target: value.target.map(round) };
  });
  const clickWorld = async (point: [number, number, number]) => {
    const projected = await page.evaluate((p) =>
      (window as unknown as { __orcaE2e?: { projectWorldToScreen?: (q: [number, number, number]) => { x: number; y: number } | null } })
        .__orcaE2e?.projectWorldToScreen?.(p) ?? null,
      point,
    );
    expect(projected).not.toBeNull();
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    if (!box || !projected) throw new Error('viewport projection is unavailable');
    await page.mouse.click(box.x + projected.x, box.y + projected.y);
  };
  const clickBed = async (index: number) => {
    const beds = await readBeds();
    const bed = beds[index];
    if (!bed) throw new Error(`missing bed ${index}`);
    await clickWorld([bed.position[0] + 200, bed.position[1] + 200, bed.position[2]]);
  };

  await page.locator('#app-tab-preview').click();
  await expect.poll(readBeds).toHaveLength(1);
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('plate-controls')).toBeVisible();
  await expect.poll(readBeds).toHaveLength(1);

  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
  await expect.poll(readModels).not.toHaveLength(0);

  await expect.poll(readCamera).not.toBeUndefined();
  const cameraBefore = await readCamera();
  await page.getByTestId('add-plate').click();
  await expect(page.getByTestId('current-plate-label')).toHaveText('Plate 2 (2/36)');
  await expect.poll(readCamera).toEqual(cameraBefore);

  // Preview deliberately keeps only the selected authoritative bed after
  // Prepare has added another plate. Switching back restores the full
  // Prepare grid and its current-plate context.
  await page.locator('#app-tab-preview').click();
  await expect.poll(readBeds).toHaveLength(1);
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('plate-controls')).toBeVisible();
  await expect.poll(readBeds).toHaveLength(2);

  await clickBed(0);
  await expect(page.getByTestId('current-plate-label')).toHaveText('Plate 1 (2/36)');
  await clickBed(1);
  await expect(page.getByTestId('current-plate-label')).toHaveText('Plate 2 (2/36)');
  const modelCenter = (await readModels())[0];
  if (!modelCenter) throw new Error('model center is unavailable');
  await clickWorld(modelCenter);
  await expect(page.getByTestId('current-plate-label')).toHaveText('Plate 2 (2/36)');

  await page.getByTestId('add-plate').click();
  await expect(page.getByTestId('current-plate-label')).toHaveText('Plate 3 (3/36)');
  const bedsBeforeReflow = await readBeds();
  const plate3Before = bedsBeforeReflow[2];
  if (!plate3Before?.plateId) throw new Error('third plate identity is unavailable');
  const secondChooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await secondChooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect.poll(readModels).toHaveLength(2);
  const modelsBeforeReflow = await readModels();
  await clickBed(1);
  await expect(page.getByTestId('current-plate-label')).toHaveText('Plate 2 (3/36)');
  await page.getByTestId('delete-plate').click();
  await expect.poll(readBeds).toHaveLength(2);
  const bedsAfterReflow = await readBeds();
  const plate3After = bedsAfterReflow.find((bed) => bed.plateId === plate3Before.plateId);
  if (!plate3After) throw new Error('reflowed third plate identity is unavailable');
  expect(bedsAfterReflow.find((bed) => bed.current)?.plateId).toBe(plate3Before.plateId);
  await expect(page.getByTestId('current-plate-label')).toHaveText('Plate 3 (2/36)');
  const modelsAfterReflow = await readModels();
  expect(modelsAfterReflow).toHaveLength(modelsBeforeReflow.length);
  expect(modelsAfterReflow[1][0] - modelsBeforeReflow[1][0])
    .toBeCloseTo(plate3After.position[0] - plate3Before.position[0], 4);
  expect(modelsAfterReflow[1][1] - modelsBeforeReflow[1][1])
    .toBeCloseTo(plate3After.position[1] - plate3Before.position[1], 4);
  await expect.poll(readCamera).toEqual(cameraBefore);

  for (let count = 3; count <= 36; count += 1) {
    await page.getByTestId('add-plate').click();
    await expect(page.getByTestId('current-plate-label')).toHaveText(`Plate ${count} (${count}/36)`);
  }
  await expect(page.getByTestId('current-plate-label')).toHaveText('Plate 36 (36/36)');
  await expect(page.getByTestId('add-plate')).toBeDisabled();
});

test('multi-plate Preview renders only the current plate and applies its local toolpath origin', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({
      version: 1,
      projectLoadBehaviour: 'always_ask',
      selectedProfiles: {},
      ui: {},
    }));
  });
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('plate-controls')).toBeVisible({ timeout: 120_000 });

  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await chooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
  await page.getByTestId('add-plate').click();
  await expect(page.getByTestId('current-plate-label')).toHaveText('Plate 2 (2/36)');
  const beds = await page.evaluate(() => (window as unknown as {
    __orcaE2e?: { bedPlateStates?: () => Array<{ plateId?: string; current: boolean; position: [number, number, number] }> };
  }).__orcaE2e?.bedPlateStates?.() ?? []);
  const plate1 = beds.find((bed) => !bed.current);
  const plate2 = beds.find((bed) => bed.current);
  if (!plate1?.plateId || !plate2?.plateId) throw new Error('multi-plate identities are unavailable');

  const secondChooser = page.waitForEvent('filechooser');
  await page.getByTestId('btn-add-model').click();
  await (await secondChooser).setFiles(resolve(here, '../../../packages/slicer-wasm/fixtures/cube.stl'));
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
  await page.getByTestId('btn-slice').click();
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });

  await page.locator('#app-tab-preview').click();
  await expect(page.getByTestId('preview-controls')).toBeVisible({ timeout: 30_000 });
  const readBeds = () => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { bedPlateStates?: () => Array<{ plateId?: string; current: boolean; position: [number, number, number] }> };
  }).__orcaE2e?.bedPlateStates?.() ?? []);
  const readModels = () => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { modelWorldCenters?: () => Array<[number, number, number]> };
  }).__orcaE2e?.modelWorldCenters?.() ?? []);
  const readToolpathOrigin = () => page.evaluate(() => (window as unknown as {
    __orcaE2e?: { previewToolpathWorldOrigin?: () => [number, number, number] | null };
  }).__orcaE2e?.previewToolpathWorldOrigin?.() ?? null);

  await expect.poll(readBeds).toEqual([
    expect.objectContaining({ plateId: plate2.plateId, current: true }),
  ]);
  await expect.poll(readModels).toHaveLength(1);
  await expect.poll(readToolpathOrigin).toEqual([plate2.position[0], plate2.position[1], 0]);

  // Preview exposes the same authoritative plate selection transaction in its
  // left sidebar. The first plate is valid but unsliced, so selecting it must
  // retain Preview and let the existing coordinator slice that target.
  const plateList = page.getByTestId('preview-plate-list');
  await expect(plateList).toBeVisible();
  const plate1Option = page.getByTestId(`preview-plate-${plate1.plateId}`);
  const plate2Option = page.getByTestId(`preview-plate-${plate2.plateId}`);
  await expect(plate2Option).toHaveAttribute('aria-selected', 'true');
  await expect(plate2Option).toHaveAttribute('data-plate-status', 'sliced');
  await expect(plate1Option).toHaveAttribute('data-plate-status', 'unsliced');
  await plate1Option.click();
  await expect(plate1Option).toHaveAttribute('aria-selected', 'true');
  await expect(plate2Option).toHaveAttribute('aria-selected', 'false');
  await expect.poll(readBeds).toEqual([
    expect.objectContaining({ plateId: plate1.plateId, current: true }),
  ]);
  await expect.poll(readModels).toHaveLength(1);
  await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
  await expect.poll(readToolpathOrigin).toEqual([plate1.position[0], plate1.position[1], 0]);
  await expect(plate1Option).toHaveAttribute('data-plate-status', 'sliced');
});

test('GPU streaming preview: native renderer is the default backend', async ({ page }) => {
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
    return status === 'ready' || (status === 'unavailable' && Boolean(hooks?.gpuStreamingDiagnostic?.()?.reason));
  }), { timeout: 20_000 }).toBe(true);
});
