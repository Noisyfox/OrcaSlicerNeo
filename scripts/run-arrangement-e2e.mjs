import { spawnSync } from 'node:child_process';
import { cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'), desktop = resolve(root, 'apps/desktop');
const base = { ...process.env, ORCA_E2E_REAL: '1', ORCA_E2E_VISIBLE: '1', VITE_E2E: '1', VITE_USE_MOCK: '0', CI: '1' };
function pnpm(args, env = base, cwd = root) {
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args,
    { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
async function verifyArtifacts(host, variant, names) {
  for (const name of names) {
    const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
    const source = await digest(resolve(root, `packages/slicer-wasm/out/${variant}`, name));
    const target = await digest(resolve(root, host, `wasm/${variant}`, name));
    if (source !== target) throw new Error(`Staged ${variant}/${name} differs from the current build`);
    console.log(`arrangement ${variant} ${name}: ${source}`);
  }
}

pnpm(['stage:assets']);
if (!process.argv.includes('--web-only')) {
  const variant = process.argv.includes('--desktop-threaded') ? 'threaded' : 'serial';
  const env = { ...base, VITE_SCOPED_CONFIGURATION_GATE: '1', VITE_SCOPED_CONFIGURATION_GATE_VARIANT: variant,
    ORCA_E2E_ARRANGEMENT_EXPECT_VARIANT: variant };
  pnpm(['exec', 'electron-vite', 'build', '--mode', 'e2e'], env, desktop);
  await cp(resolve(desktop, 'src/renderer/public'), resolve(desktop, 'out/renderer'), { recursive: true, force: true });
  await verifyArtifacts('apps/desktop/out/renderer', variant, ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data']);
  pnpm(['exec', 'playwright', 'test', 'e2e/arrangement.e2e.ts'], env, desktop);
}
if (!process.argv.includes('--desktop-only')) {
  const env = { ...base, ORCA_WEB_NO_ISOLATION: '0', VITE_SCOPED_CONFIGURATION_GATE: '0', VITE_SCOPED_CONFIGURATION_GATE_VARIANT: '' };
  await verifyArtifacts('apps/desktop/src/renderer/public', 'threaded', ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data']);
  pnpm(['exec', 'playwright', 'test', '--config', '../../apps/web/playwright.config.ts', 'e2e/arrangement.e2e.ts'], env, desktop);
  // Vite intentionally rewrites Node-only imports in Web's JS loader. The
  // native WASM/data identity remains exact and is checked after its build.
  await verifyArtifacts('apps/web/dist', 'threaded', ['orca_slice.wasm', 'orca_slice.data']);
}
