// Real-WASM profile for the user-visible object-move boundary: completing one
// canvas drag until its matching Undo Move entry is enabled.
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

type Timing = { count: number; totalMs: number; lastMs: number };
type Layer = { mutation: Timing; restore: Timing; directRestore: Timing; fullRestore: Timing };
type Diagnostics = { worker: Layer | null; client: Layer | null; app: Layer & { queue: Timing } };
type NativeSample = { operation: string; stagesMs: Record<string, number> };
type NativeProfile = { version: 1; samples: NativeSample[] };
type ProjectLoadEvidence = {
  receipt: {
    sourceDisplayName: string;
    sourceByteLength: number;
    nativeResult: { ok: boolean; mode?: string; objects: number; instances: number; multiPlate?: boolean; plateCount?: number };
  } | null;
};
type Point = { x: number; y: number };
type Bounds = { center: number[] } | null;

const EXPECTED_PROJECT_PATH = 'E:\\OneDrive\\Dokumente\\3d打印\\模型\\奥德赛\\OddseyHelmetFinalParts+(2)wholemorecolor-h2d.3mf';
const configuredProjectPath = process.env.ORCA_E2E_PRIME_TOWER_PROJECT?.trim();
const PROJECT_PATH = resolve(configuredProjectPath || EXPECTED_PROJECT_PATH);
const EXACT_FIXTURE = PROJECT_PATH.toLowerCase() === resolve(EXPECTED_PROJECT_PATH).toLowerCase();
const REAL = process.env.ORCA_E2E_REAL === '1';
const REAL_ARTIFACT = process.env.VITE_USE_MOCK === '0';
const DESKTOP_ROOT = resolve(__dirname, '..');

test.skip(!REAL || !REAL_ARTIFACT || !EXACT_FIXTURE || !existsSync(PROJECT_PATH),
  'requires ORCA_E2E_REAL=1, VITE_USE_MOCK=0, and the exact Odyssey h2d fixture');

function delta(before: Timing, after: Timing, label: string): number {
  expect(after.count, `${label} must record exactly one operation`).toBe(before.count + 1);
  return after.lastMs;
}

