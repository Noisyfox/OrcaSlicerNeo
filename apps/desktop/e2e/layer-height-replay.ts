import { expect, test, type Locator, type Page } from '@playwright/test';

interface Replay {
  samples: { z: number; width: number; action: number }[];
  latencyMs: number | null;
  curveValues: number;
  bytes: number;
  sameCurve: boolean;
  sameBands: boolean;
}
interface ProbeWindow extends Window {
  __orcaE2e?: {
    layerHeightLiveLatency(): number | null;
    captureLayerHeightFrame(): boolean;
    replayLayerHeight(): Promise<Replay>;
  };
  repeatLayerHeightBrush?: () => void;
}

/** Replay the same four input samples on each host. Only the brush's repeat
 * timer is stepped manually. Worker replies, animation frames and model draws
 * run on the host clock. The main journey also exercises the unmodified timer. */
export async function verifyLayerHeightReplay(page: Page, bar: Locator, reset: Locator) {
  await bar.evaluate(canvas => {
    Object.assign((canvas as HTMLElement).style, { position: 'fixed', top: '160px', right: '0', height: '320px', width: '64px' });
    const browser: Window = window;
    canvas.addEventListener('pointerdown', () => {
      const original = browser.setInterval;
      browser.setInterval = (fn, delay, ...args) => {
        if (delay !== 100 || typeof fn !== 'function') return original(fn, delay, ...args);
        browser.setInterval = original;
        (window as ProbeWindow).repeatLayerHeightBrush = () => fn(...args);
        return original(() => {}, 2_000_000_000);
      };
      canvas.addEventListener('pointerup', () => { browser.setInterval = original; }, { once: true });
    }, { capture: true, once: true });
  });
  const rect = await bar.boundingBox();
  if (!rect) throw new Error('Missing brush canvas');
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__orcaE2e?.layerHeightLiveLatency()), { timeout: 30_000 }).toEqual(expect.any(Number));
  await page.evaluate(() => {
    const repeat = (window as ProbeWindow).repeatLayerHeightBrush;
    if (!repeat) throw new Error('Missing brush repeat timer');
    repeat(); repeat();
  });
  await page.mouse.move(x, y - 40);
  await page.mouse.up();
  await expect(reset).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__orcaE2e?.captureLayerHeightFrame()), { timeout: 30_000 }).toBe(true);
  await reset.click();
  await expect(reset).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Adaptive', exact: true })).toBeEnabled();
  const replay = await page.evaluate(() => (window as ProbeWindow).__orcaE2e!.replayLayerHeight());
  expect(replay.sameCurve).toBe(true);
  expect(replay.sameBands).toBe(true);
  expect(replay.samples).toHaveLength(4);
  const first = replay.samples[0];
  expect(replay.samples).toEqual([first, first, first, { ...first, z: first.z * 1.25 }]);
  expect(first).toMatchObject({ width: 2, action: 1 });
  expect(replay.latencyMs).toBeGreaterThan(0);
  const body = JSON.stringify(replay);
  await test.info().attach('layer-height-native-replay', { body, contentType: 'application/json' });
  console.log('Layer height native replay', body);
  await bar.evaluate(canvas => { (canvas as HTMLElement).removeAttribute('style'); });
}
