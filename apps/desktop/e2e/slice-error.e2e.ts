// apps/desktop/e2e/slice-error.e2e.ts — the slice-error surfacing contract.
// Real-module only (skipped in mock builds): slicing a model that libslic3r
// rejects must surface the REAL message in the status bar, not the bare
// SlicingErrors category ("Errors") that the bridge used to return
// (bridge.cpp error_json_from_exception + Toolbar errorText — see
// doc/2026-08-15-slice-error-surfacing.md).
// Run with the real module build: ORCA_E2E_REAL=1 playwright test e2e/slice-error.e2e.ts
// (test:e2e:real runs it in the e2e-real CI job; the default mock build
// skips — the mock always slices successfully).
import { _electron, test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const REAL = process.env.ORCA_E2E_REAL === '1';
// Floating box: bottom at z=0.3, above the 0.2 first layer, no supports —
// deterministically throws "empty first layer" SlicingError (fixture
// generated for the bridge-smoke regression; see packages/slicer-wasm/fixtures).
const BAD_MODEL = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/floating-box.stl');

test.skip(!REAL, 'real-module only (mock module slices successfully)');

test('a rejecting model surfaces its real error message in the status bar', async () => {
  const exportDir = mkdtempSync(join(tmpdir(), 'orca-err-'));
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: BAD_MODEL,
    ORCA_E2E_EXPORT: join(exportDir, 'out.gcode'),
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;

  const app: ElectronApplication = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  const page: Page = await app.firstWindow();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });

    // Real module init takes 20s+ (preset tree parse).
    await page.getByTestId('preset-select').waitFor({ timeout: 120000 });
    await page.getByTestId('btn-open').click();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid=btn-slice]')?.hasAttribute('disabled'),
      { timeout: 30000 },
    );

    await page.getByTestId('btn-slice').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid=slicer-status]');
      return el && el.textContent !== 'Slicing…';
    }, { timeout: 120000 });

    await expect(page.getByTestId('slicer-status')).toHaveText('Error');
    // The destructive span must carry the REAL per-object message — the
    // regression showed the bare SlicingErrors category ("Error: Errors").
    await expect(page.locator('.text-destructive')).toHaveText(
      /empty first layer/, { timeout: 10_000 });
    await expect(page.locator('.text-destructive')).not.toHaveText(/^Error: Errors$/);
    // Export stays gated after a failed slice.
    await expect(page.getByTestId('btn-export')).toBeDisabled();

    // A new slice clears the previous error while it runs (Toolbar.slice
    // setError(null)) — regression: the status bar kept showing the old
    // failure during the next slice. The re-failure then sets it again.
    // The cleared state lasts ~12ms only: the second slice short-circuits
    // the expensive parts (same model + config -> apply() no-op) while
    // collect_layers_to_print still runs and re-throws immediately — no
    // polling assertion can observe it. An in-page MutationObserver records
    // the DOM at each status-bar mutation; the record where the second
    // slice starts ('Slicing…') must show the error span gone.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mut = [];
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          const node = m.target as Node;
          const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
          if (el?.closest('[data-testid=slicer-status], .text-destructive')) {
            const st = document.querySelector('[data-testid=slicer-status]');
            const spans = [...document.querySelectorAll('.text-destructive')].map((s) => s.textContent);
            (window as unknown as Record<string, unknown>).__mut.push({
              status: st?.textContent,
              spans,
            });
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await page.getByTestId('btn-slice').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid=slicer-status]');
      return el && el.textContent !== 'Slicing…';
    }, { timeout: 120000 });
    // Re-failure restored the message.
    await expect(page.getByTestId('slicer-status')).toHaveText('Error');
    await expect(page.locator('.text-destructive')).toHaveText(/empty first layer/);
    // And the observer proves the error was cleared at slice start.
    const mut = await page.evaluate(() =>
      (window as unknown as Record<string, unknown>).__mut);
    const slicingStates = (mut as Array<{ status?: string; spans: (string | null)[] }>)
      .filter((m) => m.status === 'Slicing…');
    expect(slicingStates.length).toBeGreaterThan(0);
    expect(slicingStates.some((m) => m.spans.length === 0)).toBe(true);
  } finally {
    await app.close();
  }
});
