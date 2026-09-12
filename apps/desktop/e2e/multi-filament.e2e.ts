import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const REAL = process.env.ORCA_E2E_REAL === '1';
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');

async function launchApp(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  const env = { ...process.env, ORCA_E2E: '1', ...extraEnv } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
}

async function addPrimitive(page: Page, primitive: string): Promise<void> {
  const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewport canvas has no bounding box');
  await page.mouse.click(box.x + box.width - 40, box.y + 40, { button: 'right' });
  await expect(page.getByTestId('ctx-menu')).toBeVisible();
  await page.getByTestId('btn-add-primitive').click();
  await expect(page.getByTestId('ctx-primitive-menu')).toBeVisible();
  await page.getByTestId(`btn-add-${primitive.toLowerCase()}`).click();
  await expect(page.getByTestId('ctx-menu')).toBeHidden();
}

async function dragCubeOnce(page: Page): Promise<void> {
  const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewport canvas has no bounding box');
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as {
      __orcaE2e?: { modelWorldCenters?: () => Array<[number, number, number]> };
    }).__orcaE2e?.modelWorldCenters?.() ?? [],
  ), { timeout: 30_000 }).not.toHaveLength(0);
  const worldCenter = await page.evaluate(() =>
    (window as unknown as {
      __orcaE2e?: { modelWorldCenters?: () => Array<[number, number, number]> };
    }).__orcaE2e?.modelWorldCenters?.()[0] ?? null,
  );
  const point = worldCenter && await page.evaluate((p) =>
    (window as unknown as {
      __orcaE2e?: { projectWorldToScreen(q: [number, number, number]): { x: number; y: number } | null };
    }).__orcaE2e?.projectWorldToScreen(p),
    worldCenter,
  );
  if (!point) throw new Error('added cube center projection unavailable');
  const start = { x: box.x + point.x, y: box.y + point.y };
  await page.mouse.click(start.x, start.y);
  await expect(page.getByTestId('gizmo-btn-move')).toBeEnabled();
  await page.getByTestId('gizmo-btn-move').click();
  await page.getByTestId('move-x').fill('80');
  await page.getByTestId('move-x').press('Enter');
  await expect(page.getByTestId('move-x')).toHaveValue(/80(?:\.000)?/);
}

test('new project slots remain assignable from the ObjectList select and context menu', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('preset-select')).toBeVisible();
    await expect(page.getByTestId('filament-rack')).toBeVisible();
    await expect(page.getByTestId('filament-slot-1')).toBeVisible();
    await expect(page.getByTestId('filament-preset-select')).toHaveCount(0);

    await page.getByTestId('menu-file-trigger').click();
    await page.getByTestId('file-new-project').click();
    await expect(page.getByTestId('filament-rack')).toBeVisible();
    await expect(page.getByTestId('filament-slot-1')).toBeVisible();

    for (const slot of [2, 3, 4]) {
      await page.getByTestId('filament-add').click();
      await expect(page.getByTestId(`filament-slot-${slot}`)).toBeVisible();
    }

    await addPrimitive(page, 'cube');
    await expect(page.getByTestId('btn-slice')).toBeEnabled();
    const objectRow = page.locator('[data-testid^="object-"]').first();
    const filamentSelect = page.locator('[data-testid^="filament-cell-object-"]').first();
    await expect(objectRow).toBeVisible();
    await expect(filamentSelect).toHaveAttribute('data-slot', 'select-trigger');
    await expect(filamentSelect).toHaveAttribute('role', 'combobox');
    await expect(page.locator('select[data-testid^="filament-cell-object-"]')).toHaveCount(0);

    await filamentSelect.click();
    await page.getByRole('option', { name: 'Slot 2', exact: true }).click();
    await expect(filamentSelect).toContainText('Slot 2');
    await expect(page.getByTestId('objectlist-ctx-menu')).toBeHidden();

    await objectRow.click({ button: 'right' });
    await expect(page.getByTestId('objectlist-ctx-menu')).toBeVisible();

    await page.getByTestId('objectlist-change-filament-3').click();
    await expect(page.getByTestId('objectlist-ctx-menu')).toBeHidden();
    await expect(page.getByTestId('filament-rejected')).toBeHidden();
    await expect(filamentSelect).toContainText('Slot 3');
  } finally {
    await app.close();
  }
});

test('adds a filament after two cubes from the scene context menu', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('filament-slot-1')).toBeVisible();

    const objectRows = page.getByTestId('object-list').locator(
      'section[data-testid^="plate-group-"] > div[data-testid^="object-"]',
    );
    const initialObjectCount = await objectRows.count();
    await addPrimitive(page, 'cube');
    await addPrimitive(page, 'cube');
    await expect.poll(() => objectRows.count(), { timeout: 30_000 }).toBe(initialObjectCount + 2);

    await page.getByTestId('filament-add').click();
    await expect(page.getByTestId('filament-slot-2')).toBeVisible();
    await expect(page.getByTestId('filament-rejected')).toBeHidden();
  } finally {
    await app.close();
  }
});

test('adds a filament after a scene cube has been moved', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('filament-slot-1')).toBeVisible();

    await addPrimitive(page, 'cube');
    await dragCubeOnce(page);
    await page.getByTestId('filament-add').click();
    await expect(page.getByTestId('filament-slot-2')).toBeVisible();
    await expect(page.getByTestId('filament-rejected')).toBeHidden();
  } finally {
    await app.close();
  }
});

