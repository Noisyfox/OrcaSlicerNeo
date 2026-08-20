import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

const port = 4187;
const distAssets = new URL('../dist/assets/', import.meta.url);
const child = spawn('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: new URL('..', import.meta.url),
  shell: process.platform === 'win32',
  stdio: 'ignore',
});

try {
  let response;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/orca/`);
      if (response.ok) break;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!response?.ok) throw new Error(`non-root preview did not respond (${response?.status ?? 'offline'})`);
  const html = await response.text();
  if (!html.includes('./assets/')) {
    throw new Error('non-root preview returned an unexpected asset base');
  }
  // The shared index.css is Tailwind v4 source; the web host must compile it
  // (@tailwindcss/vite). Guard the built CSS directly (the preview serves
  // assets at the root path, not under the /orca/ base) — without the plugin,
  // @theme/@apply pass through unprocessed and every Tailwind class in the UI
  // is dead (2026-08-20 layout regression).
  const cssFiles = await readdir(distAssets);
  const stylesheet = cssFiles.find((f) => f.startsWith('index-') && f.endsWith('.css'));
  if (!stylesheet) throw new Error('build produced no index-*.css in dist/assets');
  const css = await readFile(new URL(stylesheet, distAssets), 'utf8');
  if (!css.includes('.flex{')) {
    throw new Error('built CSS lacks compiled Tailwind utilities (missing @tailwindcss/vite?)');
  }
  console.log('[web] non-root base smoke passed');
} finally {
  child.kill();
}
