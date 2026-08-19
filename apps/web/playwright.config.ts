import { defineConfig, devices } from '@playwright/test';

const serial = process.env.ORCA_WEB_NO_ISOLATION === '1';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  timeout: 120_000,
  workers: 1,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4173', headless: true },
  webServer: {
    command: 'pnpm --filter web build && pnpm --filter web preview --host 127.0.0.1',
    cwd: '../..',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: serial ? { ORCA_WEB_NO_ISOLATION: '1' } : {},
  },
  metadata: { runtime: serial ? 'serial-wasm64' : 'threaded-wasm64' },
});
