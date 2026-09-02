import playwright from '../../desktop/node_modules/@playwright/test/index.js';
const { test, expect } = playwright;

interface BenchmarkReport {
  segmentCount: number;
  pageCount: number;
  staticUploadBytes: number;
  staticUploadCount: number;
  indexUploadCount: number;
  staticUploadMs: number | null;
  selectionRebuildUploadMs: number | null;
  selectionVisitedSegments: number;
  selectionUploadedBytes: number;
  cameraFrames: number;
  cameraAverageFrameMs: number | null;
  cameraFps: number | null;
  cameraIndexUploadCountDelta: number;
  fallbackReason: string | null;
  fallbackMessage: string | null;
  disposed: boolean;
  capabilities: unknown;
}

test('real WebGL2 GPU streaming benchmark emits 250k/1m evidence', async ({ page }) => {
  test.skip(process.env.ORCA_E2E_GPU_STREAMING_PERF !== '1', 'opt-in real-browser performance evidence harness');
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __orcaE2e?: { gpuStreamingBenchmark?: unknown } }).__orcaE2e?.gpuStreamingBenchmark))).toBe(true);

  for (const count of [250_000, 1_000_000]) {
    const report = await page.evaluate(async (segmentCount) => {
      const benchmark = (window as unknown as {
        __orcaE2e?: { gpuStreamingBenchmark?: (n: number, options?: { frameCount?: number }) => Promise<BenchmarkReport> };
      }).__orcaE2e?.gpuStreamingBenchmark;
      if (!benchmark) throw new Error('GPU streaming browser harness was not installed');
      return benchmark(segmentCount, { frameCount: 30 });
    }, count);
    console.log(`[gpu-streaming-browser] ${JSON.stringify(report)}`);
    expect(report.segmentCount).toBe(count);
    expect(report.pageCount).toBeGreaterThan(0);
    expect(report.disposed).toBe(true);
    if (report.fallbackReason) {
      expect(report.fallbackMessage).toBeTruthy();
      continue;
    }
    expect(report.staticUploadBytes).toBeGreaterThanOrEqual(count * 64);
    expect(report.staticUploadCount).toBe(report.pageCount);
    expect(report.indexUploadCount).toBeGreaterThanOrEqual(report.pageCount * 2);
    expect(report.staticUploadMs).not.toBeNull();
    expect(report.selectionRebuildUploadMs).not.toBeNull();
    expect(report.selectionVisitedSegments).toBe(count);
    expect(report.selectionUploadedBytes).toBeGreaterThan(0);
    expect(report.cameraFrames).toBe(30);
    expect(report.cameraAverageFrameMs).toBeGreaterThan(0);
    expect(report.cameraFps).toBeGreaterThan(0);
    // Camera updates are uniform-only: no dynamic index upload is allowed.
    expect(report.cameraIndexUploadCountDelta).toBe(0);
  }
});
