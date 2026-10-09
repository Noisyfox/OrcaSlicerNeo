import { _electron } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { paintingBenchmarkJourney } from './painting-benchmark-journey';
import { capturePaintingBenchmarkArtifacts } from './painting-benchmark-artifacts';

const project = process.env.ORCA_PAINTING_BENCHMARK_PROJECT;
const output = process.env.ORCA_PAINTING_BENCHMARK_OUTPUT;
test.skip(!project || !output, 'run through scripts/run-painting-benchmark.mjs');
test.setTimeout(600_000);

test('measures the real Electron painting journey', async () => {
  const artifacts = capturePaintingBenchmarkArtifacts(resolve(__dirname, '../out/renderer'), 'serial');
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-paint-bench-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_MODEL: project!, ORCA_E2E_PRIME_TOWER_PROJECT: project!, ORCA_E2E_PREFERENCES: preferences } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    const runtimeEvidence = { rendererWorkers: page.workers().length, selectedVariant: 'serial',
      selectionAuthority: 'scoped serial runtime gate; native painting counters require the instrumented serial artifact, while threaded remains production OFF' };
    expect(runtimeEvidence.rendererWorkers).toBe(0);
    const memorySamples: Array<{ at: number; metrics: unknown }> = [];
    let sampling = false;
    const takeMemory = async () => {
      if (sampling) return;
      sampling = true;
      try { memorySamples.push({ at: Date.now(), metrics: await app.evaluate(({ app }) => app.getAppMetrics()
        .map((m) => ({ pid: m.pid, type: m.type, memory: m.memory }))) }); }
      finally { sampling = false; }
    };
    const interval = setInterval(() => { void takeMemory(); }, 1000);
    let report;
    try { report = await paintingBenchmarkJourney(page, project!, 'electron', process.platform === 'darwin' ? async () => {
      await app.evaluate(({ Menu, BrowserWindow }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('file-open-project');
        if (!item?.enabled) throw new Error('native Open Project unavailable');
        item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {} as Electron.KeyboardEvent);
      });
    } : undefined); await takeMemory(); }
    catch(error) {
      mkdirSync(dirname(output!), {recursive:true});
      const diagnostics=await page.evaluate(()=> {
        const hook=(window as unknown as {__orcaE2e:Record<string,()=>unknown>}).__orcaE2e;
        return {painting:hook.paintingBenchmarkState?.(),performance:hook.paintingPerformanceEvidence?.(),gapRequestAt:(window as unknown as {__orcaGapRequestAt?:number}).__orcaGapRequestAt};
      });
      writeFileSync(`${output}.failed.json`,JSON.stringify({error:String(error),diagnostics,memorySamples},null,2));
      throw error;
    }
    finally { clearInterval(interval); }
    const processMetrics = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, memory: m.memory })));
    mkdirSync(dirname(output!), { recursive: true });
    writeFileSync(output!, JSON.stringify({ ...report, artifacts, runtimeEvidence,
      electronVersion: await app.evaluate(() => process.versions.electron),
      appVersion: await app.evaluate(({ app }) => app.getVersion()),
      processMetrics, memorySamples, memorySamplingIntervalMs: 1000 }, null, 2));
  } finally { await app.close(); }
});
