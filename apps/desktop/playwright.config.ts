// apps/desktop/playwright.config.ts — Playwright Electron e2e (M3).
// Run modes:
//   pnpm test:e2e          build (VITE_USE_MOCK=1) + run — mock module, no emsdk
//   pnpm test:e2e:real     build (real module, stage:wasm first) + run with
//                          ORCA_E2E_REAL=1 — real wasm, CI job e2e-real
// Electron is driven via @playwright/test's _electron.launch — no browser
// download needed. One app at a time (workers: 1) — Electron is heavyweight
// and the specs share an export temp dir per launch.
import { defineConfig } from '@playwright/test';

const realWasm = process.env.ORCA_E2E_REAL === '1';

export default defineConfig({
  testDir: './e2e',
  // The specs are named *.e2e.ts (not *.spec.ts) so the packaged probe can
  // also be run standalone by explicit path. testMatch/testIgnore filter
  // EXPLICIT paths too (verified empirically on 1.62), so the packaged
  // probe cannot be excluded from discovery without breaking its standalone
  // run; instead the test:e2e/test:e2e:real scripts pass e2e/app.e2e.ts
  // explicitly and the packaged probe runs via
  // `npx playwright test e2e/packaged.e2e.ts` (needs package:dir first).
  testMatch: /.*\.e2e\.ts$/,
  // The real module must fetch and parse the full preset bundle before it can
  // answer the first get_presets call. Keep mock feedback fast, but leave
  // headroom for that one-time real-WASM initialization on loaded machines.
  timeout: realWasm ? 480_000 : 120_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
