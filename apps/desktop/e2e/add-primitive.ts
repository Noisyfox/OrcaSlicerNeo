import { expect, type Page } from '@playwright/test';

export async function addPrimitive(page: Page, primitive: string): Promise<void> {
  const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewport canvas has no bounding box');
  const fps = await page.locator('.scene-stats').boundingBox();
  const y = Math.max(box.y + 40, fps ? fps.y + fps.height + 16 : box.y + 40);
  await page.mouse.click(box.x + box.width - 40, y, { button: 'right' });
  await expect(page.getByTestId('ctx-menu')).toBeVisible();
  await page.getByTestId('btn-add-primitive').click();
  await expect(page.getByTestId('ctx-primitive-menu')).toBeVisible();
  const objectRows = page.getByTestId('object-list').locator('section[data-testid^="plate-group-"] > div[data-testid^="object-"]');
  const before = await objectRows.count();
  await page.getByTestId(`btn-add-${primitive.toLowerCase()}`).click();
  await expect(page.getByTestId('ctx-menu')).toBeHidden();
  await expect.poll(() => objectRows.count()).toBe(before + 1);
}