test('profiles a real object move through the visible Undo Move boundary', async () => {
  const preferencesPath = join(mkdtempSync(join(tmpdir(), 'orca-object-move-history-profile-')), 'preferences.json');
  writeFileSync(preferencesPath, JSON.stringify({ version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {} }));
  const env = {
    ...process.env,
    ORCA_E2E: '1', ORCA_E2E_REAL: '1', VITE_USE_MOCK: '0', VITE_E2E: '1',
    ORCA_E2E_PRIME_TOWER_PROJECT: PROJECT_PATH,
    ORCA_E2E_MODEL: PROJECT_PATH,
    ORCA_E2E_PREFERENCES: preferencesPath,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app: ElectronApplication = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    const readEvidence = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { projectLoadEvidence?: () => ProjectLoadEvidence } })
        .__orcaE2e?.projectLoadEvidence?.() ?? null,
    );
    await page.getByTestId('menu-file-trigger').click();
    await page.getByTestId('file-open-project').click();
    const choice = page.getByTestId('project-load-choice-dialog');
    if (await choice.isVisible({ timeout: 30_000 }).catch(() => false)) {
      await page.getByTestId('project-load-project').click();
      await page.getByTestId('project-load-confirm').click();
    }
    const confirmation = page.getByTestId('project-load-confirmation-dialog');
    if (await confirmation.isVisible({ timeout: 30_000 }).catch(() => false))
      await page.getByTestId('project-load-confirmation-dialog-continue').click();
    await expect.poll(readEvidence, { timeout: 300_000 }).toMatchObject({
      receipt: {
        sourceDisplayName: basename(PROJECT_PATH),
        sourceByteLength: statSync(PROJECT_PATH).size,
        nativeResult: { ok: true, mode: 'project', multiPlate: true, plateCount: 11 },
      },
    });

    await page.locator('#app-tab-prepare').click();
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const readCenters = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelWorldCenters?: () => Array<[number, number, number]> } })
        .__orcaE2e?.modelWorldCenters?.() ?? [],
    );
    const project = (point: [number, number, number]) => page.evaluate((p) =>
      (window as unknown as { __orcaE2e?: { projectWorldToScreen?: (q: [number, number, number]) => Point | null } })
        .__orcaE2e?.projectWorldToScreen?.(p) ?? null, point,
    );
    const readSelectionCount = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { selectionInstanceCount?: () => number } })
        .__orcaE2e?.selectionInstanceCount?.() ?? 0,
    );
    const readBounds = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { selectionBoundsWorld?: () => Bounds } })
        .__orcaE2e?.selectionBoundsWorld?.() ?? null,
    );
    const readOwner = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { pointerOwner?: () => string } }).__orcaE2e?.pointerOwner?.() ?? 'none',
    );
    const readDiagnostics = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { historyDiagnostics?: () => Diagnostics } })
        .__orcaE2e?.historyDiagnostics?.() ?? null,
    );
    const takeNativeProfile = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { takeNativePerformanceProfile?: () => Promise<NativeProfile> } })
        .__orcaE2e?.takeNativePerformanceProfile?.() ?? Promise.resolve({ version: 1 as const, samples: [] }),
    );

    await expect.poll(readCenters, { timeout: 300_000 }).not.toHaveLength(0);
    const centers = await readCenters();
    let start: Point | null = null;
    for (const center of centers) {
      const candidate = await project(center);
      if (!candidate || candidate.x < 0 || candidate.y < 0 || candidate.x > box!.width || candidate.y > box!.height) continue;
      await page.mouse.click(box!.x + candidate.x, box!.y + candidate.y);
      if (await readSelectionCount() > 0) {
        start = candidate;
        break;
      }
    }
    expect(start, 'a real rendered object must be selectable through the canvas').not.toBeNull();
    const beforeBounds = await readBounds();
    expect(beforeBounds).not.toBeNull();

    const before = await readDiagnostics();
    if (!before?.worker || !before.client) throw new Error('real E2E must expose Worker/client history diagnostics');
    // Load, projection, and selection reads must not contaminate this move.
    await takeNativeProfile();
    await page.mouse.move(box!.x + start!.x, box!.y + start!.y);
    await page.mouse.down();
    await page.mouse.move(box!.x + start!.x + 80, box!.y + start!.y + 35, { steps: 5 });
    await expect.poll(readOwner, { timeout: 10_000 }).toBe('body');
    await page.mouse.up();
    const pointerUpAt = performance.now();

    let undoVisibleAt = 0;
    await expect.poll(async () => {
      const diagnostics = await readDiagnostics();
      const undo = page.getByTestId('history-undo');
      const matchingUndo = await undo.getAttribute('aria-label') === 'Undo Move';
      const afterBounds = await readBounds();
      const moved = Boolean(afterBounds && beforeBounds && afterBounds.center.some((value, index) => value !== beforeBounds.center[index]));
      const complete = diagnostics?.worker?.mutation.count === before.worker!.mutation.count + 1
        && diagnostics?.client?.mutation.count === before.client!.mutation.count + 1
        && diagnostics.app.mutation.count === before.app.mutation.count + 1
        && matchingUndo && await undo.isEnabled() && moved;
      if (complete && undoVisibleAt === 0) undoVisibleAt = performance.now();
      return complete;
    }, { timeout: 120_000, intervals: [20] }).toBe(true);

    const after = await readDiagnostics();
    if (!after?.worker || !after.client) throw new Error('history diagnostics disappeared during object move');
    const native = await takeNativeProfile();
    const samples = native.samples.filter((sample) =>
      sample.operation === 'history_begin' || sample.operation === 'set_model_transforms' || sample.operation === 'history_commit');
    expect(samples.map((sample) => sample.operation)).toEqual(['history_begin', 'set_model_transforms', 'history_commit']);
    const transform = samples.find((sample) => sample.operation === 'set_model_transforms')!;
    const stageNames = [
      'input_json_decode', 'request_validation_target_resolution', 'transform_mutation',
      'plate_membership_reflow', 'response_json_serialization', 'total',
    ];
    expect(Object.keys(transform.stagesMs).sort()).toEqual([...stageNames].sort());
    expect(stageNames.every((stage) => Number.isFinite(transform.stagesMs[stage]) && transform.stagesMs[stage] >= 0)).toBe(true);
    expect(transform.stagesMs.total).toBeGreaterThanOrEqual(Math.max(...stageNames.filter((stage) => stage !== 'total').map((stage) => transform.stagesMs[stage])));

    const workerMs = delta(before.worker.mutation, after.worker.mutation, 'Worker transaction');
    const clientMs = delta(before.client.mutation, after.client.mutation, 'client transaction');
    const appMs = delta(before.app.mutation, after.app.mutation, 'application mutation/publication');
    const nativeMs = samples.reduce((total, sample) => total + (sample.stagesMs.total ?? 0), 0);
    console.log('[object-move-history-profile] ms', JSON.stringify({
      pointerUpToUndoVisibleMs: undoVisibleAt - pointerUpAt,
      applicationMutationAndPublicationMs: appMs,
      clientTransactionMs: clientMs,
      workerTransactionMs: workerMs,
      nativeInstrumentedTotalMs: nativeMs,
      rendererToWorkerTransportAndClientJsResidualMs: clientMs - workerMs,
      workerJsAndUninstrumentedNativeResidualMs: workerMs - nativeMs,
      nativeSamples: samples,
    }));
  } finally {
    await app.close();
  }
});
