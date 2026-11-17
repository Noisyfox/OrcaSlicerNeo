import { expect, type Page } from '@playwright/test';
import { booleanMeshes } from './mesh-boolean-journey';

/** Host-neutral UI inputs; scene probes only read identities and world bounds. */
export async function assemblyJourney(page: Page, addModel: () => Promise<void>) {
  await addModel();
  await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
  await addModel();
  await page.getByTestId('config-mode-scoped').click();
  const list = page.getByTestId('object-list');
  const rows = list.getByTestId(/^object-\d+$/);
  await expect(rows).toHaveCount(2);
  const ids = (await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')!)))
    .map(id => Number(id.replace('object-', '')));
  for (const id of ids) {
    const row = list.getByTestId(`object-${id}`);
    if (new Set((await booleanMeshes(page)).filter(mesh => mesh.objectId === id).map(mesh => mesh.instanceId)).size < 2) {
      await row.getByRole('button').first().click({ button: 'right' });
      await page.getByTestId('objectlist-add-instance').click();
    }
    await list.getByTestId(`object-expand-${id}`).click();
    await expect(row.locator('[data-testid^="instance-"]')).toHaveCount(2);
  }
  const a = list.getByTestId(`object-${ids[0]}`), b = list.getByTestId(`object-${ids[1]}`);
  const aInstance = a.locator('[data-testid^="instance-"]').nth(1);
  const bInstance = b.locator('[data-testid^="instance-"]').first();
  const selectedIds = new Set([
    Number((await aInstance.getAttribute('data-testid'))!.replace('instance-', '')),
    Number((await bInstance.getAttribute('data-testid'))!.replace('instance-', '')),
  ]);
  const before = await booleanMeshes(page);
  await aInstance.click(); await bInstance.click({ modifiers: ['ControlOrMeta'] });
  await bInstance.click({ button: 'right' });
  await expect(page.getByTestId('objectlist-assemble')).toBeVisible();
  await page.getByTestId('objectlist-assemble').click();
  await expect(rows).toHaveCount(3);
  await expect.poll(async () => new Set((await booleanMeshes(page)).map(mesh => mesh.objectId)).size).toBe(3);
  const after = await booleanMeshes(page);
  const kept = before.filter(mesh => !selectedIds.has(mesh.instanceId));
  expect(after.filter(mesh => ids.includes(mesh.objectId))).toEqual(kept);
  const result = after.filter(mesh => !ids.includes(mesh.objectId));
  expect(new Set(result.map(mesh => mesh.instanceId)).size).toBe(1);
  expect(result.length).toBe(before.length - kept.length);
  const bounds = (meshes: typeof before) => meshes.map(mesh => JSON.stringify({ min: mesh.bounds.min.map(v => Math.round(v * 1e5) / 1e5), max: mesh.bounds.max.map(v => Math.round(v * 1e5) / 1e5) })).sort();
  expect(bounds(result)).toEqual(bounds(before.filter(mesh => selectedIds.has(mesh.instanceId))));
  await page.getByTestId('history-undo').click();
  await expect(rows).toHaveCount(2);
  await expect.poll(() => booleanMeshes(page)).toEqual(before);
  await page.getByTestId('history-redo').click();
  await expect(rows).toHaveCount(3);
  await expect.poll(() => booleanMeshes(page)).toEqual(after);
}
