import base from './playwright.config';
import playwright from '../desktop/node_modules/@playwright/test/index.js';

const { defineConfig } = playwright;
const launchOptions = base.use?.launchOptions;
export default defineConfig({
  ...base,
  use: {
    ...base.use,
    launchOptions: {
      ...launchOptions,
      args: (launchOptions?.args ?? []).filter((arg) => !arg.includes('swiftshader')),
    },
  },
  webServer: {
    ...base.webServer as object,
    command: 'pnpm --filter @orca/web build --mode e2e && pnpm --filter @orca/web preview --host 127.0.0.1',
  },
});
