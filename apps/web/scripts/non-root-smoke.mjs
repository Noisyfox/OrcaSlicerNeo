import { spawn } from 'node:child_process';

const port = 4187;
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
  console.log('[web] non-root base smoke passed');
} finally {
  child.kill();
}
