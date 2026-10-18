import desktop from '../electron.vite.config';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Renderer-only development server: the benchmark fixture launches Electron
// with its own isolated preferences instead of opening another development app.
export default defineConfig(async environment => {
  const config = await (typeof desktop === 'function' ? desktop(environment) : desktop);
  if (!config.renderer) throw new Error('The desktop renderer configuration is required');
  return {
    ...config.renderer,
    root: resolve('src/renderer'),
    server: { ...config.renderer.server, port: 5187, strictPort: true },
    define: { ...config.renderer.define, __ORCA_E2E__: 'true' },
  };
});
