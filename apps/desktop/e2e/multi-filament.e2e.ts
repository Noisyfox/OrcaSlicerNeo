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

test('new project slots remain assignable after adding Cube and opening its context menu', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('preset-select')).toBeVisible();

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
    await expect(objectRow).toBeVisible();
    await objectRow.click({ button: 'right' });
    await expect(page.getByTestId('objectlist-ctx-menu')).toBeVisible();

    await page.getByTestId('objectlist-change-filament-2').click();
    await expect(page.getByTestId('objectlist-ctx-menu')).toBeHidden();
    await expect(page.getByTestId('filament-rejected')).toBeHidden();
    await expect.poll(async () => page.locator('[data-testid^="filament-cell-object-"]').first().inputValue()).toBe('2');
  } finally {
    await app.close();
  }
});
