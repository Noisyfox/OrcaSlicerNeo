// Only the current host's production addon is staged; fixtures never enter installers.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Screen color addon build failed');
}
export function buildAddon() {
  run([require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild']);
  run([join(dirname(require.resolve('typescript/package.json')), require('typescript/package.json').bin.tsc), '-p', 'tsconfig.json']);
}
export async function stageRuntime() {
  const destination = join(root, 'out/runtime');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(join(root, 'build/Release/screen_color.node'), join(destination, 'screen_color.node'));
}
export async function prepareRuntime(target = `${process.platform}-${process.arch}`) {
  if (target !== `${process.platform}-${process.arch}`) throw new Error(`Screen color addon needs a matching native runner: ${target}`);
  buildAddon();
  await stageRuntime();
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes('--build-only')) buildAddon();
  else await prepareRuntime();
}
