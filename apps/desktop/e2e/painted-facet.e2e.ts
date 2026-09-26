import { _electron, expect, test } from '@playwright/test';
import { resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');

test('Prepare painted model uses original BVH for selection and dragging', async () => {
  test.skip(process.env.VITE_MOCK_PAINTED_FACET_FIXTURE !== '1',
    'build with VITE_MOCK_PAINTED_FACET_FIXTURE=1 to provide a painted mock model');
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: MODEL_PATH,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled();

    const readResources = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelPaintResources?: () => Array<{
        id: string;
        objectIndex: number;
        volumeIndex: number;
        instanceIndex: number;
        originalGeometryUuid: string;
        originalHasBvh: boolean;
        paintGeometryUuid: string | null;
        paintHasBvh: boolean;
        paintGroupStates: number[];
        visibleGeometryUuid: string | null;
        visibleUsesOriginalGeometry: boolean;
        visibleUsesBvhRaycast: boolean;
        paintDisplayRaycastDisabled: boolean;
        originalPickVisible: boolean | null;
        originalPickUsesBvhRaycast: boolean;
      }> } }).__orcaE2e?.modelPaintResources?.() ?? [],
    );
    const readColours = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelMaterialColours?: () => Array<{
        id: string;
        objectIndex: number;
        volumeIndex: number;
        stateId: number;
        colour: string;
      }> } }).__orcaE2e?.modelMaterialColours?.() ?? [],
    );
    const readCenters = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelWorldCenters?: () => Array<[number, number, number]> } })
        .__orcaE2e?.modelWorldCenters?.() ?? [],
    );
    const readSelection = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelSelectionIdentities?: () => Array<{
        id: string;
        objectId: number;
        volumeId: number;
        instanceId: number;
      }> } }).__orcaE2e?.modelSelectionIdentities?.() ?? [],
    );
    const projectWorld = async (point: [number, number, number]) => page.evaluate((p) =>
      (window as unknown as { __orcaE2e?: { projectWorldToScreen?: (world: [number, number, number]) => { x: number; y: number } | null } })
        .__orcaE2e?.projectWorldToScreen?.(p) ?? null,
      point,
    );

    await expect.poll(readResources, { timeout: 30_000 }).not.toHaveLength(0);
    const before = (await readResources())[0];
    if (!before) throw new Error('painted model resource is unavailable');
    expect(before).toMatchObject({
      originalHasBvh: true,
      paintHasBvh: false,
      paintGroupStates: [1],
      visibleGeometryUuid: before.paintGeometryUuid,
      visibleUsesOriginalGeometry: false,
      visibleUsesBvhRaycast: false,
      paintDisplayRaycastDisabled: true,
      originalPickVisible: false,
      originalPickUsesBvhRaycast: true,
    });
    expect(before.paintGeometryUuid).toBeTruthy();

    const readVolumeColours = async (id: string) => (await readColours()).filter((entry) => entry.id === id);
    const beforeColours = await readVolumeColours(before.id);
    expect(beforeColours).toHaveLength(1);
    expect(beforeColours[0]).toMatchObject({ id: before.id, stateId: 1 });

    // Change the authoritative slot colour through FilamentRack's real input
    // event path, then confirm React updates the material while both geometry
    // resources and the original BVH-backed object stay in place.
    await page.getByTestId('filament-colour-1').evaluate((input) => {
      const colour = input as HTMLInputElement;
      colour.value = '#2048c0';
      colour.dispatchEvent(new Event('input', { bubbles: true }));
      colour.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => readVolumeColours(before.id), { timeout: 15_000 }).not.toEqual(beforeColours);
    const afterPalette = (await readResources())[0];
    expect(afterPalette).toMatchObject({
      id: before.id,
      originalGeometryUuid: before.originalGeometryUuid,
      originalHasBvh: true,
      paintGeometryUuid: before.paintGeometryUuid,
      paintHasBvh: false,
    });

    const center = (await readCenters())[0];
    if (!center) throw new Error('model center is unavailable');
    const centerScreen = await projectWorld(center);
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    if (!centerScreen || !box) throw new Error('painted model click point is unavailable');
    await page.mouse.click(box.x + centerScreen.x, box.y + centerScreen.y);
    const expectedSelectedIds = (await readResources())
      .filter((resource) => resource.objectIndex === before.objectIndex && resource.instanceIndex === before.instanceIndex)
      .map((resource) => resource.id)
      .sort();
    expect(expectedSelectedIds).toContain(before.id);
    await expect.poll(async () => (await readSelection()).map((item) => item.id).sort(), { timeout: 10_000 })
      .toEqual(expectedSelectedIds);

    // Drag from a point on the same painted cube, away from the selection
    // pivot, and verify the selected native instance actually moves.
    const startWorld: [number, number, number] = [center[0] + 7, center[1] + 4, center[2] + 10];
    const dragStart = await projectWorld(startWorld);
    if (!dragStart) throw new Error('painted model drag point is unavailable');
    const beforeDrag = (await readCenters())[0];
    if (!beforeDrag) throw new Error('model center disappeared before drag');
    await page.mouse.move(box.x + dragStart.x, box.y + dragStart.y);
    await page.mouse.down();
    await page.mouse.move(box.x + dragStart.x + 65, box.y + dragStart.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(readCenters, { timeout: 10_000 }).not.toEqual([beforeDrag]);
    await expect.poll(async () => (await readSelection()).map((item) => item.id).sort()).toEqual(expectedSelectedIds);
  } finally {
    await app.close();
  }
});