test.skip(!REAL, 'requires ORCA_E2E_REAL=1 and the threaded WASM acceptance runner');
test('filament rack remains enabled during history restore', async () => {
  const app = await launchApp({ ORCA_E2E_MODEL: MODEL_PATH });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('filament-add')).toBeEnabled({ timeout: 30_000 });

    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 60_000 });
    const undo = page.getByTestId('history-undo');
    const redo = page.getByTestId('history-redo');
    await expect(undo).toBeEnabled({ timeout: 30_000 });

    // Observe every disabled-state transition during the real restore. The
    // project lease may queue work, but it must never turn the rack into a
    // read-only surface. The only operation clicked here is the history
    // restore itself; Add Filament is intentionally never dispatched.
    const installDisabledObserver = () => page.evaluate(() => {
      const button = document.querySelector('[data-testid="filament-add"]') as HTMLButtonElement | null;
      if (!button) throw new Error('filament add control is missing');
      const states = [button.disabled];
      const observer = new MutationObserver(() => states.push(button.disabled));
      observer.observe(button, { attributes: true, attributeFilter: ['disabled'] });
      (window as unknown as { __orcaRackDisabledStates?: boolean[]; __orcaStopRackObserver?: () => void }).__orcaRackDisabledStates = states;
      (window as unknown as { __orcaStopRackObserver?: () => void }).__orcaStopRackObserver = () => observer.disconnect();
    });
    const readDisabledStates = () => page.evaluate(() => {
      const w = window as unknown as { __orcaRackDisabledStates?: boolean[]; __orcaStopRackObserver?: () => void };
      w.__orcaStopRackObserver?.();
      return w.__orcaRackDisabledStates ?? [];
    });

    await installDisabledObserver();
    await undo.click();
    await expect(redo).toBeEnabled({ timeout: 60_000 });
    expect((await readDisabledStates()).some(Boolean)).toBe(false);

    await installDisabledObserver();
    await redo.click();
    await expect(undo).toBeEnabled({ timeout: 60_000 });
    expect((await readDisabledStates()).some(Boolean)).toBe(false);
  } finally {
    await app.close();
  }
});

test.skip(!REAL, 'requires ORCA_E2E_REAL=1 and the threaded WASM acceptance runner');
test('two assigned cubes keep both tools and colors in the real G-code preview', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.getByTestId('menu-file-trigger').click();
    await page.getByTestId('file-new-project').click();
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('filament-slot-1')).toBeVisible();
    await page.getByTestId('preset-select').click();
    await page.getByRole('option', { name: 'Bambu Lab X1 Carbon 0.4 nozzle', exact: true }).click();
    await expect(page.getByTestId('preset-select')).toContainText('Bambu Lab X1 Carbon 0.4 nozzle');

    await addPrimitive(page, 'cube');
    await addPrimitive(page, 'cube');
    await dragCubeOnce(page);
    await expect(page.locator('[data-testid^="filament-cell-object-"]')).toHaveCount(2);
    await page.getByTestId('filament-add').click();
    await expect(page.getByTestId('filament-slot-2')).toBeVisible();

    // Use the same native colour mutation as the rack, with deterministic
    // values so the bridge palette and uploaded GPU colours are exact.
    for (const [slot, colour] of [[1, '#ff0000'], [2, '#0000ff']] as const) {
      const input = page.getByTestId(`filament-colour-${slot}`);
      await input.evaluate((element, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, colour);
      await expect(input).toHaveValue(colour);
      await expect(page.getByTestId(`filament-slot-${slot}`)).toHaveAttribute('aria-busy', 'false');
    }

    const assignments = page.locator('[data-testid^="filament-cell-object-"]');
    await assignments.nth(0).click();
    await page.locator('[role="option"]:visible').filter({ hasText: /^Slot 1$/ }).first().click();
    await assignments.nth(1).click();
    await page.locator('[role="option"]:visible').filter({ hasText: /^Slot 2$/ }).last().click();
    await expect(assignments.nth(1)).toContainText('Slot 2');

    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 300_000 });
    await expect(page.getByTestId('preview-controls')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('preview-color-scheme').click();
    await page.getByTestId('preview-color-scheme-filament').click();
    await expect(page.getByTestId('preview-scheme-visibility-filament-0')).toBeVisible();
    await expect(page.getByTestId('preview-scheme-visibility-filament-1')).toBeVisible();

    const evidence = () => page.evaluate(() => (window as unknown as {
      __orcaE2e?: {
        previewEvidence?: () => {
          extrusionTools: number[];
          toolChanges: number[];
          palette: Array<{ tool: number; color: number[] }>;
          renderedColors: Array<[number, number, number]>;
        } | null;
      };
    }).__orcaE2e?.previewEvidence?.() ?? null);
    await expect.poll(evidence, { timeout: 30_000 }).toEqual(expect.objectContaining({
      extrusionTools: expect.arrayContaining([0, 1]),
      toolChanges: expect.arrayContaining([1]),
      palette: expect.arrayContaining([
        expect.objectContaining({ tool: 0, color: [255, 0, 0] }),
        expect.objectContaining({ tool: 1, color: [0, 0, 255] }),
      ]),
      renderedColors: expect.arrayContaining([
        [1, 0, 0],
        [0, 0, 1],
      ]),
    }));
  } finally {
    await app.close();
  }
});
