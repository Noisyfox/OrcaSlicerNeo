import base from './playwright.config';
import playwright from '../desktop/node_modules/@playwright/test/index.js';

// A real engine without Memory64 exercises architecture selection in both the
// renderer and Worker. Keep the normal Chrome suite on the wasm64 path.
export default playwright.defineConfig({
  ...base,
  testMatch: 'wasm32-fallback.e2e.ts',
  use: { ...base.use, browserName: 'webkit', launchOptions: {} },
  metadata: { runtime: process.env.ORCA_WEB_NO_ISOLATION === '1' ? 'serial-wasm32' : 'threaded-wasm32' },
});
