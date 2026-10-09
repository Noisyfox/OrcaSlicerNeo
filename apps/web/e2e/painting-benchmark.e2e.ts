import { test, expect, configuredActivation } from './browser-fixture';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { paintingBenchmarkJourney } from '../../desktop/e2e/painting-benchmark-journey';
import { capturePaintingBenchmarkArtifacts } from '../../desktop/e2e/painting-benchmark-artifacts';


const project = process.env.ORCA_PAINTING_BENCHMARK_PROJECT;
const output = process.env.ORCA_PAINTING_BENCHMARK_OUTPUT;
test.skip(!project || !output, 'run through scripts/run-painting-benchmark.mjs');
test.setTimeout(600_000);

test('measures the real desktop Web painting journey', async ({ page }) => {
  const artifacts = capturePaintingBenchmarkArtifacts(resolve(dirname(fileURLToPath(import.meta.url)), '../dist'), 'serial');
  const browserSession = await page.context().browser()!.newBrowserCDPSession();
  const memorySamples: Array<{ at: number; processes: unknown; processInfo: unknown }> = [];
  const memorySamplingErrors: Array<{ at: number; error: string }> = [];
  let sampling = false;
  const takeMemory = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const processInfo = await browserSession.send('SystemInfo.getProcessInfo') as { processInfo: Array<{ id: number; type: string }> };
      const processIds = processInfo.processInfo.map((process) => process.id).filter((id) => Number.isSafeInteger(id) && id > 0);
      if (processIds.length === 0) return;
      let processes;
      if (process.platform === 'win32') {
        const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
          `Get-Process -Id ${processIds.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PeakWorkingSet64 | ConvertTo-Json -Compress`]);
        processes = stdout.trim() ? JSON.parse(stdout) : [];
      } else {
        const { stdout } = await promisify(execFile)('ps', ['-o', 'pid=,rss=', '-p', processIds.join(',')]);
        processes = stdout.trim().split('\n').filter(Boolean).map(line => {
          const [Id, rssKiB] = line.trim().split(/\s+/).map(Number);
          return { Id, WorkingSet64: rssKiB * 1024, metric: 'resident-set bytes; peak unavailable' };
        });
      }
      memorySamples.push({ at: Date.now(), processes, processInfo: processInfo.processInfo });
    } finally { sampling = false; }
  };
  await page.addInitScript((profileActivation) => localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({ profileActivation,
    version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {},
  })), configuredActivation);
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
  await expect(page.getByTestId('serial-runtime-status')).toBeVisible();
  const runtimeEvidence = { serialStatus: await page.getByTestId('serial-runtime-status').textContent(),
    rendererWorkers: page.workers().length, selectedVariant: 'serial', crossOriginIsolated: await page.evaluate(() => crossOriginIsolated) };
  const interval = setInterval(() => { void takeMemory().catch(error => memorySamplingErrors.push({ at: Date.now(), error: String(error) })); }, 1000);
  let report;
  try { report = await paintingBenchmarkJourney(page, project!, 'web'); await takeMemory(); }
  finally { clearInterval(interval); }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = await cdp.send('Performance.getMetrics');
  mkdirSync(dirname(output!), { recursive: true });
  writeFileSync(output!, JSON.stringify({ ...report, artifacts, runtimeEvidence, browserVersion: page.context().browser()?.version() ?? null,
    cdpMetrics: metrics.metrics, memorySamples, memorySamplingErrors, memorySamplingIntervalMs: 1000 }, null, 2));
});
