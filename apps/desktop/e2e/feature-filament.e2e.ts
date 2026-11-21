import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { verifyFeatureFilamentRouting } from './feature-filament-flow';
import { _electron } from './electron-fixture';

const DESKTOP_ROOT = resolve(__dirname, '..');
async function launchApp() {
  const env = { ...process.env, ORCA_E2E: '1' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
}

test('edits feature filament routes for objects and model parts', async () => {
  const app = await launchApp();
  try {
    await verifyFeatureFilamentRouting(await app.firstWindow());
  } finally {
    await app.close();
  }
});
