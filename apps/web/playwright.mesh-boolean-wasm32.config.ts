import base from './playwright.wasm32.config';
import playwright from '../desktop/node_modules/@playwright/test/index.js';

// Keep the existing one-file fallback smoke small; this feature journey uses
// the same genuine Memory64-incompatible engine and artifact selection.
export default playwright.defineConfig({ ...base, testMatch: 'mesh-boolean.e2e.ts' });
