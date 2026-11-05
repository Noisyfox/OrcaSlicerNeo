import base from './playwright.wasm32.config';
import playwright from '../desktop/node_modules/@playwright/test/index.js';

export default playwright.defineConfig({ ...base, testMatch: 'instance-isolation.e2e.ts' });
