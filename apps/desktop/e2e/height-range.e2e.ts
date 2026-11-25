import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { _electron } from './electron-fixture';
import { verifyHeightRanges } from './height-range-journey';

test('edits and copies height ranges in the Electron utility process', async () => {
  test.setTimeout(240_000);
  const env = { ...process.env, ORCA_E2E: '1' };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try { await verifyHeightRanges(await app.firstWindow()); } finally { await app.close(); }
});
