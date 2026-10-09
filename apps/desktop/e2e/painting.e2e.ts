import { _electron } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';


const project = process.env.ORCA_E2E_PAINTED_FACET_PROJECT;
test.skip(process.env.ORCA_E2E_REAL !== '1' || !project, 'run scripts/run-painting-e2e.mjs with current serial artifacts');
test.setTimeout(480_000);
type Evidence = { channel: string; cursor: number[] | null; phase: string; tool: string; sessionId: string; camera: number[]; target: number[]; pivot: number[]; pivotCamera: number[]; center: { x: number; y: number }; settings: { radius: number; vertical: boolean; state: number; erase: boolean }; resources: { kind: string; groups: number[][]; hasBvh: boolean; vertices?: number[]; contour?: number[]; contourGeometry?: string; matchesDraftLeaf?: boolean }[]; rendered: { revision: number; candidates: string[] }; input: { admittedMoves: number; droppedMoves: number }; ordinaryModels: number; runtime: { threaded: boolean }; error: string | null };
type CursorDraw = { uuid: string; radius: number | null; color: string; encodedRgb: number[]; linearRgb: number[]; wireframe: boolean; transparent: boolean; opacity: number; depthTest: boolean; depthWrite: boolean; side: number; primitive: string; positions: number[]; heightPlanes?: number[]; heightBounds?: number[]; lineWidth?: number; worldUnits?: boolean; resolution?: number[]; circleSegments?: number[][] };
type VisualFrame = { at: number; ordinary: string[]; painting: string[]; colors: string[]; navigatorDraws: number;
  draws: Array<{ kind: string; geometry: string; renderOrder: number; groupOrder: number; cursor?: CursorDraw; candidate?: { positions: number[]; color: string; opacity: number; depthWrite: boolean; polygonOffsetFactor: number }; contour?: { color: string; depthTest: boolean; depthWrite: boolean; positions: number[] } }> };
type Committed = { paint: { groups: { stateId: number; indexCount: number }[] }[] };

test('real MMU painting preserves translucent filament materials', async () => {
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-painting-alpha-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_MODEL: project!, ORCA_E2E_PREFERENCES: preferences } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();
    if (process.platform === 'darwin') {
      await app.evaluate(({ Menu, BrowserWindow }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('file-open-project');
        if (!item?.enabled) throw new Error('Open Project native menu is unavailable');
        item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {} as Electron.KeyboardEvent);
      });
    } else {
      await page.getByTestId('titlebar-menu-trigger').click();
      await page.getByTestId('menu-file-trigger').hover();
      await page.locator('[data-slot="menubar-sub-content"]').hover({ position: { x: 8, y: 8 } });
      await page.getByTestId('file-open-project').click();
    }
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__orcaE2e?.modelWorldCenters?.().length ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId('project-progress-dialog')).toHaveCount(0);
    const center = await page.evaluate(() => {
      const hooks = (window as any).__orcaE2e;
      return hooks.projectWorldToScreen(hooks.modelWorldCenters()[0]);
    });
    const bounds = await page.getByTestId('viewport').boundingBox();
    await page.mouse.click(bounds!.x + center.x, bounds!.y + center.y);
    const target = await page.evaluate(() => (window as any).__orcaE2e.modelSelectionIdentities()[0]);
    await page.getByTestId('gizmo-btn-paint').click();
    await expect(page.getByTestId('painting-panel')).toBeVisible();
    for (const [style, rgb, opacity] of [['#2048c080', '2048c0', 128 / 255], ['#2048c000', 'ffffff', 0.3]] as const) {
      await page.getByTestId('filament-colour-2').click();
      await page.getByRole('textbox', { name: 'HEX color', exact: true }).fill(style);
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await page.evaluate(({ objectId, instanceId }) => (window as any).__orcaE2e.paintingVisualStart(objectId, instanceId), target);
      await expect.poll(() => page.evaluate(() => (window as any).__orcaE2e.paintingVisualFrames()
        .flatMap((frame: any) => frame.draws).filter((draw: any) => draw.kind === 'painting').map((draw: any) => draw.modelMaterial)), { timeout: 15_000 }).toContainEqual({
        color: rgb, opacity, transparent: true, depthTest: true, depthWrite: false, side: 2,
      });
      await page.evaluate(() => (window as any).__orcaE2e.paintingVisualStop());
    }
    await page.screenshot({ path: test.info().outputPath('painting-alpha.png') });
    await page.getByRole('button', { name: 'Close painting', exact: true }).click();
    await expect(page.getByTestId('painting-panel')).toHaveCount(0);
  } finally { await app.close(); }
});

test('real painting history jump to empty then Cube Redo removes Prime Tower', async () => {
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-painting-history-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_MODEL: project!, ORCA_E2E_PRIME_TOWER_PROJECT: project!, ORCA_E2E_PREFERENCES: preferences } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();
    if (process.platform === 'darwin') {
      await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('file-open-project')?.enabled)).toBe(true);
      await app.evaluate(({ Menu, BrowserWindow }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('file-open-project');
        if (!item?.enabled) throw new Error('Open Project native menu is unavailable');
        item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {} as Electron.KeyboardEvent);
      });
    } else {
      await page.getByTestId('titlebar-menu-trigger').click();
      await page.getByTestId('menu-file-trigger').hover();
      await page.locator('[data-slot="menubar-sub-content"]').hover({ position: { x: 8, y: 8 } });
      await page.getByTestId('file-open-project').click();
    }
    await expect.poll(() => page.evaluate(() => !!document.querySelector('[data-testid="project-load-choice-dialog"], [data-testid="project-load-confirmation-dialog"], [data-testid="project-progress-dialog"]') || !!(window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e?.projectLoadEvidence?.().receipt)).toBe(true);
    if (await page.getByTestId('project-load-choice-dialog').isVisible()) {
      await page.getByTestId('project-load-project').click(); await page.getByTestId('project-load-confirm').click();
    }
    await expect.poll(() => page.evaluate(() => !!document.querySelector('[data-testid="project-load-confirmation-dialog"]') || !!(window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e?.projectLoadEvidence?.().receipt), { timeout: 120_000 }).toBe(true);
    if (await page.getByTestId('project-load-confirmation-dialog').isVisible()) await page.getByTestId('project-load-confirmation-dialog-continue').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e?.projectLoadEvidence?.().receipt), { timeout: 60_000 }).toMatchObject({ sourceDisplayName: basename(project!), sourceByteLength: statSync(project!).size, nativeResult: { ok: true, objects: 1 } });
    await expect(page.getByTestId('project-progress-dialog')).toHaveCount(0);
    await page.getByTestId('config-page-Multi.').click();
    await page.getByTestId('config-field-enable_prime_tower').getByRole('checkbox').check();
    await page.getByTestId('config-mode-scoped').click();
    const rows = page.getByTestId('object-list').locator('div[data-testid^="object-"]:not([data-testid="object-list"])');
    const emptyContext = async () => {
      const bounds = await page.getByTestId('viewport').boundingBox();
      const stats = await page.locator('.scene-stats').boundingBox();
      await page.mouse.click(bounds!.x + bounds!.width - 40, Math.max(bounds!.y + 40, stats ? stats.y + stats.height + 16 : bounds!.y + 40), { button: 'right' });
      await expect(page.getByTestId('ctx-menu')).toBeVisible();
    };
    await emptyContext(); await page.getByTestId('btn-clear-scene').click();
    await expect(rows).toHaveCount(0);
    await emptyContext(); await page.getByTestId('btn-add-primitive').click(); await page.getByTestId('btn-add-cube').click();
    await expect(rows).toHaveCount(1);
    const history = () => page.evaluate(() => ((window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e!.historyNativeStatus as () => { undoEntries: { id: string; label: string }[] })());
    await expect.poll(async () => (await history()).undoEntries[0]?.label).toBe('Add Cube');
    const addEntry = (await history()).undoEntries[0].id;
    const towerIds = () => page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e!.primeTowerProxyIds!());
    await expect.poll(towerIds).toEqual([]);
    await rows.first().click(); await page.getByTestId('gizmo-btn-paint').click();
    await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingEvidence().resources.length)).toBeGreaterThan(0);
    await page.getByRole('radio', { name: 'Paint filament 2', exact: true }).click();
    await page.getByTestId('painting-tool-triangle').click();
    const point = await page.evaluate(() => ((window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e!.paintingEvidence as () => Evidence)().center);
    await page.mouse.click(point.x, point.y);
    await expect.poll(() => page.evaluate(async () => {
      const result = await ((window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e!.paintingCommittedEvidence as () => Promise<Committed | null>)();
      return result?.paint.some(part => part.groups.some(group => group.stateId === 2 && group.indexCount > 0)) ?? false;
    })).toBe(true);
    await page.getByTestId('gizmo-btn-paint').click();
    await expect(page.getByTestId('painting-panel')).toHaveCount(0);
    await expect.poll(towerIds).toHaveLength(1);
    await page.screenshot({ path: test.info().outputPath('history-painted-cube-tower.png') });
    await page.getByTestId('history-undo').click({ button: 'right' });
    await page.getByTestId(`history-undo-entry-${addEntry}`).click();
    await expect(rows).toHaveCount(0); await expect.poll(towerIds).toEqual([]);
    await page.getByTestId('history-redo').click(); await expect(rows).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => ((window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.modelPaintResources as () => { paintGeometryUuid: string | null; visibleUsesOriginalGeometry: boolean }[])()
      .map(volume => ({ paint: volume.paintGeometryUuid, original: volume.visibleUsesOriginalGeometry })))).toEqual([{ paint: null, original: true }]);
    await expect.poll(towerIds).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('history-redo-unpainted-cube-no-tower.png') });
    await page.getByTestId('history-redo').click();
    await expect.poll(towerIds).toHaveLength(1);
    await page.screenshot({ path: test.info().outputPath('history-redo-painted-cube-tower.png') });
    await expect(page.getByTestId('history-restore-error')).toHaveCount(0);
  } finally { await app.close(); }
});

