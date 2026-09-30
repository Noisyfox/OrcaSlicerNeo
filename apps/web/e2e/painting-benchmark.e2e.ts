import playwright from '../../desktop/node_modules/@playwright/test/index.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paintingBenchmarkJourney } from '../../desktop/e2e/painting-benchmark-journey';

const { test } = playwright;
const project = process.env.ORCA_PAINTING_BENCHMARK_PROJECT;
const output = process.env.ORCA_PAINTING_BENCHMARK_OUTPUT;
test.skip(!project || !output, 'run through scripts/run-painting-benchmark.mjs');
test.setTimeout(600_000);

test('measures the real desktop Web painting journey', async ({ page }) => {
  const browserSession = await page.context().browser()!.newBrowserCDPSession();
  const memorySamples: Array<{ at: number; processes: unknown; processInfo: unknown }> = [];
  let sampling = false;
  const takeMemory = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const processInfo = await browserSession.send('SystemInfo.getProcessInfo') as { processInfo: Array<{ id: number; type: string }> };
      const processIds = processInfo.processInfo.map((process) => process.id).filter((id) => Number.isSafeInteger(id) && id > 0);
      if (processIds.length === 0) return;
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
        `Get-Process -Id ${processIds.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PeakWorkingSet64 | ConvertTo-Json -Compress`]);
      memorySamples.push({ at: Date.now(), processes: stdout.trim() ? JSON.parse(stdout) : [], processInfo: processInfo.processInfo });
    } finally { sampling = false; }
  };
  await page.addInitScript(() => localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({
    version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {},
  })));
  await page.goto('/');
  const interval = setInterval(() => { void takeMemory().catch(() => undefined); }, 1000);
  let report;
  try { report = await paintingBenchmarkJourney(page, project!, 'web'); await takeMemory(); }
  finally { clearInterval(interval); }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = await cdp.send('Performance.getMetrics');
  mkdirSync(dirname(output!), { recursive: true });
  writeFileSync(output!, JSON.stringify({ ...report, browserVersion: page.context().browser()?.version() ?? null,
    cdpMetrics: metrics.metrics, memorySamples, memorySamplingIntervalMs: 1000 }, null, 2));
});
