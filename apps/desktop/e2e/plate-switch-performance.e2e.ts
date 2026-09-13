import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DESKTOP_ROOT = resolve(__dirname, '..');
const projectPath = process.env.ORCA_E2E_PRIME_TOWER_PROJECT?.trim() ?? '';
const REAL = process.env.ORCA_E2E_REAL === '1';
test.skip(!REAL || !projectPath || !existsSync(projectPath),
  'requires ORCA_E2E_REAL=1 and ORCA_E2E_PRIME_TOWER_PROJECT');

test('switches several non-current plates within the interactive budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-plate-switch-performance-'));
  const preferencesPath = join(dir, 'preferences.json');
  // Force the visible choice even when the desktop has a startup model. This
  // makes the acceptance proof deterministic: the test must explicitly pick
  // the project route before any native preflight/commit can run.
  writeFileSync(preferencesPath, JSON.stringify({ version: 1, projectLoadBehaviour: 'always_ask', selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1',
    ORCA_E2E_PRIME_TOWER_PROJECT: resolve(projectPath), ORCA_E2E_MODEL: resolve(projectPath),
    ORCA_E2E_PREFERENCES: preferencesPath } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app: ElectronApplication = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('menu-file-trigger').click();
    await page.getByTestId('file-open-project').click();
    const choice = page.getByTestId('project-load-choice-dialog');
    await expect(choice).toBeVisible({ timeout: 300_000 });
    const projectChoice = page.getByTestId('project-load-project');
    await projectChoice.click();
    await expect(projectChoice).toHaveAttribute('data-checked', '');
    await page.getByTestId('project-load-confirm').click();
    const confirmation = page.getByTestId('project-load-confirmation-dialog');
    if (await confirmation.isVisible({ timeout: 30_000 }).catch(() => false))
      await page.getByTestId('project-load-confirmation-dialog-continue').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await expect(page.getByTestId('project-progress-dialog')).toHaveCount(0, { timeout: 300_000 });
    await expect.poll(() => page.evaluate(() => {
      const hook = (window as unknown as { __orcaE2e?: { projectLoadEvidence?: () => {
        receipt: { sourceDisplayName: string; sourceByteLength: number; nativeResult: { multiPlate?: boolean; plateCount?: number } } | null;
      } } }).__orcaE2e;
      return hook?.projectLoadEvidence?.().receipt ?? null;
    }), { timeout: 300_000 }).toMatchObject({
      sourceDisplayName: basename(resolve(projectPath)),
      sourceByteLength: statSync(resolve(projectPath)).size,
      nativeResult: { multiPlate: true, plateCount: 11 },
    });
    await expect(page.getByTestId('current-plate-label')).toBeVisible({ timeout: 300_000 });
    await expect.poll(() => page.evaluate(() => {
      const hook = (window as unknown as { __orcaE2e?: { bedPlateStates?: () => unknown[] } }).__orcaE2e;
      return hook?.bedPlateStates?.() ?? [];
    }), { timeout: 300_000 }).toHaveLength(11);
    // Do not measure while the initial all-plate Prime Tower projection is
    // still publishing. The user-visible selection starts only after this
    // scene projection is complete, matching the established project e2e.
    await expect.poll(() => page.evaluate(() => {
      const hook = (window as unknown as { __orcaE2e?: { primeTowerStates?: () => unknown[] } }).__orcaE2e;
      return hook?.primeTowerStates?.() ?? [];
    }), { timeout: 300_000 }).toHaveLength(8);

    const readBeds = () => page.evaluate(() => {
      const hook = (window as unknown as { __orcaE2e?: { bedPlateStates?: () => Array<{
        plateId?: string; current: boolean; position: [number, number, number];
      }> } }).__orcaE2e;
      return hook?.bedPlateStates?.() ?? [];
    });
    const project = (point: [number, number, number]) => page.evaluate((p) =>
      (window as unknown as { __orcaE2e?: { projectWorldToScreen?: (q: [number, number, number]) => { x: number; y: number } | null } })
        .__orcaE2e?.projectWorldToScreen?.(p) ?? null, point);
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const readCurrentLabel = () => page.getByTestId('current-plate-label').textContent();
    const latencies: number[] = [];
    // The first scene click is a cold navigation through the already-loaded
    // Worker/React path; keep a separate, explicit cold budget. Subsequent
    // clicks are the steady-state interaction budget users experience while
    // browsing plates.
    for (let round = 0; round < 5; round += 1) {
      const beds = await readBeds();
      const current = beds.find((bed) => bed.current);
      const target = beds.find((bed) => !bed.current);
      const previousLabel = await readCurrentLabel();
      expect(current?.plateId).toBeTruthy();
      expect(target?.plateId).toBeTruthy();
      let switched = false;
      for (const [x, y] of [[8, 8], [212, 8], [8, 212], [212, 212], [110, 110]] as const) {
        const point = await project([target!.position[0] + x, target!.position[1] + y, -0.45]);
        if (!point) continue;
        const started = performance.now();
        await page.mouse.click(box!.x + point.x, box!.y + point.y);
        try {
          await expect.poll(async () => {
            const selected = (await readBeds()).some((bed) => bed.current && bed.plateId === target!.plateId);
            const label = await readCurrentLabel();
            return selected && label !== previousLabel;
          }, { timeout: 1_000 }).toBe(true);
          latencies.push(performance.now() - started);
          switched = true;
          break;
        } catch { /* try another exposed point on the target bed */ }
      }
      expect(switched, `target plate ${target!.plateId} should be clickable`).toBe(true);
    }
    console.log(`plate switch latencies (cold + steady-state): ${latencies.map((value) => Math.round(value)).join(', ')}ms`);
    expect(latencies).toHaveLength(5);
    expect(latencies[0]).toBeLessThanOrEqual(500);
    expect(Math.max(...latencies.slice(1))).toBeLessThanOrEqual(250);
    expect(statSync(resolve(projectPath)).size).toBe(45_201_991);
  } finally {
    await app.close();
  }
});
