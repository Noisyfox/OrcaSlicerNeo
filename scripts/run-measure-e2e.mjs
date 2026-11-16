import { spawnSync } from 'node:child_process';
import { cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'), desktop = resolve(root, 'apps/desktop');
const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!['--web-only', '--desktop-only', '--serial', '--wasm32'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
if (flags.has('--web-only') && flags.has('--desktop-only')) throw new Error('Choose one host or omit both host flags');
if (flags.has('--desktop-only') && (flags.has('--serial') || flags.has('--wasm32'))) throw new Error('Electron uses threaded wasm64; serial/wasm32 gates require Web');
const base = { ...process.env, ORCA_E2E_REAL: '1', ORCA_E2E_VISIBLE: '1', VITE_E2E: '1', VITE_USE_MOCK: '0', CI: '1' };
function pnpm(args, env = base, cwd = root) {
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args,
    { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
async function verify(host, variant, files) {
  for (const file of files) {
    const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
    const source = await digest(resolve(root, 'packages/slicer-wasm/out', variant, file));
    if (source !== await digest(resolve(root, host, 'wasm', variant, file))) throw new Error(`Stale ${host}/${variant}/${file}`);
    console.log(`Measure ${variant}/${file}: ${source}`);
  }
}
if (!flags.has('--web-only')) {
  pnpm(['stage:assets']);
  for (const pkg of ['@orca/color-sampler-native', '@orca/bambu-native']) pnpm(['--filter', pkg, 'stage:runtime']);
  pnpm(['exec', 'electron-vite', 'build', '--mode', 'e2e'], base, desktop);
  await cp(resolve(desktop, 'src/renderer/public'), resolve(desktop, 'out/renderer'), { recursive: true, force: true });
  await verify('apps/desktop/out/renderer', 'threaded', ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data']);
  pnpm(['exec', 'playwright', 'test', 'e2e/measure.e2e.ts'], base, desktop);
}
if (!flags.has('--desktop-only')) {
  const env = { ...base, ORCA_WEB_NO_ISOLATION: flags.has('--serial') ? '1' : '0' };
  const config = flags.has('--wasm32') ? 'playwright.measure-wasm32.config.ts' : 'playwright.config.ts';
  pnpm(['exec', 'playwright', 'test', '--config', `../../apps/web/${config}`, 'e2e/measure.e2e.ts'], env, desktop);
  const variant = `${flags.has('--wasm32') ? 'wasm32/' : ''}${flags.has('--serial') ? 'serial' : 'threaded'}`;
  await verify('apps/web/dist', variant, ['orca_slice.wasm', 'orca_slice.data']);
}
