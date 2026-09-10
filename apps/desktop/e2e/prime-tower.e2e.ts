import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');

async function launchApp(): Promise<ElectronApplication> {
  const env = { ...process.env, ORCA_E2E: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const glFlag = process.platform === 'linux' ? ['--use-angle=swiftshader-webgl'] : [];
  return _electron.launch({ args: ['.', ...glFlag], cwd: DESKTOP_ROOT, env });
}

type TowerState = {
  plateId: string;
  current: boolean;
  selected: boolean;
  position: { x: number; y: number };
  bands: number;
  opacity: number[];
};
type Point = [number, number, number];
type HistorySnapshot = { undoLabels: string[]; undoButtonLabel: string | null };

test('Prepare prime tower uses real canvas selection, body/gizmo gestures, and no Preview proxy', async () => {
  const app = await launchApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('plate-controls')).toBeVisible();

    const readTowers = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { primeTowerStates?: () => TowerState[] } })
        .__orcaE2e?.primeTowerStates?.() ?? [],
    );
    const readSelection = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { primeTowerSelection?: () => string | null } })
        .__orcaE2e?.primeTowerSelection?.() ?? null,
    );
    const readMoves = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { primeTowerMoveCommands?: () => number } })
        .__orcaE2e?.primeTowerMoveCommands?.() ?? 0,
    );
    const readCamera = () => page.evaluate(() => {
      const value = (window as unknown as {
        __orcaE2e?: { cameraState?: () => { position: number[]; target: number[]; controlsEnabled?: boolean } };
      }).__orcaE2e?.cameraState?.();
      if (!value) return undefined;
      return [...value.position, ...value.target].map((n) => Math.round(n * 100) / 100);
    });
    const readControlsEnabled = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { cameraState?: () => { controlsEnabled?: boolean } } }).__orcaE2e?.cameraState?.().controlsEnabled ?? false,
    );
    const readAxis = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { primeTowerGizmoAxis?: () => string | null } })
        .__orcaE2e?.primeTowerGizmoAxis?.() ?? null,
    );
    const readPointerOwner = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { pointerOwner?: () => string } }).__orcaE2e?.pointerOwner?.() ?? 'none',
    );
    const readHistory = async (): Promise<HistorySnapshot> => {
      const undoButtonLabel = await page.getByTestId('history-undo').getAttribute('aria-label');
      const menuTrigger = page.getByTestId('history-undo-menu-trigger');
      let undoLabels: string[] = [];
      if (await menuTrigger.isEnabled()) {
        await menuTrigger.click();
        undoLabels = await page.getByTestId(/history-undo-entry-/).allTextContents();
        await page.keyboard.press('Escape');
      }
      return { undoLabels, undoButtonLabel };
    };
    const readHistoryUntilEntries = async (): Promise<HistorySnapshot> => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const snapshot = await readHistory();
        if (snapshot.undoLabels.length > 0) return snapshot;
        await page.waitForTimeout(25);
      }
      throw new Error('Worker history menu did not publish project entries');
    };
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const screenForWorld = async (point: Point): Promise<{ x: number; y: number }> => {
      const projected = await page.evaluate((p) =>
        (window as unknown as {
          __orcaE2e?: { projectWorldToScreen?: (q: Point) => { x: number; y: number } | null };
        }).__orcaE2e?.projectWorldToScreen?.(p) ?? null,
        point,
      );
      if (!projected) throw new Error(`world projection unavailable for ${point.join(',')}`);
      const box = await canvas.boundingBox();
      if (!box) throw new Error('viewport canvas has no bounding box');
      return { x: box.x + projected.x, y: box.y + projected.y };
    };
    const hasExpectedBands = (towers: TowerState[]) => towers.length > 0
      && towers.every((tower) => tower.bands === 2 && tower.opacity.every((opacity) => Math.abs(opacity - 0.66) < 0.01));
    await expect.poll(async () => hasExpectedBands(await readTowers())).toBe(true);
    await page.getByTestId('add-plate').click();
    await expect.poll(readTowers).toHaveLength(2);
    const towers = await readTowers();
    let current = towers.find((tower) => tower.current);
    const other = towers.find((tower) => !tower.current);
    expect(current).toBeDefined();
    expect(other).toBeDefined();
    expect(towers.every((tower) => tower.bands === 2 && tower.opacity.every((opacity) => Math.abs(opacity - 0.66) < 0.01))).toBe(true);

    const beds = await page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { bedPlateStates?: () => Array<{ plateId?: string; position: Point }> } })
        .__orcaE2e?.bedPlateStates?.() ?? [],
    );
    const currentBed = beds.find((bed) => bed.plateId === current?.plateId)?.position ?? [0, 0, 0];
    const otherBed = beds.find((bed) => bed.plateId === other?.plateId)?.position ?? [264, 0, 0];
    const localCenter = (tower: TowerState): Point => [tower.position.x + 12, tower.position.y + 18, 9];
    const currentCenter: Point = [currentBed[0] + localCenter(current!)[0], currentBed[1] + localCenter(current!)[1], 9];
    const otherCenter: Point = [otherBed[0] + localCenter(other!)[0], otherBed[1] + localCenter(other!)[1], 9];

    await page.mouse.click((await screenForWorld(currentCenter)).x, (await screenForWorld(currentCenter)).y);
    await expect.poll(readSelection).toBe(current!.plateId);
    await expect(page.getByTestId('object-list')).not.toContainText('Prime tower');
    // The context-menu ray ordering is exercised by the focused occlusion
    // unit test; this fixture has no ObjectList/context-menu entry for the
    // scene-only tower.

    const activeBed = currentBed;
    const bodyPoint: Point = [currentBed[0] + current!.position.x + 3, currentBed[1] + current!.position.y + 3, 9];
    const bodyDragScreen = await screenForWorld(bodyPoint);
    const historyBeforeBody = await readHistoryUntilEntries();
    const cameraBefore = await readCamera();
    await page.mouse.move(bodyDragScreen.x, bodyDragScreen.y);
    await page.mouse.down();
    await page.mouse.move(bodyDragScreen.x + 32, bodyDragScreen.y - 18, { steps: 4 });
    expect(await readMoves()).toBe(0);
    expect((await page.getByTestId('history-undo').getAttribute('aria-label'))).toBe(historyBeforeBody.undoButtonLabel);
    expect(await readPointerOwner()).toBe('external');
    expect(await readCamera()).toEqual(cameraBefore);
    await page.mouse.up();
    await expect.poll(readMoves).toBe(1);
    await expect.poll(async () => {
      const history = await readHistoryUntilEntries();
      return history.undoLabels.length === historyBeforeBody.undoLabels.length + 1
        && history.undoLabels[0] === 'Move Prime Tower';
    }).toBe(true);
    await expect.poll(readPointerOwner).toBe('none');
    await expect.poll(readCamera).toEqual(cameraBefore);
    const afterBody = await readTowers();
    expect(afterBody.find((tower) => tower.current)?.position).not.toEqual(current!.position);

    // A canceled canvas gesture restores the native position and does not add history.
    const moved = afterBody.find((tower) => tower.current)!;
    const historyBeforeCancel = await readHistoryUntilEntries();
    const cancelPoint: Point = [activeBed[0] + moved.position.x + 12, activeBed[1] + moved.position.y + 18, 9];
    const cancelScreen = await screenForWorld(cancelPoint);
    await page.mouse.move(cancelScreen.x, cancelScreen.y);
    await page.mouse.down();
    await page.mouse.move(cancelScreen.x + 25, cancelScreen.y + 10, { steps: 2 });
    expect(await page.getByTestId('history-undo').getAttribute('aria-label')).toBe(historyBeforeCancel.undoButtonLabel);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect.poll(readMoves).toBe(1);
    await expect.poll(readPointerOwner).toBe('none');
    await expect.poll(async () => (await readHistoryUntilEntries()).undoLabels).toEqual(historyBeforeCancel.undoLabels);
    expect((await readTowers()).find((tower) => tower.current)?.position).toEqual(moved.position);

    // Locate a real X/Y TransformControls shaft by hovering projected world
    // candidates, then drag that canvas point. The helper only locates the
    // handle; the gesture itself is dispatched through Playwright's mouse.
    let gizmoPoint: { x: number; y: number } | null = null;
    const gizmoNeighborhood = { x: bodyDragScreen.x + 32, y: bodyDragScreen.y - 18 };
    for (let dx = -140; dx <= 140 && !gizmoPoint; dx += 10) {
      for (let dy = -140; dy <= 140 && !gizmoPoint; dy += 10) {
        const candidate = { x: gizmoNeighborhood.x + dx, y: gizmoNeighborhood.y + dy };
        await page.mouse.move(candidate.x, candidate.y);
        if (await readAxis()) gizmoPoint = candidate;
      }
    }
    expect(gizmoPoint, 'X/Y TransformControls shaft should be discoverable in the canvas').not.toBeNull();
    const historyBeforeGizmo = await readHistoryUntilEntries();
    await page.mouse.move(gizmoPoint!.x, gizmoPoint!.y);
    await expect.poll(readAxis).not.toBeNull();
    await page.mouse.down();
    await page.mouse.move(gizmoPoint!.x + 18, gizmoPoint!.y, { steps: 3 });
    expect((await page.getByTestId('history-undo').getAttribute('aria-label'))).toBe(historyBeforeGizmo.undoButtonLabel);
    await page.mouse.up();
    await expect.poll(readMoves).toBe(2);
    await expect.poll(async () => {
      const history = await readHistoryUntilEntries();
      return history.undoLabels.length === historyBeforeGizmo.undoLabels.length + 1
        && history.undoLabels[0] === 'Move Prime Tower';
    }).toBe(true);
    await expect.poll(readPointerOwner).toBe('none');
    expect((await readTowers()).find((tower) => tower.current)?.position.x).not.toBe(moved.position.x);

    const historyBeforeGizmoCancel = await readHistoryUntilEntries();
    const positionBeforeGizmoCancel = (await readTowers()).find((tower) => tower.current)?.position;
    let cancelGizmoPoint: { x: number; y: number } | null = null;
    for (let dx = -140; dx <= 140 && !cancelGizmoPoint; dx += 10) {
      for (let dy = -140; dy <= 140 && !cancelGizmoPoint; dy += 10) {
        const candidate = { x: gizmoNeighborhood.x + dx, y: gizmoNeighborhood.y + dy };
        await page.mouse.move(candidate.x, candidate.y);
        if (await readAxis()) cancelGizmoPoint = candidate;
      }
    }
    expect(cancelGizmoPoint, 'X/Y TransformControls shaft should remain discoverable after commit').not.toBeNull();
    await page.mouse.down();
    await page.mouse.move(cancelGizmoPoint!.x + 12, cancelGizmoPoint!.y, { steps: 2 });
    expect(await page.getByTestId('history-undo').getAttribute('aria-label')).toBe(historyBeforeGizmoCancel.undoButtonLabel);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect.poll(readPointerOwner).toBe('none');
    await expect.poll(readMoves).toBe(2);
    await expect.poll(async () => (await readHistoryUntilEntries()).undoLabels).toEqual(historyBeforeGizmoCancel.undoLabels);
    expect((await readTowers()).find((tower) => tower.current)?.position).toEqual(positionBeforeGizmoCancel);
    await expect.poll(readControlsEnabled).toBe(true);
    const cameraBeforeRecovery = await readCamera();
    const recoveryCanvas = await canvas.boundingBox();
    if (!recoveryCanvas) throw new Error('viewport canvas has no bounding box');
    await page.mouse.move(recoveryCanvas.x + 20, recoveryCanvas.y + 300);
    await page.mouse.down();
    await page.mouse.move(recoveryCanvas.x + 48, recoveryCanvas.y + 315, { steps: 3 });
    await page.mouse.up();
    await expect.poll(readCamera).not.toEqual(cameraBeforeRecovery);

    // Non-current tower body never selects; it is tested after the active
    // gesture so the ordinary current-plate selection remains armed above.
    await page.mouse.click((await screenForWorld(otherCenter)).x, (await screenForWorld(otherCenter)).y);
    await expect.poll(readSelection).not.toBe(other!.plateId);

    await page.locator('#app-tab-preview').click();
    await expect(page.locator('#app-panel-workspace')).toHaveAttribute('aria-hidden', 'false');
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __orcaE2e?: { primeTowerStates?: () => unknown } }).__orcaE2e?.primeTowerStates?.()))).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __orcaE2e?: { previewMarkerPresent?: () => boolean } }).__orcaE2e?.previewMarkerPresent?.() ?? false)).toBe(false);
  } finally {
    await app.close();
  }
});
