import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { _electron } from './electron-fixture';
import { ready } from './arrangement-journey';
import { addPrimitive } from './add-primitive';
import { selectFixturePrinter } from './printer-selection';
import { verifyLayerHeight } from './layer-height-journey';

test('applies variable layer heights in the Electron utility process', async () => {
  test.setTimeout(240_000);
  const env = { ...process.env, ORCA_E2E: '1' };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try { await verifyLayerHeight(await app.firstWindow()); } finally { await app.close(); }
});

test('paints the cube top and the top of the height bar with the last layer colour', async () => {
  test.skip(process.env.ORCA_E2E_REAL !== '1', 'Requires native layer bands');
  test.setTimeout(180_000);
  const env = { ...process.env, ORCA_E2E: '1' };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await ready(page);
    await selectFixturePrinter(page, 'Bambu Lab P1P 0.4 nozzle');
    await page.getByTestId('config-mode-scoped').click();
    await addPrimitive(page, 'Cube');
    await page.getByTestId('object-list').getByTestId(/^object-\d+$/).first().getByRole('button').first().click();
    await page.getByTestId('gizmo-btn-layer-height').click();
    const bar = page.getByTestId('layer-height-bar');
    await expect(bar).toBeVisible();
    const strip = await bar.evaluate(node => Array.from((node as HTMLCanvasElement)
      .getContext('2d')!.getImageData(1, 0, 1, 1).data));

    const top = await page.evaluate(() => {
      const probe = (window as unknown as { __orcaE2e: {
        selectionBoundsWorld(): { center: number[]; max: number[] };
        projectWorldToScreen(p: number[]): { x: number; y: number };
      } }).__orcaE2e;
      const { center, max } = probe.selectionBoundsWorld();
      return probe.projectWorldToScreen([center[0], center[1], max[2]]);
    });
    const canvas = await page.getByTestId('viewport').locator('canvas[data-engine]').boundingBox();
    if (!canvas) throw new Error('Missing viewport canvas');
    const pixel = await page.screenshot({ clip: {
      x: Math.round(canvas.x + top.x), y: Math.round(canvas.y + top.y), width: 1, height: 1,
    } });
    const rgb = await app.evaluate(({ nativeImage }, bytes) => {
      const [b, g, r] = nativeImage.createFromBuffer(Buffer.from(bytes)).toBitmap();
      return [r, g, b];
    }, Array.from(pixel));
    expect(strip[3], JSON.stringify({ strip, rgb })).toBe(255);
    for (const [i, channel] of rgb.entries()) {
      // The fragment shader lights the sampled layer colour by 0.62 to 1.
      expect(channel).toBeGreaterThanOrEqual(Math.max(1, Math.floor(strip[i] * 0.62) - 1));
      expect(channel).toBeLessThanOrEqual(strip[i] + 1);
    }
  } finally { await app.close(); }
});