test('Prepare unpainted model keeps the original single-colour BVH mesh', async () => {
  test.skip(process.env.VITE_MOCK_PAINTED_FACET_FIXTURE === '1',
    'this case uses the default unpainted mock model');
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: MODEL_PATH,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled();

    const readResources = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelPaintResources?: () => Array<{
        id: string;
        objectIndex: number;
        instanceIndex: number;
        originalHasBvh: boolean;
        paintGeometryUuid: string | null;
        paintGroupStates: number[];
        visibleGeometryUuid: string | null;
        visibleUsesOriginalGeometry: boolean;
        visibleUsesBvhRaycast: boolean;
        originalPickVisible: boolean | null;
      }> } }).__orcaE2e?.modelPaintResources?.() ?? [],
    );
    const readCenters = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelWorldCenters?: () => Array<[number, number, number]> } })
        .__orcaE2e?.modelWorldCenters?.() ?? [],
    );
    const readSelection = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelSelectionIdentities?: () => Array<{ id: string }> } })
        .__orcaE2e?.modelSelectionIdentities?.() ?? [],
    );
    const projectWorld = async (point: [number, number, number]) => page.evaluate((p) =>
      (window as unknown as { __orcaE2e?: { projectWorldToScreen?: (world: [number, number, number]) => { x: number; y: number } | null } })
        .__orcaE2e?.projectWorldToScreen?.(p) ?? null,
      point,
    );

    await expect.poll(readResources, { timeout: 30_000 }).not.toHaveLength(0);
    const resources = await readResources();
    expect(resources.every((resource) => resource.originalHasBvh
      && resource.paintGeometryUuid === null
      && resource.paintGroupStates.length === 0
      && resource.visibleUsesOriginalGeometry
      && resource.visibleGeometryUuid
      && resource.visibleUsesBvhRaycast
      && resource.originalPickVisible === null)).toBe(true);

    const target = resources[0];
    const center = (await readCenters())[0];
    if (!target || !center) throw new Error('unpainted model target is unavailable');
    const screen = await projectWorld(center);
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    if (!screen || !box) throw new Error('unpainted model click point is unavailable');
    await page.mouse.click(box.x + screen.x, box.y + screen.y);
    const expectedIds = resources
      .filter((resource) => resource.objectIndex === target.objectIndex && resource.instanceIndex === target.instanceIndex)
      .map((resource) => resource.id)
      .sort();
    await expect.poll(async () => (await readSelection()).map((item) => item.id).sort(), { timeout: 10_000 })
      .toEqual(expectedIds);
  } finally {
    await app.close();
  }
});
