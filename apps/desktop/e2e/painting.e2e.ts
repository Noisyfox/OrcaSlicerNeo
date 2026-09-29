import { _electron, expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';


const project = process.env.ORCA_E2E_PAINTED_FACET_PROJECT;
test.skip(process.env.ORCA_E2E_REAL !== '1' || !project, 'run scripts/run-painting-e2e.mjs with current serial artifacts');
test.setTimeout(480_000);
type Evidence = { phase: string; tool: string; sessionId: string; camera: number[]; target: number[]; center: { x: number; y: number }; settings: { radius: number }; resources: { kind: string; groups: number[][]; hasBvh: boolean }[]; rendered: { revision: number; candidates: string[] }; ordinaryModels: number; runtime: { threaded: boolean }; error: string | null };
type Committed = { paint: { groups: { stateId: number; indexCount: number }[] }[] };

test('real painting gizmo routes six tools, native edits, history, camera and close', async () => {
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-painting-')), 'preferences.json');
  const savedProject = join(resolve(preferences, '..'), 'painting-saved.3mf');
  writeFileSync(preferences, JSON.stringify({ version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_MODEL: project!, ORCA_E2E_PRIME_TOWER_PROJECT: project!, ORCA_E2E_PREFERENCES: preferences, ORCA_E2E_PROJECT_SAVE: savedProject } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('menu-file-trigger').click(); await page.getByTestId('file-open-project').click();
    await expect.poll(() => page.evaluate(() => !!document.querySelector('[data-testid="project-load-choice-dialog"], [data-testid="project-load-confirmation-dialog"], [data-testid="project-progress-dialog"]') || !!(window as unknown as { __orcaE2e?: Record<string, any> }).__orcaE2e?.projectLoadEvidence?.().receipt)).toBe(true);
    if (await page.getByTestId('project-load-choice-dialog').isVisible()) { await page.getByTestId('project-load-project').click(); await page.getByTestId('project-load-confirm').click(); }
    await expect.poll(() => page.evaluate(() => !!document.querySelector('[data-testid="project-load-confirmation-dialog"]') || !!(window as unknown as { __orcaE2e?: Record<string, any> }).__orcaE2e?.projectLoadEvidence?.().receipt), { timeout: 120_000 }).toBe(true);
    if (await page.getByTestId('project-load-confirmation-dialog').isVisible()) await page.getByTestId('project-load-confirmation-dialog-continue').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __orcaE2e?: Record<string, any> }).__orcaE2e?.projectLoadEvidence?.().receipt), { timeout: 60_000 }).toMatchObject({ sourceDisplayName: basename(project!), sourceByteLength: statSync(project!).size, nativeResult: { ok: true, objects: 1, instances: 2 } });
    const center = await page.evaluate(() => {
      const hooks = (window as unknown as { __orcaE2e?: Record<string, any> }).__orcaE2e as unknown as { modelWorldCenters(): [number, number, number][]; projectWorldToScreen(p: [number, number, number]): { x: number; y: number } };
      return hooks.projectWorldToScreen(hooks.modelWorldCenters()[0]);
    });
    const bounds = await page.getByTestId('viewport').boundingBox();
    await page.mouse.click(bounds!.x + center.x, bounds!.y + center.y);
    await expect(page.getByTestId('gizmo-btn-paint')).toBeEnabled(); await page.getByTestId('gizmo-btn-paint').click();
    const read = () => page.evaluate(() => ((window as unknown as { __orcaE2e?: Record<string, any> }).__orcaE2e?.paintingEvidence as (() => Evidence) | undefined)?.() ?? null);
    const committed = () => page.evaluate(() => ((window as unknown as { __orcaE2e?: Record<string, any> }).__orcaE2e?.paintingCommittedEvidence as () => Promise<Committed>)());
    const idle = async () => { await expect(page.getByTestId('painting-panel')).toHaveAttribute('data-phase', 'idle'); await expect.poll(async () => (await read())?.resources.length ?? 0).toBeGreaterThan(0); };
    await idle();
    const initialPoint = (await read())!.center;
    await page.mouse.move(initialPoint.x, initialPoint.y); await page.mouse.wheel(0, -700); await page.mouse.wheel(0, -700);
    expect((await read())!.runtime.threaded).toBe(false);
    expect((await read())!.ordinaryModels).toBe(0);
    expect((await read())!.resources.every((r) => !r.hasBvh)).toBe(true);
    const sessionId = (await read())!.sessionId;
    await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle();
    expect((await committed()).paint).toHaveLength(0); await idle();
    await page.getByRole('radio', { name: 'Paint filament 2', exact: true }).click();
    for (const tool of ['circle', 'sphere', 'triangle', 'height', 'region']) {
      await page.getByTestId(`painting-tool-${tool}`).click();
      if (tool === 'circle' || tool === 'sphere') await page.getByRole('spinbutton', { name: 'Radius (mm)', exact: true }).fill('4');
      if (tool === 'height') await page.getByRole('spinbutton', { name: 'Height (mm)', exact: true }).fill('5');
      const point = (await read())!.center;
      await page.mouse.move(point.x, point.y); await page.mouse.down();
      await expect.poll(async () => (await read())?.phase).toBe('drawing');
      const camera = (await read())!.camera;
      await page.mouse.wheel(0, 90); expect((await read())!.camera).toEqual(camera);
      await page.mouse.move(point.x + 2, point.y + 2); await page.mouse.up(); await idle();
      expect((await committed()).paint.some((p) => p.groups.some((g) => g.stateId === 2 && g.indexCount > 0)), tool).toBe(true); await idle();
      if (tool === 'region') {
        await page.mouse.move(point.x + 1, point.y);
        await expect.poll(async () => (await read())!.rendered.candidates.length).toBeGreaterThan(0);
        await page.screenshot({ path: test.info().outputPath('painting-region.png') });
      }
      await page.getByTestId('history-undo').click(); await idle();
      expect((await committed()).paint).toHaveLength(0); await idle();
      await page.getByTestId('history-redo').click(); await idle();
      expect((await committed()).paint.some((p) => p.groups.some((g) => g.stateId === 2)), `redo ${tool}`).toBe(true); await idle();
      expect((await read())!.sessionId).toBe(sessionId);
      await page.getByRole('button', { name: 'Erase all', exact: true }).click(); await idle();
    }
    await page.getByTestId('painting-tool-circle').click();
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
    for (const button of ['left', 'middle', 'right'] as const) {
      point = (await read())!.center; const camera = (await read())!.camera;
      if (button === 'left') await page.keyboard.down('Control');
      await page.mouse.move(point.x, point.y); await page.mouse.down({ button }); await page.mouse.move(point.x + 25, point.y + 15, { steps: 5 }); await page.mouse.up({ button });
      if (button === 'left') await page.keyboard.up('Control');
      expect((await read())!.camera).not.toEqual(camera);
    }
    expect((await read())!.error).toBeNull();
    const cameraPose = () => page.evaluate(() => { const state = (window as unknown as { __orcaE2e: Record<string, any> }).__orcaE2e.cameraState(); return { position: state.position, quaternion: state.quaternion, target: state.target }; });
    const beforeClose = (await read())!;
    const beforeCloseCamera = { position: beforeClose.camera.slice(0, 3), quaternion: beforeClose.camera.slice(3), target: beforeClose.target };
    await page.getByRole('button', { name: 'Close painting', exact: true }).click(); await expect(page.getByTestId('painting-panel')).toHaveCount(0);
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
    expect((await read())!.sessionId).not.toBe(sessionId);
    await page.getByTestId('gizmo-btn-move').click(); await expect(page.getByTestId('painting-panel')).toHaveCount(0); await expect(page.getByTestId('move-panel')).toBeVisible();
    await page.getByTestId('gizmo-btn-paint').click(); await idle();
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
  } finally { await app.close(); }
});

