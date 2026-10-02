import { _electron, expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('utility owns the runtime and reload replaces its session without a renderer Worker', async () => {
  const env = { ...process.env, ORCA_E2E: '1',
    ORCA_E2E_PREFERENCES: join(mkdtempSync(join(tmpdir(), 'orca-utility-')), 'preferences.json'),
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    const runtimePids = () => app.evaluate(({ app }) => app.getAppMetrics()
      .filter((metric) => metric.name === 'Orca Slicer Runtime').map((metric) => metric.pid));
    const before = await runtimePids();
    expect(before).toHaveLength(1);
    expect(page.workers()).toHaveLength(0);
    await page.reload();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await expect.poll(runtimePids).toHaveLength(1);
    expect(await runtimePids()).not.toContain(before[0]);
    expect(page.workers()).toHaveLength(0);
    // A lost utility must not leave the next operation pending forever.
    await app.evaluate(({ app }) => {
      const runtime = app.getAppMetrics().find((metric) => metric.name === 'Orca Slicer Runtime');
      if (!runtime) throw new Error('runtime missing');
      process.kill(runtime.pid);
    });
    await expect.poll(runtimePids).toHaveLength(0);
    // Reload is the explicit recovery boundary; no commands are silently replayed.
    await page.reload();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await expect.poll(runtimePids).toHaveLength(1);
  } finally {
    await app.close();
  }
});
