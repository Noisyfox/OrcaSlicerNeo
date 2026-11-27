import { expect as baseExpect, type Page } from '@playwright/test';
import { ready } from './arrangement-journey';
import { addPrimitive } from './add-primitive';

const expect = baseExpect.configure({ timeout: 30_000 });

export async function verifyLayerHeight(page: Page) {
  page.on('pageerror', error => console.error('Prepare renderer:', error.message));
  await ready(page);
  await page.getByTestId('config-mode-scoped').click();
  const tool = page.getByTestId('gizmo-btn-layer-height');
  await expect(tool).toBeDisabled();
  await addPrimitive(page, 'Sphere');
  await page.getByTestId('object-list').getByTestId(/^object-\d+$/).first().getByRole('button').first().click();
  await tool.click();
  const panel = page.getByRole('region', { name: 'Variable layer height' });
  const bar = page.getByTestId('layer-height-bar');
  await expect(bar).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Reset' })).toBeDisabled();
  const box = await bar.boundingBox();
  if (!box) throw new Error('Missing layer height bar');
  const pixel = () => bar.evaluate(el => (el as HTMLCanvasElement).toDataURL());
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  const initial = await pixel();
  await page.mouse.down();
  await expect.poll(pixel).not.toBe(initial);
  const first = await pixel();
  await expect.poll(pixel).not.toBe(first);
  await page.mouse.move(x - box.width * 2, y - 15);
  await page.mouse.up();
  const reset = panel.getByRole('button', { name: 'Reset' });
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect(reset).toBeDisabled();
  await panel.getByRole('button', { name: 'Adaptive' }).click();
  await expect(reset).toBeEnabled();
  await panel.getByRole('button', { name: 'Smooth', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Done' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(bar).toHaveCount(0);
  await tool.click();
  await expect(reset).toBeEnabled();
}
