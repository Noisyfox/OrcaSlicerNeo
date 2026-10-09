import { _electron } from './electron-fixture';
import { selectFixturePrinter } from './printer-selection';
import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires real WASM');

test('measures real startup, import, slice-to-preview, export and process memory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-runtime-performance-'));
  const output = join(directory, 'cube.gcode');
  const env = { ...process.env, ORCA_E2E: '1',
    ORCA_E2E_MODEL: resolve(__dirname, '../../../packages/slicer-wasm/fixtures/cube.stl'),
    ORCA_E2E_EXPORT: output, ORCA_E2E_PREFERENCES: join(directory, 'preferences.json'),
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const started = performance.now();
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.getByTestId('slicer-status').textContent(),
      { timeout: 300_000, intervals: [20] }).toBe('Ready');
    const startupMs = performance.now() - started;
    const memory = () => app.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({
      type: metric.type, name: metric.name, workingSetKiB: metric.memory.workingSetSize,
    })));
    const readyMemory = await memory();
    // Observe the existing protocol at its renderer endpoint. Fine-grained
    // round trips distinguish transport/core costs from Playwright polling.
    await page.evaluate(() => {
      const rows: Array<{ op: string; ms: number; resultBytes: number }> = [];
      (window as unknown as { __runtimeTimings: typeof rows }).__runtimeTimings = rows;
      const observed = new WeakSet<object>();
      for (const prototype of [Worker.prototype, MessagePort.prototype]) {
        const original = prototype.postMessage;
        const pending = new Map<number, { op: string; at: number }>();
        prototype.postMessage = function (this: Worker & MessagePort, ...args: unknown[]) {
          const message = args[0] as { type?: string; id: number; op: string };
          if (message?.type === 'request') {
            if (!observed.has(this)) {
              observed.add(this);
              this.addEventListener('message', (event: MessageEvent) => {
                const reply = event.data;
                if (reply?.type !== 'response') return;
                const request = pending.get(reply.id);
                if (!request) return;
                pending.delete(reply.id);
                const buffers = new Set<ArrayBufferLike>();
                let resultBytes = 0;
                const visit = (value: unknown): void => {
                  if (ArrayBuffer.isView(value)) {
                    if (!buffers.has(value.buffer)) { buffers.add(value.buffer); resultBytes += value.buffer.byteLength; }
                  } else if (value instanceof ArrayBuffer) {
                    if (!buffers.has(value)) { buffers.add(value); resultBytes += value.byteLength; }
                  } else if (value && typeof value === 'object') Object.values(value).forEach(visit);
                };
                visit(reply.result);
                rows.push({ op: request.op, ms: performance.now() - request.at, resultBytes });
              });
            }
            pending.set(message.id, { op: message.op, at: performance.now() });
          }
          return Reflect.apply(original, this, args);
        } as typeof original;
      }
    });
    await page.locator('#app-tab-prepare').click();
    const printer = 'Creality Ender-3 0.4 nozzle';
    await selectFixturePrinter(page, printer);
    const importAt = performance.now();
    await page.getByTestId('btn-add-model').click();
    await expect.poll(() => page.getByTestId('btn-slice').isEnabled(),
      { timeout: 30_000, intervals: [20] }).toBe(true);
    const importMs = performance.now() - importAt;
    const sliceAt = performance.now();
    await page.getByTestId('btn-slice').click();
    await expect.poll(() => page.getByTestId('slicer-status').textContent(),
      { timeout: 120_000, intervals: [20] }).toBe('Sliced');
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __orcaE2e?: { gpuStreamingStatus?(): string };
    }).__orcaE2e?.gpuStreamingStatus?.()),
      { timeout: 30_000, intervals: [20] }).toBe('ready');
    const sliceToPreviewMs = performance.now() - sliceAt;
    const exportAt = performance.now();
    await page.getByTestId('btn-export').click();
    await expect.poll(() => existsSync(output), { intervals: [10] }).toBe(true);
    expect(readFileSync(output, 'utf8')).toContain('G1');
    const exportMs = performance.now() - exportAt;
    console.log('[runtime-performance]', JSON.stringify({
      host: readyMemory.some((metric) => metric.name === 'Orca Slicer Runtime') ? 'utility' : 'browser-worker',
      startupMs, importMs, sliceToPreviewMs, exportMs,
      readyMemory, previewMemory: await memory(), gcodeBytes: readFileSync(output).byteLength,
      requests: await page.evaluate(() => (window as unknown as { __runtimeTimings: unknown }).__runtimeTimings),
    }));
  } finally { await app.close(); }
});
