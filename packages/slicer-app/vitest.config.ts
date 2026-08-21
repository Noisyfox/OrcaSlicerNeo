import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// __dirname is undefined in ESM configs — derive the package src root from
// the config file's own URL, matching apps/desktop/vitest.config.ts.
const srcRoot = fileURLToPath(new URL('./src', import.meta.url));

// The package's vite.config.ts was deleted when the Tailwind plugin moved to
// the app hosts (7c66e9b), so vitest no longer auto-loads it. Restore the
// '@' -> './src' alias it supplied — source files import UI modules as
// '@/...' — without reintroducing the react/tailwind plugins (host concern).
export default defineConfig({
  resolve: {
    alias: { '@': srcRoot },
  },
});
