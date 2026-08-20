import { spawn } from 'node:child_process';

const child = spawn('pnpm', ['--filter', 'desktop', 'exec', 'playwright', 'test', '--config', '../../apps/web/playwright.config.ts'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, ORCA_WEB_NO_ISOLATION: '1' },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
