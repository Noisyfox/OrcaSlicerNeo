import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');

async function launchApp(): Promise<ElectronApplication> {
  const env = { ...process.env, ORCA_E2E: '1' } as Record<string, string>;
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
  const before = await page.getByTestId('move-x').inputValue();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 32, start.y + 16, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.getByTestId('move-x').inputValue(), { timeout: 10_000 }).not.toBe(before);
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
