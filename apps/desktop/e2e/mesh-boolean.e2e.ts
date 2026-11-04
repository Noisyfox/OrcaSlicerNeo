import { _electron } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { meshBooleanJourney } from './mesh-boolean-journey';

test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires freshly staged real WASM; run scripts/run-mesh-boolean-e2e.mjs');
test.setTimeout(480_000);
test('real threaded Electron Mesh Boolean interaction, history, modal admission and instances', async ({}, info) => {
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-boolean-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, selectedProfiles: {}, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_PREFERENCES: preferences,
    ORCA_E2E_MODEL: resolve(__dirname, '../../../packages/slicer-wasm/fixtures/cube.stl') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await meshBooleanJourney(page, () => page.getByTestId('btn-add-model').click(), info);
    expect(JSON.parse(readFileSync(preferences, 'utf8')).meshBooleanKeepPainting).toBe(true);
  } finally { await app.close(); }
});
