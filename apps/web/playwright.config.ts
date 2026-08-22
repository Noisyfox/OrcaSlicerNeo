import playwright from '../desktop/node_modules/@playwright/test/index.js';
const { defineConfig, devices } = playwright;

const serial = process.env.ORCA_WEB_NO_ISOLATION === '1';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  timeout: 120_000,
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    launchOptions: {
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      args: [
        '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', '--enable-webgl',
        '--enable-features=WebAssemblyMemory64', '--js-flags=--experimental-wasm-memory64',
      ],
    },
  },
  webServer: {
    command: 'pnpm --filter @orca/web build && pnpm --filter @orca/web preview --host 127.0.0.1',
    cwd: '../..',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: serial ? { ORCA_WEB_NO_ISOLATION: '1' } : {},
  },
  metadata: { runtime: serial ? 'serial-wasm64' : 'threaded-wasm64' },
});
