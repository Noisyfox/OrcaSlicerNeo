import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { _electron } from './electron-fixture';
import { verifyLayerHeight } from './layer-height-journey';

test('applies variable layer heights in the Electron utility process', async () => {
  test.setTimeout(240_000);
  const env = { ...process.env, ORCA_E2E: '1' };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try { await verifyLayerHeight(await app.firstWindow()); } finally { await app.close(); }
});
