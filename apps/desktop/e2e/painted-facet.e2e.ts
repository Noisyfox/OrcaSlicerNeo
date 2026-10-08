import { _electron, expect, test } from '@playwright/test';
import { resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');

test('real Benchy outline keeps uniform face normals without triangular streaks', async () => {
  test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires a real WASM renderer build');
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_MODEL: resolve(DESKTOP_ROOT,
    '../../packages/slicer-wasm/cpp/resources/handy_models/3DBenchy.drc') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
    const read = () => page.evaluate(() => (window as unknown as { __orcaE2e?: {
      modelPaintResources?: () => Array<{ originalTriangleCount: number;
        selectionOutlines: Array<{ uniformTriangleNormals: boolean; sharedGeometry: boolean; raycastDisabled: boolean }> }>;
    } }).__orcaE2e?.modelPaintResources?.() ?? []);
    await expect.poll(async () => (await read())[0]?.originalTriangleCount).toBeGreaterThan(1000);
    await page.getByTestId('config-mode-scoped').click();
    await page.getByTestId('object-list')
      .locator('div[data-testid^="object-"]:not([data-testid="object-list"])').first().click();
    await expect.poll(async () => (await read())[0]?.selectionOutlines).toEqual([
      expect.objectContaining({ uniformTriangleNormals: true, sharedGeometry: false, raycastDisabled: true }),
    ]);
    const centre = await page.evaluate(() => (window as unknown as { __orcaE2e?: {
      modelWorldCenters?: () => Array<[number, number, number]>;
    } }).__orcaE2e?.modelWorldCenters?.()[0]);
    if (!centre) throw new Error('real Benchy centre unavailable');
    for (const [name, offset] of [['roof', [-60, -70, 90]], ['side', [70, -90, 65]]] as const) {
      await page.evaluate(({ centre, offset }) => (window as unknown as { __orcaE2e?: {
        setCameraView?: (position: [number, number, number], target: [number, number, number]) => void;
      } }).__orcaE2e?.setCameraView?.([
        centre[0] + offset[0], centre[1] + offset[1], centre[2] + offset[2],
      ], centre), { centre, offset });
      await page.screenshot({ path: test.info().outputPath(`benchy-outline-${name}.png`) });
    }
  } finally { await app.close(); }
});

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
        selectionOutlines: Array<{ colour: string; thickness: number; pixelSized: boolean;
          raycastDisabled: boolean; depthWrite: boolean; sharedGeometry: boolean }>;
      }> } }).__orcaE2e?.modelPaintResources?.() ?? [],
    );
    const readColours = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelMaterialColours?: () => Array<{
        id: string;
        objectIndex: number;
        volumeIndex: number;
        stateId: number;
        colour: string;
        opacity: number;
        transparent: boolean;
        depthWrite: boolean;
        flatShading: boolean;
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
    expect(beforeColours[0]).toMatchObject({ id: before.id, stateId: 1, flatShading: true });

    // Change the authoritative slot colour through FilamentRack's picker,
    // then confirm React updates the material while both geometry
    // resources and the original BVH-backed object stay in place.
    await page.getByTestId('filament-colour-1').click();
    await page.getByRole('textbox', { name: 'HEX color', exact: true }).fill('#2048c0');
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
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
    await expect.poll(async () => (await readResources()).find(resource => resource.id === before.id)?.selectionOutlines)
      .toEqual([{ colour: '#fcfcfc', thickness: 3, pixelSized: true, raycastDisabled: true,
        depthWrite: false, sharedGeometry: false, uniformTriangleNormals: true }]);

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
    expect((await readResources())[0].selectionOutlines).toHaveLength(1);
    await page.mouse.click(box.x + box.width - 40, box.y + box.height - 40);
    await expect.poll(async () => (await readResources())[0].selectionOutlines).toEqual([]);

    // Native printable=false suppresses facet materials and uses Orca's
    // semi-transparent black default. Restoring printability reveals paint.
    await page.getByTestId('config-mode-scoped').click();
    const objectRow = page.getByTestId('object-list')
      .locator('div[data-testid^="object-"]:not([data-testid="object-list"])').first();
    await objectRow.click({ button: 'right', position: { x: 10, y: 4 } });
    await page.getByTestId('objectlist-printable').click();
    await expect.poll(async () => (await readResources())[0]?.visibleUsesOriginalGeometry).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(readSelection).toHaveLength(0);
    await expect.poll(async () => (await readColours())[0]).toMatchObject({
      colour: '#000000', opacity: 0.5, transparent: true, depthWrite: false,
    });
    await objectRow.click({ button: 'right', position: { x: 10, y: 4 } });
    await page.getByTestId('objectlist-printable').click();
    await expect.poll(async () => (await readResources())[0]?.visibleGeometryUuid).toBe(before.paintGeometryUuid);
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
        selectionOutlines: Array<{ thickness: number; pixelSized: boolean; raycastDisabled: boolean;
          depthWrite: boolean; sharedGeometry: boolean }>;
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
    await expect.poll(async () => (await readResources()).find(resource => resource.id === target.id)?.selectionOutlines)
      .toEqual([expect.objectContaining({ thickness: 3, pixelSized: true, raycastDisabled: true,
        depthWrite: false, sharedGeometry: false, uniformTriangleNormals: true })]);
    await page.screenshot({ path: test.info().outputPath('selected-model-outline.png') });
    await page.mouse.click(box.x + box.width - 40, box.y + box.height - 40);
    await expect.poll(async () => (await readResources()).find(resource => resource.id === target.id)?.selectionOutlines)
      .toEqual([]);
  } finally {
    await app.close();
  }
});
