// End-to-end profile for the exact user-visible boundary: clicking Add Plate
// until the matching Undo entry is enabled. This is intentionally real-WASM
// only: mock timings cannot establish the cost of history model snapshots.
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

type Timing = { count: number; totalMs: number; lastMs: number };
type Layer = { mutation: Timing; restore: Timing; directRestore: Timing; fullRestore: Timing };
type Diagnostics = { worker: Layer | null; client: Layer | null; app: Layer & { queue: Timing } };
type NativeSample = { operation: string; stagesMs: Record<string, number> };
type NativeProfile = { version: 1; samples: NativeSample[] };

const DESKTOP_ROOT = resolve(__dirname, '..');
const configuredProjectPath = process.env.ORCA_E2E_PRIME_TOWER_PROJECT?.trim();
const PROJECT_PATH = configuredProjectPath ? resolve(configuredProjectPath) : '';
const REAL = process.env.ORCA_E2E_REAL === '1';

test.skip(!REAL || !existsSync(PROJECT_PATH),
  'requires ORCA_E2E_REAL=1 and ORCA_E2E_PRIME_TOWER_PROJECT');

function lastDelta(before: Timing, after: Timing): number {
  expect(after.count).toBe(before.count + 1);
  return after.lastMs;
}

test('profiles Add Plate click through its visible Undo entry on the real Odyssey project', async () => {
  const preferencesPath = join(mkdtempSync(join(tmpdir(), 'orca-plate-add-history-profile-')), 'preferences.json');
  writeFileSync(preferencesPath, JSON.stringify({
    version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {},
  }));
  const env = {
    ...process.env,
    ORCA_E2E: '1', ORCA_E2E_REAL: '1',
    ORCA_E2E_PRIME_TOWER_PROJECT: PROJECT_PATH,
    ORCA_E2E_MODEL: PROJECT_PATH,
    ORCA_E2E_PREFERENCES: preferencesPath,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app: ElectronApplication = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();
    // Opening through the app route is intentional: it proves the supplied
    // real file reaches the native project loader instead of measuring the
    // startup fixture or a merely configured path.
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
    await expect.poll(() => page.evaluate(() => {
      const hook = (window as unknown as { __orcaE2e?: { projectLoadEvidence?: () => {
        receipt: { sourceDisplayName: string; sourceByteLength: number; nativeResult: { multiPlate?: boolean; plateCount?: number } } | null;
      } } }).__orcaE2e;
      return hook?.projectLoadEvidence?.().receipt ?? null;
    }), { timeout: 300_000 }).toMatchObject({
      sourceDisplayName: basename(PROJECT_PATH),
      sourceByteLength: statSync(PROJECT_PATH).size,
      nativeResult: { multiPlate: true, plateCount: 11 },
    });
    await expect(page.getByTestId('add-plate')).toBeEnabled({ timeout: 300_000 });

    const readDiagnostics = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { historyDiagnostics?: () => Diagnostics } })
        .__orcaE2e?.historyDiagnostics?.() ?? null,
    );
    const takeNativeProfile = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { takeNativePerformanceProfile?: () => Promise<NativeProfile> } })
        .__orcaE2e?.takeNativePerformanceProfile?.() ?? Promise.resolve({ version: 1 as const, samples: [] }),
    );
    const before = await readDiagnostics();
    if (!before?.worker || !before.client) throw new Error('real E2E must expose Worker/client history diagnostics');
    // Project load uses the same bridge; drain it so only this click remains.
    await takeNativeProfile();

    // Start in the renderer immediately before event dispatch. Playwright's
    // locator.click() can wait for actionability, which is test-driver time
    // rather than the user's click-to-Undo latency.
    const clickAt = await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="add-plate"]');
      if (!button || button.disabled) throw new Error('Add Plate must be enabled before profiling');
      const startedAt = performance.now();
      button.click();
      return startedAt;
    });
    let undoVisibleAt = 0;
    await expect.poll(async () => {
      const diagnostics = await readDiagnostics();
      const undo = page.getByTestId('history-undo');
      const matchingUndo = await undo.getAttribute('aria-label') === 'Undo Add Plate';
      const completed = diagnostics?.worker?.mutation.count === before.worker!.mutation.count + 1 &&
        diagnostics?.client?.mutation.count === before.client!.mutation.count + 1 &&
        diagnostics.app.mutation.count === before.app.mutation.count + 1 &&
        matchingUndo && await undo.isEnabled();
      if (completed && undoVisibleAt === 0) undoVisibleAt = await page.evaluate(() => performance.now());
      return completed;
    }, { timeout: 120_000, intervals: [20] }).toBe(true);
    const after = await readDiagnostics();
    if (!after?.worker || !after.client) throw new Error('history diagnostics disappeared during Add Plate');
    const native = await takeNativeProfile();
    const samples = native.samples.filter((sample) =>
      sample.operation === 'history_begin' || sample.operation === 'add_plate' || sample.operation === 'history_commit');
    expect(samples.map((sample) => sample.operation)).toEqual(['history_begin', 'add_plate', 'history_commit']);
    expect(samples.filter((sample) => sample.operation !== 'add_plate')
      .every((sample) => typeof sample.stagesMs.capture_model_state === 'number' &&
        typeof sample.stagesMs.capture_collection_cache === 'number')).toBe(true);

    const workerMs = lastDelta(before.worker.mutation, after.worker.mutation);
    const clientMs = lastDelta(before.client.mutation, after.client.mutation);
    const appMs = lastDelta(before.app.mutation, after.app.mutation);
    const queueMs = lastDelta(before.app.queue, after.app.queue);
    const nativeMs = samples.reduce((total, sample) => total + (sample.stagesMs.total ?? 0), 0);
    console.log('[plate-add-history-profile] ms', JSON.stringify({
      clickToUndoVisibleMs: undoVisibleAt - clickAt,
      appQueueBeforeMutationMs: queueMs,
      appMutationAndPublicationMs: appMs,
      clientTransactionMs: clientMs,
      workerTransactionMs: workerMs,
      nativeInstrumentedTotalMs: nativeMs,
      rendererToWorkerTransportAndClientJsResidualMs: clientMs - workerMs,
      workerJsAndUninstrumentedNativeReadsResidualMs: workerMs - nativeMs,
      nativeSamples: samples,
    }));
  } finally {
    await app.close();
  }
});
