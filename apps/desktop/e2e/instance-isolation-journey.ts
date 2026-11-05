import { expect, type Page, type TestInfo } from '@playwright/test';
import { history, ready } from './arrangement-journey';

type Target = { objectId: number; instanceId: number };
type Source = Target & { id: string; center: [number, number, number]; geometry: string; hasBvh: boolean;
  disposals: number; paintGeometry: string | null; paintDisposals: number };
type Evidence = { target: Target | null; models: string[]; painting: string[]; towers: string[]; sources: Source[]; selection: string[] };
const read = (page: Page): Promise<Evidence> => page.evaluate(() => (window as any).__orcaE2e.instanceIsolationEvidence());
const hits = (page: Page, point: [number, number, number]): Promise<string[]> => page.evaluate(point =>
  (window as any).__orcaE2e.instanceIsolationRaycast(point), point);

/** One real scene contains painted Parts, two instances, another object and a
 * Prime Tower. All state changes use product UI; the probe only reads facts. */
export async function instanceIsolationJourney(page: Page, openProject: () => Promise<void>, info: TestInfo) {
  await ready(page); page.setDefaultTimeout(15_000); await openProject();
  const loadVisible = () => page.evaluate(() => !!document.querySelector('[data-testid="project-load-choice-dialog"], [data-testid="project-load-confirmation-dialog"], [data-testid="project-progress-dialog"]') || !!(window as any).__orcaE2e?.projectLoadEvidence?.().receipt);
  await expect.poll(loadVisible).toBe(true);
  if (await page.getByTestId('project-load-choice-dialog').isVisible()) {
    await page.getByTestId('project-load-project').click(); await page.getByTestId('project-load-confirm').click();
  }
  await expect.poll(() => page.evaluate(() => !!document.querySelector('[data-testid="project-load-confirmation-dialog"]') || !!(window as any).__orcaE2e?.projectLoadEvidence?.().receipt), { timeout: 120_000 }).toBe(true);
  if (await page.getByTestId('project-load-confirmation-dialog').isVisible()) await page.getByTestId('project-load-confirmation-dialog-continue').click();
  await expect(page.getByTestId('project-progress-dialog')).toHaveCount(0);
  await expect.poll(async () => (await read(page)).sources.length).toBe(2);
  const initial = await read(page), objectId = initial.sources[0].objectId;
  const instances = [...new Set(initial.sources.map(source => source.instanceId))].sort((a, b) => a - b);
  expect(instances).toHaveLength(2);
  await page.getByTestId('config-page-Multi.').click();
  await page.getByTestId('config-field-enable_prime_tower').getByRole('checkbox').check();
  await page.getByTestId('config-mode-scoped').click();
  const selectInstance = async (instanceId: number) => {
    if (await page.getByTestId(`instances-${objectId}`).count() === 0) await page.getByTestId(`object-expand-${objectId}`).click();
    if (await page.getByTestId(`instance-${instanceId}`).count() === 0) await page.getByTestId(`instances-toggle-${objectId}`).click();
    await page.getByTestId(`instance-${instanceId}`).getByRole('button').click();
  };
  await selectInstance(instances[0]);
  await page.getByTestId(`object-${objectId}`).getByRole('button').first().click({ button: 'right' });
  await page.getByTestId('objectlist-add-model_part').click();
  await page.getByTestId('objectlist-add-model_part-Cube').click();
  await expect.poll(async () => (await read(page)).sources.length).toBe(4);
  const viewport = page.getByTestId('viewport'), bounds = await viewport.boundingBox();
  await page.mouse.click(bounds!.x + bounds!.width - 40, bounds!.y + 80, { button: 'right' });
  await page.getByTestId('btn-add-primitive').click(); await page.getByTestId('btn-add-cube').click();
  await expect.poll(async () => (await read(page)).sources.length).toBe(5);
  const unrelatedObject = (await read(page)).sources.find(source => source.objectId !== objectId)!.objectId;
  await page.getByTestId(`object-${unrelatedObject}`).getByRole('button').first().click();
  await page.getByTestId('gizmo-btn-move').click();
  for (const [axis, value] of [['x', '160'], ['y', '40']]) {
    const before = (await history(page)).undoEntries.length, input = page.getByTestId(`move-${axis}`);
    await input.fill(value); await input.press('Enter');
    await expect.poll(async () => (await history(page)).undoEntries.length).toBe(before + 1);
  }
  await page.getByTestId('gizmo-btn-move').click();
  await selectInstance(instances[0]);
  await page.evaluate(() => (window as any).__orcaE2e.setCameraView([128, 128, 400], [128, 128, 0]));
  await expect.poll(async () => (await read(page)).towers.length).toBe(1);
  const baseline = await read(page), allIds = baseline.sources.map(source => source.id).sort();
  await info.attach('instance-isolation-baseline', { body: JSON.stringify(baseline, null, 2), contentType: 'application/json' });
  expect(baseline.models).toEqual(allIds);
  expect(baseline.sources.every(source => source.hasBvh && source.disposals === 0 && source.paintDisposals === 0)).toBe(true);
  const first = baseline.sources.find(source => source.instanceId === instances[0])!;
  const hiddenPoint = baseline.sources.find(source => source.instanceId === instances[1])!.center;
  const initialHits = await hits(page, hiddenPoint);
  expect(initialHits.some(id => baseline.sources.some(source => source.id === id && source.instanceId === instances[1]))).toBe(true);
  const beforeHistory = await history(page), observations: Record<string, Evidence> = { baseline };
  const paintingButtons = ['gizmo-btn-paint', 'gizmo-btn-support', 'gizmo-btn-seam', 'gizmo-btn-fuzzy'];
  const ids = (instanceId: number) => baseline.sources.filter(source => source.objectId === objectId && source.instanceId === instanceId).map(source => source.id).sort();
  const isolated = async (instanceId: number, painting: boolean) => {
    await expect.poll(async () => {
      const evidence = await read(page);
      return { target: evidence.target, models: evidence.models, painting: evidence.painting, towers: evidence.towers };
    }).toEqual({ target: { objectId, instanceId }, models: painting ? [] : ids(instanceId), painting: painting ? [`${objectId}:${instanceId}`] : [], towers: [] });
    expect((await read(page)).sources).toEqual(baseline.sources);
  };
  const restored = async () => {
    await expect.poll(async () => {
      const evidence = await read(page);
      return { target: evidence.target, models: evidence.models, painting: evidence.painting, towers: evidence.towers };
    }).toEqual({ target: null, models: allIds, painting: [], towers: baseline.towers });
    expect((await read(page)).sources).toEqual(baseline.sources);
    expect(await hits(page, hiddenPoint)).toEqual(initialHits);
  };
  await page.screenshot({ path: info.outputPath('isolation-all-instances-and-tower.png') });
  for (const channel of ['mmu', 'support', 'seam', 'fuzzy']) {
    await selectInstance(instances[0]);
    await page.getByTestId('gizmo-btn-mesh-boolean').click(); await isolated(instances[0], false);
    // A visible Part can overlap the other instance in projection. The ray
    // may still hit it, but must never return any hidden source identity.
    expect((await hits(page, hiddenPoint)).filter(id => !ids(instances[0]).includes(id)), 'hidden painted pick meshes cannot receive a ray').toEqual([]);
    const paintingButton = channel === 'mmu' ? 'gizmo-btn-paint' : `gizmo-btn-${channel}`;
    await page.getByTestId(paintingButton).click();
    await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle'); await isolated(instances[0], true);
    await selectInstance(instances[1]);
    await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle'); await isolated(instances[1], true);
    observations[channel] = await read(page);
    await page.getByTestId('gizmo-btn-mesh-boolean').click();
    await expect(page.getByTestId('painting-panel')).toHaveCount(0); await isolated(instances[1], false);
    await expect(page.getByTestId('gizmo-btn-mesh-boolean')).toHaveAttribute('aria-pressed', 'true');
    for (const button of paintingButtons) await expect(page.getByTestId(button)).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('slicer-status').hover();
    await page.screenshot({ path: info.outputPath(`isolation-${channel}-to-boolean.png`) });
    await page.getByTestId('gizmo-btn-move').click(); await restored();
    await page.getByTestId('gizmo-btn-move').click();
    await expect(page.getByTestId('gizmo-btn-mesh-boolean')).toHaveAttribute('aria-pressed', 'false');
  }
  // A real restored BVH click still selects a complete instance after all
  // painting/Boolean swaps, rather than selecting only the retained Part.
  await selectInstance(instances[1]);
  const point = await page.evaluate(point => (window as any).__orcaE2e.projectWorldToScreen(point), first.center);
  const canvas = await viewport.locator('canvas[data-engine^="three.js"]').boundingBox();
  await page.mouse.click(canvas!.x + point.x, canvas!.y + point.y);
  await expect.poll(async () => (await read(page)).selection).toEqual(ids(instances[0]));
  const afterHistory = await history(page);
  expect(afterHistory.undoEntries).toEqual(beforeHistory.undoEntries);
  expect(afterHistory.redoEntries).toEqual(beforeHistory.redoEntries);
  observations.restored = await read(page);
  await page.screenshot({ path: info.outputPath('isolation-restored-source-bvh.png') });
  await info.attach('instance-isolation-evidence', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' });
}