test('real painting gizmo routes six tools, native edits, history, camera and close', async () => {
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-painting-')), 'preferences.json');
  const savedProject = join(resolve(preferences, '..'), 'painting-saved.3mf');
  writeFileSync(preferences, JSON.stringify({ version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_MODEL: project!, ORCA_E2E_PRIME_TOWER_PROJECT: project!, ORCA_E2E_PREFERENCES: preferences, ORCA_E2E_PROJECT_SAVE: savedProject } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1400, height: 900 });
    await page.evaluate(() => {
      const events: unknown[] = [];
      (window as unknown as { __paintingInputDiagnostics: unknown[] }).__paintingInputDiagnostics = events;
      for (const type of ['pointermove', 'pointerdown', 'pointerleave', 'wheel', 'blur'])
        window.addEventListener(type, (event) => {
          const pointer = event as PointerEvent;
          events.push({ at: performance.now(), type, x: pointer.clientX, y: pointer.clientY,
            target: (event.target as Element | null)?.nodeName });
        }, true);
    });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();
    if (process.platform === 'darwin') {
      await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('file-open-project')?.enabled)).toBe(true);
      await app.evaluate(({ Menu, BrowserWindow }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('file-open-project');
        if (!item?.enabled) throw new Error('Open Project native menu is unavailable');
        item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {} as Electron.KeyboardEvent);
      });
    } else {
      if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
        await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
        await page.getByTestId('titlebar-menu-trigger').click();
      }
      await page.getByTestId('menu-file-trigger').hover();
      await page.locator('[data-slot=\"menubar-sub-content\"]').hover({ position: { x: 8, y: 8 } }); await page.getByTestId('file-open-project').click();
    }
    await expect.poll(() => page.evaluate(() => !!document.querySelector('[data-testid="project-load-choice-dialog"], [data-testid="project-load-confirmation-dialog"], [data-testid="project-progress-dialog"]') || !!(window as unknown as { __orcaE2e?: Record<string, any> }).__orcaE2e?.projectLoadEvidence?.().receipt)).toBe(true);
    if (await page.getByTestId('project-load-choice-dialog').isVisible()) { await page.getByTestId('project-load-project').click(); await page.getByTestId('project-load-confirm').click(); }
    await expect.poll(() => page.evaluate(() => !!document.querySelector('[data-testid="project-load-confirmation-dialog"]') || !!(window as unknown as { __orcaE2e?: Record<string, any> }).__orcaE2e?.projectLoadEvidence?.().receipt), { timeout: 120_000 }).toBe(true);
    if (await page.getByTestId('project-load-confirmation-dialog').isVisible()) await page.getByTestId('project-load-confirmation-dialog-continue').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __orcaE2e?: Record<string, any> }).__orcaE2e?.projectLoadEvidence?.().receipt), { timeout: 60_000 }).toMatchObject({ sourceDisplayName: basename(project!), sourceByteLength: statSync(project!).size, nativeResult: { ok: true, objects: 1, instances: 2 } });
    // The native receipt precedes removal of the load overlay and scene effects.
    // Raw mouse coordinates do not have locator.click's actionability waiting.
    await expect(page.getByTestId('project-progress-dialog')).toHaveCount(0);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const center = await page.evaluate(() => {
      const hooks = (window as unknown as { __orcaE2e?: Record<string, any> }).__orcaE2e as unknown as { modelWorldCenters(): [number, number, number][]; projectWorldToScreen(p: [number, number, number]): { x: number; y: number } };
      return hooks.projectWorldToScreen(hooks.modelWorldCenters()[0]);
    });
    const bounds = await page.getByTestId('viewport').boundingBox();
    await page.mouse.click(bounds!.x + center.x, bounds!.y + center.y);
    await expect(page.getByTestId('gizmo-btn-paint')).toBeEnabled();
    const paintButton = page.getByTestId('gizmo-btn-paint');
    const moveButton = page.getByTestId('gizmo-btn-move');
    const toolbarColors = (button: typeof paintButton) => button.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, foreground: style.color };
    });
    const leaveToolbar = () => page.getByTestId('slicer-status').hover();
    const toolbarEvidence: Record<string, unknown> = {};
    await expect(paintButton).toHaveAttribute('aria-pressed', 'false');
    await leaveToolbar();
    const inactivePaintColors = await toolbarColors(paintButton);
    toolbarEvidence.closed = inactivePaintColors;
    await moveButton.click(); await expect(moveButton).toHaveAttribute('aria-pressed', 'true');
    await leaveToolbar();
    // Read the settled reference, rather than an interpolated transition colour.
    await moveButton.evaluate(async (element) => {
      getComputedStyle(element).backgroundColor;
      await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {})));
    });
    await expect.poll(async () => (await toolbarColors(moveButton)).background).not.toBe(inactivePaintColors.background);
    const armedColors = await toolbarColors(moveButton);
    toolbarEvidence.transform = armedColors;
    await moveButton.hover(); await expect.poll(() => toolbarColors(moveButton)).toEqual(armedColors);
    await moveButton.click(); await expect(moveButton).toHaveAttribute('aria-pressed', 'false');
    const assertPaintingArmed = async (phase: string, hover = false) => {
      await expect(paintButton).toHaveAttribute('aria-pressed', 'true');
      await expect(moveButton).toHaveAttribute('aria-pressed', 'false');
      if (hover) await paintButton.hover(); else await leaveToolbar();
      await expect.poll(() => toolbarColors(paintButton)).toEqual(armedColors);
      toolbarEvidence[phase] = { pressed: true, ...(await toolbarColors(paintButton)) };
    };
    const selectedTarget = await page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.modelSelectionIdentities()[0] as { objectId: number; instanceId: number });
    const startFrames = () => page.evaluate(({ objectId, instanceId }) => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingVisualStart(objectId, instanceId), selectedTarget);
    const stopFrames = () => page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingVisualStop() as VisualFrame[]);
    const readFrames = () => page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingVisualFrames() as VisualFrame[]);
    const settleFrames = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const completeFrames = async (name: string, frames: VisualFrame[]) => {
      const path = test.info().outputPath(`${name}.json`);
      writeFileSync(path, JSON.stringify(frames, null, 2));
      await test.info().attach(name, { path, contentType: 'application/json' });
      expect(frames.length, `${name}: real renderer frames were recorded`).toBeGreaterThan(1);
      expect(frames.filter((f) => f.ordinary.length + f.painting.length === 0), `${name}: every frame draws the selected target`).toEqual([]);
      expect(frames.filter((f) => f.ordinary.length > 0 && f.painting.length > 0), `${name}: Prepare and painting never expose the target together`).toEqual([]);
      expect(frames.every((frame) => frame.navigatorDraws > 0), `${name}: the orientation navigator actually draws`).toBe(true);
    };
    const cameraPose = () => page.evaluate(() => { const state = (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.cameraState(); return { position: state.position, quaternion: state.quaternion, target: state.target }; });
    const beforeOpenCamera = await cameraPose();
    await page.getByTestId('config-mode-plates').click();
    await expect(page.getByTestId('plate-controls')).toBeVisible();
    await startFrames(); await settleFrames(); await page.getByTestId('gizmo-btn-paint').click();
    const read = () => page.evaluate(() => ((window as unknown as { __orcaE2e?: Record<string, any> }).__orcaE2e?.paintingEvidence as (() => Evidence) | undefined)?.() ?? null);
    const committed = () => page.evaluate(() => ((window as unknown as { __orcaE2e?: Record<string, any> }).__orcaE2e?.paintingCommittedEvidence as () => Promise<Committed>)());
    const history = () => page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.historyNativeStatus());
    const idle = async () => { await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle'); await expect.poll(async () => (await read())?.resources.length ?? 0).toBeGreaterThan(0); };
    await idle(); await settleFrames();
    await expect(page.getByTestId('add-plate')).toBeDisabled();
    await expect(page.getByTestId('arrange-current-plate')).toBeDisabled();
    await assertPaintingArmed('idle'); await assertPaintingArmed('idle-hover', true);
    await page.screenshot({ path: test.info().outputPath('painting-toolbar-active.png') });
    const near = (actual: number[], expected: number[]) => actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 8));
    const assertBlankStart = async (channel: string) => {
      await idle(); await settleFrames();
      const before = (await read())!, h = await history(), viewport = await page.locator('canvas').first().boundingBox();
      expect(before.channel).toBe(channel);
      const origin = { x: viewport!.x + 10, y: before.center.y };
      await page.mouse.move(origin.x, origin.y); await settleFrames();
      const strokeCalls = () => page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingPerformanceEvidence().calls.filter((call: { name: string }) =>
        ['beginPaintingStroke', 'samplePaintingStroke', 'commitPaintingStroke', 'cancelPaintingStroke'].includes(call.name)));
      const nativeBefore = await strokeCalls();
      await page.mouse.down(); await settleFrames();
      expect((await read())!.phase, `${channel}: blank press stays idle`).toBe('idle');
      expect(await strokeCalls(), `${channel}: blank press bypasses native begin`).toEqual(nativeBefore);
      await page.mouse.move(before.center.x, origin.y, { steps: 5 }); await settleFrames();
      expect((await read())!.camera).not.toEqual(before.camera);
      expect((await read())!.phase).toBe('idle');
      // Reverse the same horizontal orbit before releasing to retain framing.
      await page.mouse.move(origin.x, origin.y, { steps: 5 }); await page.mouse.up(); await settleFrames();
      expect(await strokeCalls(), `${channel}: crossing the model never starts or ends a stroke`).toEqual(nativeBefore);
      near((await read())!.camera, before.camera); near((await read())!.target, before.target);
      expect(await history()).toEqual(h);
    };
    const afterOpen = (await read())!;
    const afterOpenCamera = { position: afterOpen.camera.slice(0, 3), quaternion: afterOpen.camera.slice(3), target: afterOpen.target };
    for (const key of ['position', 'quaternion', 'target'] as const) near(afterOpenCamera[key], beforeOpenCamera[key]);
    // The repository cube has local bounds [-10,10] and the selected first
    // instance translates by (100,100,10). The second is at (130,100,10).
    // A scene/bed centre or a Z=0 pivot cannot satisfy this independent value.
    near((await read())!.pivot, [100, 100, 10]);
    const entryFrames = await stopFrames(); await completeFrames('painting-entry-render-frames', entryFrames);
    expect(entryFrames.some((f) => f.ordinary.length > 0)).toBe(true); expect(entryFrames.some((f) => f.painting.length > 0)).toBe(true);
    await assertBlankStart('mmu');
    const initialPoint = (await read())!.center;
    await page.mouse.move(initialPoint.x, initialPoint.y); await page.mouse.wheel(0, -700); await page.mouse.wheel(0, -700);
    expect((await read())!.runtime.threaded).toBe(false);
    expect((await read())!.ordinaryModels).toBe(0);
    expect((await read())!.resources.every((r) => !r.hasBvh)).toBe(true);
    const sessionId = (await read())!.sessionId;
    await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle();
    expect((await committed()).paint).toHaveLength(0); await idle();
    await page.getByRole('radio', { name: 'Paint filament 2', exact: true }).click();
    // Burst moves in one browser turn while a real Worker RPC occupies the
    // lane. The final pointerup is a reliable sample on a different top face.
    await page.getByTestId('painting-tool-triangle').click();
    const topFaces = await page.evaluate(() => {
      const hooks = (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e;
      const canvas = document.querySelector('[data-testid="viewport"] canvas');
      // Zoom can put a cap point under the floating toolbar. Keep both
      // samples inside their distinct native triangles and on the canvas.
      for (const offset of [5, 2, 1]) {
        const points = [[100 + offset, 100 - offset, 20], [100 - offset, 100 + offset, 20]]
          .map((world) => hooks.paintingWorldToScreen(world));
        if (points.every((point) => document.elementFromPoint(point.x, point.y) === canvas)) return points;
      }
      throw new Error('two visible native top triangles are required for continuous hover');
    });
    const triangleHistory = await history();
    await page.mouse.move(topFaces[0]!.x, topFaces[0]!.y);
    await expect.poll(async () => (await read())?.resources.find((r) => r.kind === 'triangle')?.matchesDraftLeaf).toBe(true);
    await settleFrames();
    const triangleLeaf = (await read())!.resources.find((r) => r.kind === 'triangle')!;
    expect(triangleLeaf.vertices).toHaveLength(18); expect(triangleLeaf.contour).toHaveLength(18);
    await startFrames(); await settleFrames();
    const hoverContours = [triangleLeaf.contour!];
    for (const point of [topFaces[1], topFaces[0], topFaces[1], topFaces[0]]) {
      const before = (await read())!.resources.find((r) => r.kind === 'triangle')!.contourGeometry;
      await page.mouse.move(point.x, point.y);
      await expect.poll(async () => {
        const leaf = (await read())?.resources.find((r) => r.kind === 'triangle');
        return leaf?.matchesDraftLeaf === true && typeof leaf.contourGeometry === 'string' && leaf.contourGeometry !== before;
      }).toBe(true).catch(async (error) => {
        const diagnostics = { point, before, topFaces, evidence: await read(), frames: await readFrames(),
          native: await page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingPerformanceEvidence()) };
        await test.info().attach('painting-triangle-hover-failure', {
          body: Buffer.from(JSON.stringify(diagnostics, null, 2)), contentType: 'application/json',
        });
        await page.screenshot({ path: test.info().outputPath('painting-triangle-hover-failure.png') });
        throw error;
      });
      const leaf = (await read())!.resources.find((r) => r.kind === 'triangle')!;
      expect(leaf.matchesDraftLeaf).toBe(true); hoverContours.push(leaf.contour!); await settleFrames();
    }
    const triangleHoverFrames = await stopFrames(); await completeFrames('painting-triangle-native-hover', triangleHoverFrames);
    expect(new Set(hoverContours.map((contour) => JSON.stringify(contour))).size).toBe(2);
    expect(new Set(triangleHoverFrames.flatMap((f) => f.painting)).size, 'hover preserves draft geometry').toBe(1);
    for (const frame of triangleHoverFrames) {
      const contours = frame.draws.filter((draw) => draw.kind === 'painting-contour-triangle');
      expect(contours, 'every continuous hover frame draws the selected native contour').toHaveLength(1);
      expect(hoverContours).toContainEqual(contours[0].contour!.positions);
      expect(contours[0].contour).toMatchObject({ color: 'ffffff', depthTest: true, depthWrite: false });
    }
    const finalTriangleLeaf = (await read())!.resources.find((r) => r.kind === 'triangle')!;
    const outline = triangleHoverFrames.at(-1)!.draws.find((draw) => draw.kind === 'painting-contour-triangle')!;
    expect(outline.geometry).toBe(finalTriangleLeaf.contourGeometry);
    expect(outline.contour).toEqual({ color: 'ffffff', depthTest: true, depthWrite: false, positions: finalTriangleLeaf.contour });
    expect(triangleHoverFrames.flatMap((f) => f.draws).filter((draw) => draw.kind === 'painting-cursor-triangle' || draw.kind === 'painting-candidate')).toEqual([]);
    expect(await history()).toEqual(triangleHistory);
    await page.screenshot({ path: test.info().outputPath('painting-triangle-native-hover.png') });
    await page.mouse.move(bounds!.x + 10, bounds!.y + 10);
    await expect.poll(async () => (await read())!.rendered.candidates.length).toBe(0);
    await page.mouse.move(topFaces[0]!.x, topFaces[0]!.y);
    await expect.poll(async () => (await read())!.rendered.candidates.length).toBe(1);
    // Region hover traverses distinct visible planes, not two triangles on
    // the same cap. Native angle-30 fill must change actual membership.
    await page.getByTestId('painting-tool-region').click();
    const regionPoints = await page.evaluate(() => {
      const hooks = (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e;
      return [[105, 95, 20], [103, 90, 11]].map((world) => hooks.paintingWorldToScreen(world));
    });
    const regionHistory = await history();
    await page.mouse.move(regionPoints[0].x, regionPoints[0].y);
    await expect.poll(async () => (await read())?.resources.find((r) => r.kind === 'region')?.matchesDraftLeaf).toBe(true);
    await settleFrames();
    const regions = [(await read())!.resources.find((r) => r.kind === 'region')!];
    await startFrames(); await settleFrames();
    for (const point of [regionPoints[1], regionPoints[0], regionPoints[1], regionPoints[0]]) {
      const before = (await read())!.resources.find((r) => r.kind === 'region')!.vertices;
      await page.mouse.move(point.x, point.y);
      await expect.poll(async () => {
        const region = (await read())?.resources.find((r) => r.kind === 'region');
        return region?.matchesDraftLeaf === true && region.vertices !== undefined && JSON.stringify(region.vertices) !== JSON.stringify(before);
      }).toBe(true);
      const region = (await read())!.resources.find((r) => r.kind === 'region')!;
      expect(region.matchesDraftLeaf).toBe(true); regions.push(region); await settleFrames();
    }
    const regionHoverFrames = await stopFrames(); await completeFrames('painting-region-native-hover', regionHoverFrames);
    expect(new Set(regions.map((r) => JSON.stringify(r.vertices))).size).toBe(2);
    expect(new Set(regionHoverFrames.flatMap((f) => f.painting)).size, 'Region hover preserves draft geometry').toBe(1);
    for (const frame of regionHoverFrames) {
      const fill = frame.draws.filter((d) => d.kind === 'painting-candidate');
      const contour = frame.draws.filter((d) => d.kind === 'painting-contour');
      expect(fill, 'every continuous Region hover frame draws one native fill').toHaveLength(1);
      expect(fill[0].candidate).toMatchObject({color:'ffffff',opacity:0.35,depthWrite:false,polygonOffsetFactor:-2});
      expect(contour, 'every continuous Region hover frame draws one native contour').toHaveLength(1);
      expect(regions.some((r) => JSON.stringify(r.vertices!.filter((_, i) => i % 6 < 3)) === JSON.stringify(fill[0].candidate!.positions)
        && JSON.stringify(r.contour) === JSON.stringify(contour[0].contour!.positions)), 'fill and contour belong to one complete native region').toBe(true);
      expect(contour[0].contour).toMatchObject({ color: 'ffffff', depthTest: false });
    }
    expect(new Set(regionHoverFrames.flatMap((f) => f.draws.filter((d) => d.kind === 'painting-candidate').map((d) => JSON.stringify(d.candidate!.positions)))).size, 'actual renderer draws both native regions').toBe(2);
    expect(await history()).toEqual(regionHistory);
    await page.screenshot({ path: test.info().outputPath('painting-region-native-hover.png') });
    // An in-canvas native miss clears only after its new empty receipt.
    await startFrames(); await page.mouse.move(bounds!.x + 10, bounds!.y + 10);
    await expect.poll(async () => (await read())!.rendered.candidates.length).toBe(0);
    await settleFrames(); const regionMissFrames = await stopFrames(); await completeFrames('painting-region-native-miss', regionMissFrames);
    expect(regionMissFrames.at(-1)!.draws.filter((d) => d.kind === 'painting-candidate' || d.kind === 'painting-contour')).toEqual([]);
    expect(await history()).toEqual(regionHistory);
    await page.getByTestId('painting-tool-triangle').click();
    await page.mouse.move(topFaces[0].x, topFaces[0].y);
    await expect.poll(async () => (await read())?.resources.find((r) => r.kind === 'triangle')?.matchesDraftLeaf).toBe(true);
    const inputBefore = (await read())!.input;
    await page.mouse.move(topFaces[0]!.x, topFaces[0]!.y); await page.mouse.down();
    await expect.poll(async () => (await read())?.phase).toBe('drawing');
    // A held native stroke disables toggles without losing their armed colours.
    await expect(paintButton).toHaveAttribute('aria-pressed', 'true'); await expect(paintButton).toBeDisabled();
    await expect.poll(() => toolbarColors(paintButton)).toEqual(armedColors);
    toolbarEvidence.drawing = { pressed: true, disabled: true, ...(await toolbarColors(paintButton)) };
    await page.evaluate(({ start, end }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="viewport"] canvas')!;
      for (let i = 0; i < 24; i++) canvas.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1,
        clientX: start.x + i / 100, clientY: start.y + i / 100,
      }));
      canvas.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0,
        clientX: end.x, clientY: end.y,
      }));
    }, { start: topFaces[0], end: topFaces[1] });
    await page.mouse.up(); await idle();
    expect((await read())!.input.droppedMoves - inputBefore.droppedMoves).toBeGreaterThan(0);
    const nativePaint = await committed();
    expect(nativePaint.paint).toHaveLength(1);
    const firstAndFinal = nativePaint.paint.flatMap((part) => part.groups)
      .filter((group) => group.stateId === 2).reduce((sum, group) => sum + group.indexCount, 0);
    expect(firstAndFinal).toBe(6);
    await page.getByTestId('history-undo').click(); await idle();
    expect((await committed()).paint).toHaveLength(0); await idle();
    await page.getByTestId('history-redo').click(); await idle();
    expect((await committed()).paint.some((part) => part.groups.some((group) => group.stateId === 2))).toBe(true);
    await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle();
    for (const tool of ['circle', 'sphere', 'triangle', 'height', 'region']) {
      await page.getByTestId(`painting-tool-${tool}`).click();
      if (tool === 'circle' || tool === 'sphere') await page.getByRole('spinbutton', { name: 'Radius (mm)', exact: true }).fill('4');
      if (tool === 'height') await page.getByRole('spinbutton', { name: 'Height (mm)', exact: true }).fill('5');
      if (tool === 'height') {
        const unchangedHistory = await history();
        const nearMax = await page.evaluate(() => (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingWorldToScreen([103,90,18]));
        await page.mouse.move(nearMax.x,nearMax.y); await settleFrames();
        await startFrames(); await settleFrames();
        const clampedFrames = await stopFrames(); await completeFrames('painting-height-upper-clamp',clampedFrames);
        for (const frame of clampedFrames) {
          const cursors = frame.draws.filter((d)=>d.kind==='painting-cursor-height'); expect(cursors).toHaveLength(1);
          const cursor = cursors[0].cursor!;
          expect(cursor.heightPlanes![0]).toBeCloseTo(18,4); expect(cursor.heightPlanes![1]).toBe(20);
          expect(cursor.positions.length).toBeGreaterThan(0);
          expect(cursor.positions.filter((_,i)=>i%3===2).every((z)=>Math.abs(z-18)<1e-4)).toBe(true);
        }
        await page.mouse.move(topFaces[0].x,topFaces[0].y); await settleFrames();
        await startFrames(); await settleFrames();
        const endFrames = await stopFrames(); await completeFrames('painting-height-global-end-empty',endFrames);
        expect(endFrames.every((frame)=>frame.draws.every((draw)=>draw.kind!=='painting-cursor-height'))).toBe(true);
        expect(await history()).toEqual(unchangedHistory);
      }
      const point = tool === 'triangle' ? topFaces[0] : tool === 'height' ? regionPoints[1] : (await read())!.center;
      await page.mouse.move(point.x, point.y); await settleFrames();
      if (tool === 'circle') {
        const beforeZoom = (await read())!, unchangedHistory = await history();
        const viewportSize = await page.locator('[data-testid="viewport"] canvas[data-engine^="three.js"]').evaluate((canvas) => [canvas.clientWidth, canvas.clientHeight]);
        const dashCounts: number[] = [];
        await startFrames(); await settleFrames();
        for (const [name, delta] of [['zoomed-out', 500], ['restored', -500]] as const) {
          const cameraBeforeWheel = (await read())!.camera;
          await page.mouse.wheel(0, delta);
          // mouse.wheel() returns before the browser processes the wheel.
          // Wait for its camera update before sending the new hover sample.
          await expect.poll(async () => (await read())!.camera).not.toEqual(cameraBeforeWheel);
          await idle();
          const center = (await read())!.center;
          await page.mouse.move(center.x + 1, center.y);
          await page.mouse.move(center.x, center.y); await settleFrames();
          await expect.poll(async () => (await readFrames()).at(-1)?.draws.at(-1)?.cursor?.lineWidth).toBe(2);
          const actual = (await readFrames()).at(-1)!.draws.at(-1)!.cursor!;
          expect(actual.worldUnits).toBe(false);
          actual.resolution!.forEach((value, axis) => expect(value).toBeCloseTo(viewportSize[axis], 0));
          dashCounts.push(actual.circleSegments!.length);
          if (name === 'zoomed-out') expect((await read())!.camera).not.toEqual(beforeZoom.camera);
          else near((await read())!.camera, beforeZoom.camera);
          await page.screenshot({ path: test.info().outputPath(`painting-circle-width-${name}.png`) });
        }
        const frames = await stopFrames(); await completeFrames('painting-circle-screen-width', frames);
        const circles = frames.flatMap((frame) => frame.draws.filter((draw) => draw.kind === 'painting-cursor-circle'));
        expect(circles.length).toBeGreaterThan(1);
        expect(circles.every((draw) => draw.cursor?.lineWidth === 2 && draw.cursor.worldUnits === false)).toBe(true);
        expect(dashCounts[0], 'zooming out reduces Orca dash density').toBeLessThan(dashCounts[1]);
        for (const draw of circles) {
          const segments = draw.cursor!.circleSegments!, step = Math.PI / segments.length;
          expect(segments.length).toBeGreaterThanOrEqual(3);
          for (let i = 0; i < segments.length; i++) {
            const [ax, ay, az, bx, by, bz] = segments[i], [cx, cy] = segments[(i + 1) % segments.length];
            expect(Math.hypot(ax, ay)).toBeCloseTo(1, 5); expect(Math.hypot(bx, by)).toBeCloseTo(1, 5);
            expect(az).toBe(0); expect(bz).toBe(0);
            expect(Math.atan2(ax * by - ay * bx, ax * bx + ay * by), 'painted angular interval').toBeCloseTo(step, 5);
            expect(Math.atan2(bx * cy - by * cx, bx * cx + by * cy), 'equal unpainted interval, including seam').toBeCloseTo(step, 5);
          }
        }
        expect(await history()).toEqual(unchangedHistory);
      }
      if (tool === 'triangle') await expect.poll(async () => (await read())?.resources.find((r) => r.kind === 'triangle')?.matchesDraftLeaf).toBe(true);
      const brushCursor = tool === 'circle' || tool === 'sphere' || tool === 'height';
      if (brushCursor || tool === 'triangle') { await startFrames(); await settleFrames(); }
      const hoverFrames = brushCursor ? await readFrames() : [];
      await page.mouse.down();
      try { await expect.poll(async () => (await read())?.phase).toBe('drawing'); }
      catch (error) {
        const evidence = await page.evaluate(() => { const hooks = (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e; return { state: hooks.paintingEvidence(), performance: hooks.paintingPerformanceEvidence() }; });
        const path = test.info().outputPath(`painting-${tool}-press-failure.json`);
        writeFileSync(path, JSON.stringify(evidence, null, 2)); await test.info().attach(`${tool} press failure`, { path, contentType: 'application/json' });
        throw error;
      }
      const drawingEvidence = (await read())!;
      if (brushCursor) {
        // Capture the initial press publication and hold through a genuine
        // native draft replacement, without a pointerleave or a second hover.
        if (tool === 'circle') await expect.poll(async () => (await readFrames()).some((frame) =>
          frame.painting.some((geometry) => !hoverFrames[0].painting.includes(geometry)))).toBe(true);
        await settleFrames();
        await page.screenshot({ path: test.info().outputPath(`painting-${tool}-held-cursor.png`) });
        const frames = await stopFrames(); await completeFrames(`painting-${tool}-held-cursor-frames`, frames);
        expect(frames.length).toBeGreaterThan(hoverFrames.length);
        const cursorIds = new Set<string>();
        for (const frame of frames) {
          const cursors = frame.draws.filter((draw) => draw.kind === `painting-cursor-${tool}`);
          expect(cursors, `${tool}: cursor draws in every hover/pressed frame`).toHaveLength(1);
          const draw = cursors[0], cursor = draw.cursor!; cursorIds.add(cursor.uuid);
          expect(frame.draws.at(-1), `${tool}: cursor follows all model/candidate/contour draws`).toBe(draw);
          expect(draw.renderOrder).toBeGreaterThan(3); expect(draw.groupOrder).toBeGreaterThan(3);
          expect(cursor).toMatchObject({ color: tool === 'height' ? 'ffffff' : '00ff00', wireframe: false, transparent: true,
            opacity: tool === 'sphere' ? 0.25 : 1, depthTest: tool !== 'circle', depthWrite: false,
            side: tool === 'circle' ? 2 : 0 });
          if (tool === 'sphere') expect(cursor.radius).toBe(4);
          if (tool === 'circle') expect(cursor).toMatchObject({ lineWidth: 2, worldUnits: false });
          if (tool === 'height') {
            expect(cursor.primitive).toBe('lineSegments'); expect(cursor.positions.length).toBeGreaterThan(0);
            expect(cursor.heightBounds).toEqual([0,20]);
            const [lower,upper] = cursor.heightPlanes!;
            expect(lower).toBeCloseTo(11,4); expect(upper).toBeCloseTo(16,4);
            let length = 0;
            for (let i = 0; i < cursor.positions.length; i += 6) {
              const [ax,ay,az,bx,by,bz] = cursor.positions.slice(i,i+6);
              expect(az).toBeCloseTo(bz,5); expect([lower,upper].some((z)=>Math.abs(az-z)<1e-4)).toBe(true);
              expect(ax).toBeGreaterThanOrEqual(90); expect(ax).toBeLessThanOrEqual(110);
              expect(ay).toBeGreaterThanOrEqual(90); expect(ay).toBeLessThanOrEqual(110);
              expect((ax===90 && bx===90)||(ax===110 && bx===110)||(ay===90 && by===90)||(ay===110 && by===110)).toBe(true);
              length += Math.hypot(ax-bx,ay-by);
            }
            expect(length).toBeCloseTo(160,4);
          }
        }
        expect(cursorIds.size, `${tool}: held press retains the same cursor draw object`).toBe(1);
      }
      if (tool === 'triangle') {
        for (const next of [topFaces[1], topFaces[0]]) {
          const before = (await read())!.resources.find((r) => r.kind === 'triangle')!.contourGeometry;
          await page.mouse.move(next.x, next.y);
          await expect.poll(async () => {
            const leaf = (await read())?.resources.find((r) => r.kind === 'triangle');
            return leaf?.matchesDraftLeaf === true && typeof leaf.contourGeometry === 'string' && leaf.contourGeometry !== before;
          }).toBe(true);
          expect((await read())!.resources.find((r) => r.kind === 'triangle')!.matchesDraftLeaf).toBe(true);
          await settleFrames();
        }
        await expect.poll(async () => (await readFrames()).at(-1)?.draws.filter((draw) => draw.kind === 'painting-contour-triangle').length).toBe(1);
        const frames = await stopFrames(); await completeFrames('painting-triangle-held-outline', frames);
        expect(frames.every((frame) => frame.draws.filter((draw) => draw.kind === 'painting-contour-triangle').length === 1), 'every hover/press/held movement frame keeps the native contour').toBe(true);
        expect(new Set(frames.flatMap((frame) => frame.draws.filter((draw) => draw.kind === 'painting-contour-triangle').map((draw) => JSON.stringify(draw.contour!.positions)))).size).toBe(2);
        expect(new Set(frames.flatMap((frame) => frame.painting)).size, 'held native samples replace draft geometry').toBeGreaterThan(1);
        expect(frames.flatMap((f) => f.draws).filter((draw) => draw.kind === 'painting-cursor-triangle' || draw.kind === 'painting-candidate')).toEqual([]);
        const selected = (await read())!.resources.find((r) => r.kind === 'triangle')!;
        expect(selected.matchesDraftLeaf).toBe(true); expect(selected.vertices).toHaveLength(18);
        await page.screenshot({ path: test.info().outputPath('painting-triangle-held-outline.png') });
        await startFrames();
        await page.mouse.move(bounds!.x + 10, bounds!.y + 10);
        await expect.poll(async () => (await read())!.rendered.candidates.length).toBe(0);
        await settleFrames();
        const missFrames = await stopFrames(); await completeFrames('painting-triangle-held-native-miss', missFrames);
        expect(missFrames.at(-1)!.draws.filter((draw) => draw.kind === 'painting-contour-triangle')).toEqual([]);
        expect(missFrames.flatMap((frame) => frame.draws).filter((draw) => draw.kind === 'painting-cursor-triangle' || draw.kind === 'painting-candidate')).toEqual([]);
        expect((await read())!.phase).toBe('drawing');
        await page.mouse.move(point.x, point.y);
        await expect.poll(async () => (await read())?.resources.find((r) => r.kind === 'triangle')?.matchesDraftLeaf).toBe(true);
      }
      // wheel() returns before dispatch; keep the stroke held until the
      // actual wheel event and its render frames finish before asserting.
      await page.evaluate(() => {
        (window as unknown as { __paintingHeldWheel?: Promise<void> }).__paintingHeldWheel = new Promise<void>((resolve) => {
          window.addEventListener('wheel', () => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), { capture: true, once: true });
        });
      });
      await page.mouse.wheel(0, 90);
      await page.evaluate(() => (window as unknown as { __paintingHeldWheel?: Promise<void> }).__paintingHeldWheel);
      expect((await read())!.camera).toEqual(drawingEvidence.camera);
      expect((await read())!.pivot).toEqual(drawingEvidence.pivot); expect((await read())!.target).toEqual(drawingEvidence.target);
      await page.mouse.move(point.x + 2, point.y + 2); await page.mouse.up(); await idle();
      expect((await committed()).paint.some((p) => p.groups.some((g) => g.stateId === 2 && g.indexCount > 0)), tool).toBe(true); await idle();
      if (tool === 'region') {
        await page.mouse.move(point.x + 1, point.y);
        await expect.poll(async () => (await read())!.rendered.candidates.length).toBeGreaterThan(0);
        await page.screenshot({ path: test.info().outputPath('painting-region.png') });
      }
      if (tool === 'circle') {
        // Retain the actual brush subdivisions and point inside the painted
        // patch. The candidate must identify one smaller current native leaf.
        const beforeHover = await history();
        await page.getByTestId('painting-tool-triangle').click();
        await page.mouse.move(point.x + 1.137, point.y + 0.719);
        await expect.poll(async () => (await read())?.resources.find((r) => r.kind === 'triangle')?.matchesDraftLeaf).toBe(true);
        const leaf = (await read())!.resources.find((r) => r.kind === 'triangle')!;
        expect(leaf.vertices).toHaveLength(18);
        const [a, b, c] = [0, 6, 12].map((i) => leaf.vertices!.slice(i, i + 3));
        const ab = b.map((v, i) => v - a[i]), ac = c.map((v, i) => v - a[i]);
        const area = Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) / 2;
        expect(area, 'Triangle highlights a subdivided leaf rather than its 200 mm² original cube face').toBeLessThan(200);
        expect(await history()).toEqual(beforeHover);
        await startFrames(); await settleFrames();
        const frames = await readFrames();
        expect(frames.at(-1)!.draws.find((draw) => draw.kind === 'painting-contour-triangle')?.geometry).toBe(leaf.contourGeometry);
        await page.screenshot({ path: test.info().outputPath('painting-triangle-subdivided-leaf.png') });
      }
      await page.getByTestId('history-undo').click(); await idle();
      expect((await committed()).paint).toHaveLength(0); await idle();
      if (tool === 'circle') {
        await settleFrames(); await completeFrames('painting-triangle-geometry-restore', await stopFrames());
        expect((await read())!.resources.filter((r) => r.kind === 'triangle')).toEqual([]);
        await page.getByTestId('painting-tool-circle').click();
      }
      await page.getByTestId('history-redo').click(); await idle();
      expect((await committed()).paint.some((p) => p.groups.some((g) => g.stateId === 2)), `redo ${tool}`).toBe(true); await idle();
      expect((await read())!.sessionId).toBe(sessionId);
      await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle();
    }
    await page.getByTestId('painting-tool-circle').click();
    await idle();
    const colourPoint = (await read())!.center;
    await page.mouse.move(colourPoint.x, colourPoint.y); await settleFrames();
    await startFrames(); await settleFrames();
    // Keyboard activation changes the production palette selection while the
    // mouse stays on-model, so cursor lifetime/order can be verified directly.
    for (const [slot, color] of [[1, 'ff0000'], [2, '00ff00']] as const) {
      const radio = page.getByRole('radio', { name: `Paint filament ${slot}`, exact: true });
      await radio.focus(); await page.keyboard.press('Space'); await expect(radio).toBeChecked();
      await expect.poll(async () => (await readFrames()).at(-1)?.draws.at(-1)?.cursor?.color).toBe(color);
    }
    await settleFrames();
    const colourFrames = await stopFrames(); await completeFrames('painting-selected-filament-cursor', colourFrames);
    expect(new Set(colourFrames.flatMap((frame) => frame.draws.flatMap((draw) => draw.cursor ? [draw.cursor.uuid] : []))).size).toBe(1);
    expect(new Set(colourFrames.flatMap((frame) => frame.painting)).size).toBe(1);
    expect(colourFrames.every((frame) => frame.draws.at(-1)?.kind === 'painting-cursor-circle')).toBe(true);
    expect(colourFrames.some((frame) => frame.draws.at(-1)?.cursor?.color === 'ff0000')).toBe(true);
    expect(colourFrames.some((frame) => frame.draws.at(-1)?.cursor?.color === '00ff00')).toBe(true);
    await page.getByRole('radio', { name: 'Paint filament 1', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Radius (mm)', exact: true }).fill('0.3');
    const gapPoint = (await read())!.center;
    await page.mouse.click(gapPoint.x, gapPoint.y); await idle();
    expect((await committed()).paint.some((p) => p.groups.some((g) => g.stateId === 1 && g.indexCount > 0))).toBe(true); await idle();
    await page.screenshot({ path: test.info().outputPath('painting-gap-before.png') });
    await page.getByTestId('painting-tool-gap').click(); await page.getByRole('spinbutton', { name: 'Gap area (mm²)', exact: true }).fill('3');
    await expect.poll(async () => (await read())!.rendered.candidates.length).toBeGreaterThan(0);
    const gapResources = (await read())!.resources.filter((r) => r.kind === 'gap');
    expect(gapResources.length).toBeGreaterThan(0);
    expect(gapResources.flatMap((r) => r.groups).every((g) => g[0] === 0)).toBe(true);
    expect(gapResources.every((r) => r.matchesDraftLeaf && r.vertices!.length > 0 && r.contour!.length === 0)).toBe(true);
    await settleFrames(); const gapHistory = await history();
    const assertGapFrames = async (name: string, frames: VisualFrame[], selections: typeof gapResources[]) => {
      await completeFrames(name, frames);
      expect(new Set(frames.flatMap((f) => f.painting)).size, 'static Gap refresh preserves draft geometry').toBe(1);
      for (const frame of frames) {
        const fill = frame.draws.filter((d) => d.kind === 'painting-candidate'), contour = frame.draws.filter((d) => d.kind === 'painting-contour');
        expect(fill, 'every expected static Gap frame draws native candidates').toHaveLength(gapResources.length);
        // Native Gap resources have no contour; preserve that appearance.
        expect(contour, 'Gap retains the native empty contour').toEqual([]);
        expect(selections.some((selection) => selection.every((r, i) =>
          JSON.stringify(r.vertices!.filter((_, j) => j % 6 < 3)) === JSON.stringify(fill[i].candidate!.positions)
          && r.contour!.length === 0)), 'candidate positions belong to one complete native Gap receipt').toBe(true);
        expect(frame.draws.filter((d) => d.kind.startsWith('painting-cursor-'))).toEqual([]);
      }
      expect(await history()).toEqual(gapHistory);
    };
    await startFrames(); await settleFrames();
    const outside = await page.locator('#app-tab-prepare').boundingBox();
    for (const point of [gapPoint, topFaces[0], { x: bounds!.x + 10, y: bounds!.y + 10 }, { x: outside!.x + outside!.width / 2, y: outside!.y + outside!.height / 2 }, gapPoint]) {
      await page.mouse.move(point.x, point.y, { steps: 8 }); await settleFrames();
    }
    // Zoom invokes the same hoverAt(undefined) path as camera gestures.
    await page.mouse.wheel(0, -20); await settleFrames();
    await assertGapFrames('painting-gap-static-move-leave', await stopFrames(), [gapResources]);
    const gapCameraEvidence: Array<{ start: string; before: Evidence; rotated: Evidence; restored: Evidence }> = [];
    const gapCommitted = await committed(); await idle(); await settleFrames();
    const gapPerformance = () => page.evaluate(() => {
      const value = (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingPerformanceEvidence();
      return { calls: value.calls, created: value.totalCreated, released: value.totalReleased };
    });
    for (const start of ['outside', 'surface']) {
      const before = (await read())!, nativeBefore = await gapPerformance();
      const origin = start === 'outside' ? { x: bounds!.x + 10, y: before.center.y } : before.center;
      const end = start === 'outside' ? before.center : { x: origin.x + 25, y: origin.y };
      await page.mouse.move(origin.x, origin.y); await startFrames(); await settleFrames();
      await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await settleFrames();
      const rotated = (await read())!;
      expect(rotated.phase).toBe('idle'); expect(rotated.camera.slice(3)).not.toEqual(before.camera.slice(3));
      near(rotated.pivot, before.pivot); near(rotated.pivotCamera, before.pivotCamera);
      near([rotated.center.x, rotated.center.y], [before.center.x, before.center.y]);
      expect(rotated.resources).toEqual(before.resources); expect(rotated.rendered).toEqual(before.rendered);
      // Reverse the horizontal orbit through normal pointer input, preserving
      // the view used by later native Gap Apply and the other tool assertions.
      await page.mouse.move(origin.x, origin.y, { steps: 8 }); await page.mouse.up(); await settleFrames();
      const restored = (await read())!;
      near(restored.camera, before.camera); near(restored.target, before.target);
      expect(restored.resources).toEqual(before.resources); expect(await gapPerformance()).toEqual(nativeBefore);
      await assertGapFrames(`painting-gap-${start}-camera-frames`, await stopFrames(), [gapResources]);
      expect(await committed()).toEqual(gapCommitted); await idle(); await settleFrames();
      gapCameraEvidence.push({ start, before, rotated, restored });
    }
    const gapCameraPath = test.info().outputPath('painting-gap-camera.json'); writeFileSync(gapCameraPath, JSON.stringify(gapCameraEvidence, null, 2));
    await test.info().attach('painting-gap-camera', { path: gapCameraPath, contentType: 'application/json' });
    const gapSelections = [gapResources];
    await startFrames(); await settleFrames();
    const area = page.getByRole('spinbutton', { name: 'Gap area (mm²)', exact: true });
    for (const value of ['4', '3', '4']) {
      const before = (await read())!.resources.find((r) => r.kind === 'gap')!.contourGeometry;
      await area.fill(value);
      await expect.poll(async () => {
        const leaf = (await read())?.resources.find((r) => r.kind === 'gap');
        return leaf?.matchesDraftLeaf === true && typeof leaf.contourGeometry === 'string' && leaf.contourGeometry !== before;
      }).toBe(true);
      const selection = (await read())!.resources.filter((r) => r.kind === 'gap');
      expect(selection).toHaveLength(gapResources.length); expect(selection.every((r) => r.matchesDraftLeaf)).toBe(true);
      gapSelections.push(selection); await settleFrames();
    }
    await assertGapFrames('painting-gap-static-settings', await stopFrames(), gapSelections);
    // A complete native empty result is allowed to remove the static preview.
    await area.fill('0'); await expect.poll(async () => (await read())!.rendered.candidates.length).toBe(0);
    await settleFrames(); expect((await read())!.resources.filter((r) => r.kind === 'gap')).toEqual([]); expect(await history()).toEqual(gapHistory);
    await area.fill('3'); await expect.poll(async () => (await read())!.rendered.candidates.length).toBeGreaterThan(0);
    expect((await read())!.resources.filter((r) => r.kind === 'gap').every((r) => r.matchesDraftLeaf && r.groups.every((g) => g[0] === 0))).toBe(true);
    await page.screenshot({ path: test.info().outputPath('painting-gap.png') });
    await page.getByRole('button', { name: 'Apply gap fill', exact: true }).click(); await idle();
    expect((await committed()).paint).toHaveLength(0); await idle();
    await page.getByTestId('painting-tool-circle').click();
    let point = (await read())!.center;
    await page.mouse.move(point.x, point.y); const beforeSize = (await read())!;
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
    expect((await read())!.settings.radius).toBeGreaterThan(beforeSize.settings.radius); expect((await read())!.camera).toEqual(beforeSize.camera);
    await page.mouse.down(); await expect.poll(async () => (await read())?.phase).toBe('drawing');
    for (const command of ['Control+s', 'Control+o', 'Control+n']) await page.keyboard.press(command);
    expect((await read())!.phase).toBe('drawing');
    await expect(page.getByTestId('project-dirty-dialog')).toHaveCount(0);
    expect(existsSync(savedProject)).toBe(false);
    await page.keyboard.press('Escape'); await page.mouse.up(); await idle(); expect((await committed()).paint).toHaveLength(0); await idle();
    expect(existsSync(savedProject)).toBe(false);
    await page.keyboard.press('Control+Shift+s');
    await expect.poll(() => existsSync(savedProject)).toBe(true); await idle();
    expect((await read())!.sessionId).toBe(sessionId);
    const navigationEvidence: Array<{ button: string; before: Evidence; after: Evidence }> = [];
    for (const button of ['middle', 'right', 'left'] as const) {
      const before = (await read())!; point = before.center;
      if (button === 'left') await page.keyboard.down('Control');
      await page.mouse.move(point.x, point.y); await page.mouse.down({ button }); await page.mouse.move(point.x + 25, point.y + 15, { steps: 5 }); await page.mouse.up({ button });
      if (button === 'left') await page.keyboard.up('Control');
      const after = (await read())!; navigationEvidence.push({ button, before, after });
      expect(after.camera).not.toEqual(before.camera); near(after.pivot, before.pivot);
      if (button === 'left') {
        // Both pans move framing before this orbit. The model centre retains
        // its camera-space position and screen projection under rigid orbit.
        expect(after.target).not.toEqual(before.target); expect(after.camera.slice(3)).not.toEqual(before.camera.slice(3));
        near(after.pivotCamera, before.pivotCamera); near([after.center.x, after.center.y], [before.center.x, before.center.y]);
      } else {
        expect(after.target).not.toEqual(before.target); expect(after.pivotCamera).not.toEqual(before.pivotCamera);
      }
    }
    const navigationPath = test.info().outputPath('painting-camera-pivot.json'); writeFileSync(navigationPath, JSON.stringify(navigationEvidence, null, 2));
    await test.info().attach('painting-camera-pivot', { path: navigationPath, contentType: 'application/json' });
    await page.getByTestId('painting-tool-triangle').click();
    await page.getByRole('radio', { name: 'Paint filament 2', exact: true }).click();
    point = (await read())!.center;
    await page.mouse.click(point.x, point.y); await idle();
    expect((await committed()).paint.some((part) => part.groups.some((group) => group.stateId === 2 && group.indexCount > 0))).toBe(true);
    expect((await read())!.error).toBeNull();
    const beforeClose = (await read())!;
    const beforeCloseCamera = { position: beforeClose.camera.slice(0, 3), quaternion: beforeClose.camera.slice(3), target: beforeClose.target };
    const expandedHistory = await history();
    expect(expandedHistory.editingSession).not.toBeNull();
    expect(expandedHistory.undoEntries.filter((entry: { label: string }) => entry.label === 'Paint').length).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Close painting', exact: true }).click(); await expect(page.getByTestId('painting-panel')).toHaveCount(0);
    await expect(page.getByTestId('plate-controls')).toBeVisible();
    await expect(paintButton).toHaveAttribute('aria-pressed', 'false'); await leaveToolbar();
    await expect.poll(() => toolbarColors(paintButton)).toEqual(inactivePaintColors);
    toolbarEvidence.closedAfterSession = await toolbarColors(paintButton);
    const compactedHistory = await history();
    expect(compactedHistory.editingSession).toBeNull();
    expect(compactedHistory.undoEntries.filter((entry: { label: string }) => entry.label === 'Paint')).toHaveLength(1);
    const cameraUnchanged = async () => {
      const after = await cameraPose();
      return (['position', 'quaternion', 'target'] as const).every((key) => after[key].every((value: number, i: number) => Math.abs(value - beforeCloseCamera[key][i]) < 1e-10));
    };
    // OrbitControls recomputes spherical coordinates on re-entry; allow only floating-point roundoff.
    await expect.poll(cameraUnchanged).toBe(true);
    await page.screenshot({ path: test.info().outputPath('prepare-after-painting.png') });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await cameraUnchanged()).toBe(true);
    await expect(page.getByTestId('gizmo-btn-paint')).toBeEnabled(); await page.getByTestId('gizmo-btn-paint').click(); await idle();
    await assertPaintingArmed('reopened');
    expect((await read())!.sessionId).not.toBe(sessionId);
    const slot2Badge = page.getByTestId('filament-slot-2').locator('label').filter({ has: page.getByLabel('Slot 2 colour', { exact: true }) });
    const originalSlot2Colour = await slot2Badge.evaluate((element) => getComputedStyle(element).backgroundColor);
    const setSlot2Colour = async (colour: string, cssColour: string) => {
      await page.getByTestId('filament-colour-2').evaluate((element, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, colour);
      await expect(slot2Badge).toHaveCSS('background-color', cssColour);
      await expect(page.getByTestId('filament-rejected')).toHaveCount(0);
      await expect.poll(async () => (await history()).undoEntries[0]?.label).toBe('Edit Filament Colour');
    };
    const beforeRgb = (await read())!;
    await page.getByTestId('painting-tool-sphere').click(); await idle();
    const slot2 = page.getByRole('radio', { name: 'Paint filament 2', exact: true });
    await slot2.focus(); await page.keyboard.press('Space'); await expect(slot2).toBeChecked();
    const rgbPoint = (await read())!.center;
    await page.mouse.move(rgbPoint.x, rgbPoint.y); await settleFrames();
    await startFrames(); await settleFrames();
    await setSlot2Colour('#445566', 'rgb(68, 85, 102)'); await idle();
    await expect.poll(() => page.evaluate(() => ((window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.paintingVisualFrames() as VisualFrame[]).some((f) => f.colors.includes('445566')))).toBe(true);
    await settleFrames();
    const rgbFrames = await stopFrames(); await completeFrames('painting-rgb-render-frames', rgbFrames);
    expect(rgbFrames.every((f) => f.ordinary.length === 0 && f.painting.length > 0)).toBe(true);
    expect(new Set(rgbFrames.flatMap((f) => f.painting)).size, 'RGB-only edit retains rendered geometry identity').toBe(1);
    expect(rgbFrames.some((f) => f.colors.includes('445566')), 'new RGB reaches the actual rendered target material').toBe(true);
    expect(rgbFrames.every((frame) => frame.draws.at(-1)?.kind === 'painting-cursor-sphere')).toBe(true);
    expect(new Set(rgbFrames.flatMap((frame) => frame.draws.flatMap((draw) => draw.cursor ? [draw.cursor.uuid] : []))).size).toBe(1);
    const highlighted = rgbFrames.flatMap((frame) => frame.draws).filter((draw) => draw.cursor?.color === '556a80');
    expect(highlighted.length, 'new RGB reaches the actual cursor with Orca highlight').toBeGreaterThan(0);
    const expectedEncoded = [85 / 255, 106.25 / 255, 127.5 / 255];
    for (const draw of highlighted) {
      expect(draw.cursor).toMatchObject({ transparent: true, opacity: 0.25, wireframe: false, depthTest: true, depthWrite: false });
      expectedEncoded.forEach((channel, i) => {
        expect(draw.cursor!.encodedRgb[i]).toBeCloseTo(channel, 4);
        const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        expect(draw.cursor!.linearRgb[i]).toBeCloseTo(linear, 6);
      });
    }
    await page.screenshot({ path: test.info().outputPath('painting-sphere-highlighted-cursor.png') });
    const afterRgb = (await read())!; near(afterRgb.pivot, beforeRgb.pivot); near(afterRgb.camera, beforeRgb.camera); near(afterRgb.target, beforeRgb.target);
    await page.getByTestId('history-undo').click(); await idle();
    await expect(slot2Badge).toHaveCSS('background-color', originalSlot2Colour);
    await page.getByTestId('history-redo').click(); await idle();
    await expect(slot2Badge).toHaveCSS('background-color', 'rgb(68, 85, 102)');
    await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle();
    expect((await committed()).paint).toHaveLength(0);
    await page.getByRole('radio', { name: 'Paint filament 2', exact: true }).click();
    point = (await read())!.center;
    const beforeFirstStroke = await history();
    await page.mouse.click(point.x, point.y); await idle();
    expect((await committed()).paint.some((part) => part.groups.some((group) => group.stateId === 2 && group.indexCount > 0))).toBe(true);
    const afterFirstStroke = await history();
    expect(afterFirstStroke.revision).toBeGreaterThan(beforeFirstStroke.revision);
    expect(afterFirstStroke.undoEntries[0]).toMatchObject({ label: 'Paint' });
    expect(afterFirstStroke.undoEntries[0].id).not.toBe(beforeFirstStroke.undoEntries[0].id);
    await setSlot2Colour('#667788', 'rgb(102, 119, 136)');
    await page.getByTestId('history-undo').click(); await idle();
    await expect(slot2Badge).toHaveCSS('background-color', 'rgb(68, 85, 102)');
    await page.getByTestId('history-redo').click(); await idle();
    await expect(slot2Badge).toHaveCSS('background-color', 'rgb(102, 119, 136)');
    await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle();
    expect((await committed()).paint).toHaveLength(0);
    await page.mouse.click(point.x, point.y); await idle();
    expect((await committed()).paint.some((part) => part.groups.some((group) => group.stateId === 2 && group.indexCount > 0))).toBe(true);
    expect((await history()).undoEntries.slice(0, 4).map((entry: { label: string }) => entry.label)).toEqual(['Paint', 'Paint', 'Edit Filament Colour', 'Paint']);
    await page.getByTestId('gizmo-btn-move').click(); await expect(page.getByTestId('painting-panel')).toHaveCount(0); await expect(page.getByTestId('move-panel')).toBeVisible();
    await expect(paintButton).toHaveAttribute('aria-pressed', 'false'); await expect(moveButton).toHaveAttribute('aria-pressed', 'true');
    await leaveToolbar(); await expect.poll(() => toolbarColors(moveButton)).toEqual(armedColors);
    await expect.poll(() => toolbarColors(paintButton)).toEqual(inactivePaintColors);
    toolbarEvidence.switchedToMove = { paint: await toolbarColors(paintButton), transform: await toolbarColors(moveButton) };
    await page.getByTestId('gizmo-btn-paint').click(); await idle();
    await assertPaintingArmed('switchedBackToPaint', true);
    const toolbarPath = test.info().outputPath('painting-toolbar-active.json');
    writeFileSync(toolbarPath, JSON.stringify(toolbarEvidence, null, 2));
    await test.info().attach('painting-toolbar-active', { path: toolbarPath, contentType: 'application/json' });
    // Dedicated seam entry: all controls use the real shared controller/Worker.
    const seamButton = page.getByTestId('gizmo-btn-seam');
    expect(await page.getByTestId('gizmo-btn-support').count()).toBe(1);
    expect(await page.getByTestId('gizmo-btn-fuzzy').count()).toBe(1);
    const mmuParameters = {tool:(await read())!.tool,settings:(await read())!.settings};
    const seamEvidence: Record<string, unknown> = {};
    await seamButton.click(); await idle();
    await expect(seamButton).toHaveAttribute('aria-pressed','true'); await expect(paintButton).toHaveAttribute('aria-pressed','false');
    expect((await read())!.channel).toBe('seam');
    await assertBlankStart('seam'); expect((await read())!.resources.flatMap(r=>r.groups.map(g=>g[0]))).toEqual([0]);
    await page.getByRole('spinbutton',{name:'Radius (mm)',exact:true}).fill('1');
    await page.getByRole('checkbox',{name:'Vertical',exact:true}).check();
    // Rotate the camera by actual navigation before the constrained stroke.
    let seamCenter = (await read())!.center;
    await page.mouse.move(seamCenter.x,seamCenter.y); await page.keyboard.down('Control'); await page.mouse.down();
    await page.mouse.move(seamCenter.x+35,seamCenter.y+15,{steps:5}); await page.mouse.up(); await page.keyboard.up('Control');
    seamCenter = (await read())!.center;
    const seamBefore = await history(); await startFrames();
    await page.mouse.move(seamCenter.x,seamCenter.y); await page.mouse.down(); await expect.poll(async()=> (await read())?.phase).toBe('drawing');
    const drawingSession = (await read())!.sessionId;
    await expect(paintButton).toBeDisabled(); await expect(seamButton).toBeDisabled();
    await paintButton.evaluate(button=>(button as HTMLButtonElement).click());
    await page.mouse.move(seamCenter.x+25,seamCenter.y+8,{steps:4});
    await expect.poll(async()=> (await read())?.cursor).not.toBeNull();
    const projectedCursor = await page.evaluate(() => { const hooks=(window as unknown as {__orcaE2e:Record<string,any>}).__orcaE2e; return hooks.paintingWorldToScreen(hooks.paintingEvidence().cursor); });
    expect(projectedCursor.x).toBeCloseTo(seamCenter.x,3); expect(projectedCursor.y).toBeCloseTo(seamCenter.y+8,3);
    expect((await read())!.sessionId).toBe(drawingSession);
    await page.screenshot({path:test.info().outputPath('seam-vertical-rotated-camera.png')});
    await page.mouse.up(); await idle();
    const enforcedCounts = await page.evaluate(()=> (window as unknown as {__orcaE2e:Record<string,any>}).__orcaE2e.paintingNativeFacetCounts());
    expect(enforcedCounts[0].facetCounts[1]).toBeGreaterThan(0); expect((await history()).undoEntries.length).toBe(seamBefore.undoEntries.length+1);
    await settleFrames(); const seamFrames=await stopFrames(); await completeFrames('seam-enforce-actual-draw',seamFrames);
    expect(seamFrames.some(f=>f.colors.includes('80ff80'))).toBe(true);
    seamEvidence.enforce={counts:enforcedCounts,cursor:projectedCursor,screenAnchor:seamCenter,frames:seamFrames};
    // Block with sphere, then local Shift erase. Right/middle retain pan semantics.
    await page.getByTestId('painting-tool-sphere').click(); await page.getByRole('radio',{name:'Block',exact:true}).click();
    seamCenter=(await read())!.center; await page.mouse.click(seamCenter.x,seamCenter.y); await idle();
    const blockedCounts=await page.evaluate(()=> (window as unknown as {__orcaE2e:Record<string,any>}).__orcaE2e.paintingNativeFacetCounts());
    expect(blockedCounts[0].facetCounts[2]).toBeGreaterThan(0);
    await page.keyboard.down('Shift'); await page.mouse.click(seamCenter.x,seamCenter.y); await page.keyboard.up('Shift'); await idle();
    const erasedCounts=await page.evaluate(()=> (window as unknown as {__orcaE2e:Record<string,any>}).__orcaE2e.paintingNativeFacetCounts());
    expect(erasedCounts[0].facetCounts[2]).toBeLessThan(blockedCounts[0].facetCounts[2]);
    // History restores annotations/transforms; draft keys advance monotonically.
    const annotationParts=(parts: Array<Record<string,unknown>>) => parts.map(({draftResourceId,...part})=>part);
    await page.getByTestId('history-undo').click(); await idle();
    expect(annotationParts(await page.evaluate(()=> (window as unknown as {__orcaE2e:Record<string,any>}).__orcaE2e.paintingNativeFacetCounts()))).toEqual(annotationParts(blockedCounts));
    await page.getByTestId('history-redo').click(); await idle();
    expect(annotationParts(await page.evaluate(()=> (window as unknown as {__orcaE2e:Record<string,any>}).__orcaE2e.paintingNativeFacetCounts()))).toEqual(annotationParts(erasedCounts));
    const seamRadius=(await read())!.settings.radius; await page.mouse.move(seamCenter.x,seamCenter.y); await page.keyboard.down('Control'); await page.mouse.wheel(0,-1); await page.keyboard.up('Control');
    await expect.poll(async()=> (await read())!.settings.radius).toBeCloseTo(seamRadius+.2,6);
    const beforeCancel=await history(); await page.mouse.move(seamCenter.x,seamCenter.y); await page.mouse.down();
    await expect.poll(async()=> (await read())?.phase).toBe('drawing'); await page.keyboard.press('Escape'); await page.mouse.up(); await idle();
    expect((await history()).undoEntries.length).toBe(beforeCancel.undoEntries.length);
    for (const button of ['middle','right'] as const) {
      const before=(await read())!; const h=await history(); await page.mouse.move(seamCenter.x,seamCenter.y); await page.mouse.down({button});
      await page.mouse.move(seamCenter.x+10,seamCenter.y+5,{steps:3}); await page.mouse.up({button});
      expect((await read())!.camera).not.toEqual(before.camera); expect((await history()).undoEntries.length).toBe(h.undoEntries.length);
    }
    // Close failure leaves seam active and prevents MMU opening; an explicit retry succeeds.
    const seamParameters={tool:(await read())!.tool,settings:(await read())!.settings};
    await page.evaluate(()=> (window as unknown as {__orcaE2e:Record<string,any>}).__orcaE2e.paintingFailNextClose());
    await paintButton.click(); await expect(page.getByRole('alert')).toContainText('Injected painting close failure');
    expect((await read())!.channel).toBe('seam'); await expect(seamButton).toHaveAttribute('aria-pressed','true');
    await paintButton.click(); await idle(); expect((await read())!.channel).toBe('mmu');
    expect({tool:(await read())!.tool,settings:(await read())!.settings}).toEqual(mmuParameters);
    await seamButton.click(); await idle(); expect({tool:(await read())!.tool,settings:(await read())!.settings}).toEqual(seamParameters);
    await seamButton.click(); await expect(page.getByTestId('painting-panel')).toHaveCount(0);
    await startFrames(); await settleFrames(); const ordinaryAfterSeam=await stopFrames();
    await completeFrames('seam-close-ordinary-MMU',ordinaryAfterSeam);
    expect(ordinaryAfterSeam.every(frame=>frame.painting.length===0 && frame.ordinary.length>0)).toBe(true);
    expect(ordinaryAfterSeam.some(frame=>frame.colors.includes('80ff80') || frame.colors.includes('ff8080'))).toBe(false);
    const seamPath=test.info().outputPath('seam-editor-evidence.json'); writeFileSync(seamPath,JSON.stringify(seamEvidence,null,2));
    await test.info().attach('seam-editor-evidence',{path:seamPath,contentType:'application/json'});
    // Fuzzy is a separate, single-filament-capable editor sharing the mounted
    // controller. Brushing remains independent from scoped configuration.
    const fuzzyButton=page.getByTestId('gizmo-btn-fuzzy');
    await fuzzyButton.click();await idle();
    await expect(fuzzyButton).toHaveAttribute('aria-pressed','true');await expect(paintButton).toHaveAttribute('aria-pressed','false');
    expect((await read())!.channel).toBe('fuzzy');
    await assertBlankStart('fuzzy');
    await expect(page.getByTestId('fuzzy-disabled-warning')).toBeVisible();
    const fuzzyEvidence:Record<string,unknown>={};
    await page.getByRole('spinbutton',{name:'Radius (mm)',exact:true}).fill('1');
    let fuzzyCenter=(await read())!.center;
    await startFrames();await page.mouse.click(fuzzyCenter.x,fuzzyCenter.y);await idle();
    await expect(page.getByTestId('fuzzy-disabled-warning')).toBeVisible();
    const fuzzyCircle=await page.evaluate(()=> (window as unknown as {__orcaE2e:Record<string,any>}).__orcaE2e.paintingNativeFacetCounts());
    expect(fuzzyCircle[0].facetCounts[1]).toBeGreaterThan(0);expect(fuzzyCircle[0].facetCounts.slice(2).every((count:number)=>count===0)).toBe(true);
    await settleFrames();const fuzzyFrames=await stopFrames();await completeFrames('fuzzy-enable-actual-draw',fuzzyFrames);expect(fuzzyFrames.some(f=>f.colors.includes('80ff80'))).toBe(true);
    const beforeEnable=await history();
    await page.getByRole('button',{name:'Enable painted fuzzy skin',exact:true}).click();await idle();
    await expect(page.getByTestId('fuzzy-disabled-warning')).toHaveCount(0);await expect(page.getByTestId('fuzzy-effective-configuration')).toContainText('Painted only (object)');
    expect((await history()).undoEntries.length).toBe(beforeEnable.undoEntries.length+1);
    expect((await history()).undoEntries[0].label).toBe('Change Scoped Configuration');
    const fuzzyCounts=()=>page.evaluate(()=> (window as unknown as {__orcaE2e:Record<string,any>}).__orcaE2e.paintingNativeFacetCounts());
    expect(annotationParts(await fuzzyCounts())).toEqual(annotationParts(fuzzyCircle));
    await page.getByTestId('history-undo').click();await idle();await expect(page.getByTestId('fuzzy-disabled-warning')).toBeVisible();expect(annotationParts(await fuzzyCounts())).toEqual(annotationParts(fuzzyCircle));
    await page.getByTestId('history-redo').click();await idle();await expect(page.getByTestId('fuzzy-disabled-warning')).toHaveCount(0);
    for(const tool of ['sphere','triangle','smartFill']){
      await page.getByRole('button',{name:'Erase all',exact:true}).click();await idle();expect((await fuzzyCounts())[0].facetCounts[1]).toBe(0);
      await page.getByTestId(`painting-tool-${tool}`).click();await idle();
      if(tool==='smartFill')await page.getByRole('spinbutton',{name:'Edge angle (degrees)',exact:true}).fill('90');
      fuzzyCenter=(await read())!.center;await page.mouse.move(fuzzyCenter.x,fuzzyCenter.y);
      if(tool!=='sphere')await expect.poll(async()=> (await read())!.rendered.candidates.length).toBeGreaterThan(0);
      await page.mouse.click(fuzzyCenter.x,fuzzyCenter.y);await idle();expect((await fuzzyCounts())[0].facetCounts[1]).toBeGreaterThan(0);
    }
    await page.getByTestId('painting-tool-circle').click();await idle();await page.getByRole('radio',{name:'Erase',exact:true}).click();
    fuzzyCenter=(await read())!.center;await page.mouse.click(fuzzyCenter.x,fuzzyCenter.y);await idle();
    const fuzzyParameters={tool:(await read())!.tool,settings:(await read())!.settings};
    fuzzyEvidence.parameters=fuzzyParameters;fuzzyEvidence.facets=await fuzzyCounts();fuzzyEvidence.frames=fuzzyFrames;
    await seamButton.click();await idle();expect((await read())!.channel).toBe('seam');expect({tool:(await read())!.tool,settings:(await read())!.settings}).toEqual(seamParameters);
    await fuzzyButton.click();await idle();expect({tool:(await read())!.tool,settings:(await read())!.settings}).toEqual(fuzzyParameters);
    await fuzzyButton.click();await expect(page.getByTestId('painting-panel')).toHaveCount(0);
    await startFrames();await settleFrames();const ordinaryAfterFuzzy=await stopFrames();await completeFrames('fuzzy-close-ordinary-MMU',ordinaryAfterFuzzy);
    expect(ordinaryAfterFuzzy.every(frame=>frame.painting.length===0&&frame.ordinary.length>0)).toBe(true);
    expect(ordinaryAfterFuzzy.some(frame=>frame.colors.includes('80ff80'))).toBe(false);
    const fuzzyPath=test.info().outputPath('fuzzy-editor-evidence.json');writeFileSync(fuzzyPath,JSON.stringify(fuzzyEvidence,null,2));await test.info().attach('fuzzy-editor-evidence',{path:fuzzyPath,contentType:'application/json'});
    // Support's independent native overlay survives candidate/tool/stroke changes.
    const supportButton=page.getByTestId('gizmo-btn-support');await supportButton.click();await idle();
    await assertBlankStart('support');
    expect((await read())!.channel).toBe('support');await expect(supportButton).toHaveAttribute('aria-pressed','true');
    const supportCounts=()=>page.evaluate(()=> (window as unknown as {__orcaE2e:Record<string,any>}).__orcaE2e.paintingNativeFacetCounts());
    const supportEvidence:Record<string,unknown>={};
    const beforeHighlight=await history();
    await page.getByRole('checkbox',{name:'Highlight overhangs',exact:true}).check();
    await expect.poll(async()=> (await read())!.resources.filter(r=>r.kind==='overhang').length).toBeGreaterThan(0);
    const initialHighlight=await read();expect((await history()).undoEntries.length).toBe(beforeHighlight.undoEntries.length);
    await page.getByTestId('painting-tool-smartFill').click();await page.getByRole('spinbutton',{name:'Edge angle (degrees)',exact:true}).fill('90');
    let supportCenter=(await read())!.center;await page.mouse.move(supportCenter.x,supportCenter.y);
    await expect.poll(async()=> (await read())!.resources.filter(r=>r.kind==='smartFill').length).toBeGreaterThan(0);
    expect((await read())!.resources.filter(r=>r.kind==='overhang')).toEqual(initialHighlight!.resources.filter(r=>r.kind==='overhang'));
    await startFrames();await settleFrames();const supportOverlayFrames=await stopFrames();
    await page.screenshot({path:test.info().outputPath('support-smart-fill-overhang-editor.png')});
    expect(supportOverlayFrames.some(f=>f.draws.some(d=>d.candidate?.color==='ffb347')&&f.draws.some(d=>d.candidate?.color==='ffffff'))).toBe(true);
    for(const frame of supportOverlayFrames){const overlays=frame.draws.filter(d=>d.candidate);expect(overlays.every(d=>d.candidate!.depthWrite===false)).toBe(true);const highlight=overlays.find(d=>d.candidate!.color==='ffb347'),candidate=overlays.find(d=>d.candidate!.color==='ffffff');if(highlight&&candidate){expect(highlight.renderOrder).toBeLessThan(candidate.renderOrder);expect(highlight.candidate!.polygonOffsetFactor).toBeGreaterThan(candidate.candidate!.polygonOffsetFactor);}}
    await page.mouse.click(supportCenter.x,supportCenter.y);await idle();expect((await supportCounts())[0].facetCounts[1]).toBeGreaterThan(0);
    expect((await read())!.resources.some(r=>r.kind==='overhang')).toBe(true);
    await page.getByTestId('painting-tool-sphere').click();await page.getByRole('radio',{name:'Block',exact:true}).click();
    await page.getByRole('spinbutton',{name:'Radius (mm)',exact:true}).fill('1');supportCenter=(await read())!.center;
    await page.mouse.click(supportCenter.x,supportCenter.y);await idle();const supportBlocked=await supportCounts();expect(supportBlocked[0].facetCounts[2]).toBeGreaterThan(0);
    await page.getByRole('radio',{name:'Erase',exact:true}).click();await page.mouse.click(supportCenter.x,supportCenter.y);await idle();const supportErased=await supportCounts();expect(supportErased[0].facetCounts[2]).toBeLessThan(supportBlocked[0].facetCounts[2]);
    await page.getByTestId('history-undo').click();await idle();expect(annotationParts(await supportCounts())).toEqual(annotationParts(supportBlocked));
    await page.getByTestId('history-redo').click();await idle();expect(annotationParts(await supportCounts())).toEqual(annotationParts(supportErased));
    await page.getByTestId('painting-tool-gap').click();await idle();
    await expect(page.getByRole('checkbox',{name:'Restrict to overhangs',exact:true})).toBeDisabled();
    const beforeGap=await history();await page.getByRole('spinbutton',{name:'Gap area (mm²)',exact:true}).fill('0');await page.getByRole('button',{name:'Apply gaps',exact:true}).click();await idle();
    expect((await history()).undoEntries.length).toBe(beforeGap.undoEntries.length);
    await page.getByTestId('painting-tool-circle').click();await page.getByRole('spinbutton',{name:'Overhang angle (degrees)',exact:true}).fill('90');await page.getByRole('checkbox',{name:'Restrict to overhangs',exact:true}).check();
    await expect.poll(async()=> (await read())!.resources.some(r=>r.kind==='overhang')).toBe(true);
    await page.getByRole('checkbox',{name:'Highlight overhangs',exact:true}).uncheck();await expect.poll(async()=> (await read())!.resources.some(r=>r.kind==='overhang')).toBe(false);
    const supportParameters={tool:(await read())!.tool,settings:(await read())!.settings};supportEvidence.parameters=supportParameters;supportEvidence.blocked=supportBlocked;supportEvidence.erased=supportErased;supportEvidence.overlayFrames=supportOverlayFrames;
    await fuzzyButton.click();await idle();expect({tool:(await read())!.tool,settings:(await read())!.settings}).toEqual(fuzzyParameters);
    await supportButton.click();await idle();expect({tool:(await read())!.tool,settings:(await read())!.settings}).toEqual(supportParameters);
    await supportButton.click();await expect(page.getByTestId('painting-panel')).toHaveCount(0);
    await startFrames();await settleFrames();const ordinaryAfterSupport=await stopFrames();await completeFrames('support-close-ordinary-MMU',ordinaryAfterSupport);
    expect(ordinaryAfterSupport.every(frame=>frame.painting.length===0&&frame.ordinary.length>0)).toBe(true);
    expect(ordinaryAfterSupport.some(frame=>frame.colors.includes('80ff80')||frame.colors.includes('ff8080')||frame.colors.includes('ffb347'))).toBe(false);
    const supportPath=test.info().outputPath('support-editor-evidence.json');writeFileSync(supportPath,JSON.stringify(supportEvidence,null,2));await test.info().attach('support-editor-evidence',{path:supportPath,contentType:'application/json'});
    await paintButton.click(); await idle();
    const hiddenSession = (await read())!.sessionId;
    for (const tab of ['home', 'device']) {
      await page.locator(`#app-tab-${tab}`).click();
      await page.locator('#app-tab-prepare').click(); await idle();
      expect((await read())!.sessionId).toBe(hiddenSession);
    }
    await page.locator('#app-tab-home').click();
    await page.locator('#app-tab-preview').click();
    await expect(page.locator('#app-tab-preview')).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('painting-panel')).toHaveCount(0);
  } catch (error) {
    const page = await app.firstWindow();
    const diagnostics = await page.evaluate(() => {
      const value = window as unknown as { __orcaE2e: Record<string, any>; __paintingInputDiagnostics: unknown[] };
      return { state: value.__orcaE2e.paintingEvidence(), native: value.__orcaE2e.paintingPerformanceEvidence(), inputs: value.__paintingInputDiagnostics };
    });
    const path = test.info().outputPath('painting-failure-state.json');
    writeFileSync(path, JSON.stringify(diagnostics, null, 2));
    await test.info().attach('painting-failure-state', { path, contentType: 'application/json' });
    throw error;
  } finally { await app.close(); }
});
