// Build the host addon and prepare the exact resource tree used by Electron.
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquire, manifest } from './acquire.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: packageRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Bambu native build failed (${result.status})`);
}

export function buildAddon() {
  runNode([join(packageRoot, 'scripts/verify-declarations.mjs')]);
  runNode([require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild']);
  runNode([join(dirname(require.resolve('typescript/package.json')), require('typescript/package.json').bin.tsc), '-p', 'tsconfig.json']);
}

/** Keep side libraries beside the plugin; never copy fixture binaries or sources. */
export async function stageRuntime({ target, addonPath, pluginDirectory, certificateDirectory, destination }) {
  const artifact = manifest.artifacts[target];
  if (!artifact) throw new Error(`No pinned Bambu plugin for ${target}`);
  await Promise.all([
    access(addonPath), access(join(pluginDirectory, artifact.library)),
    access(join(pluginDirectory, 'neo-artifact.json')),
    access(join(certificateDirectory, 'slicer_base64.cer')),
    access(join(certificateDirectory, 'printer.cer')),
  ]);
  const staging = `${destination}.staging`;
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging, { recursive: true });
    await cp(addonPath, join(staging, 'bambu.node'));
    await cp(pluginDirectory, join(staging, 'plugin'), { recursive: true });
    // Orca passes the resource directory and an entry filename. Preserve the
    // complete directory, including printer.cer, when reproducing that call.
    await cp(certificateDirectory, join(staging, 'cert'), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return destination;
}

export async function prepareRuntime(target = `${process.platform}-${process.arch}`) {
  // Packaging must use a native runner, rather than accidentally shipping the
  // host addon beside a different architecture's downloaded Electron/plugin.
  if (target !== `${process.platform}-${process.arch}`) throw new Error(`Build Bambu resources on a ${target} host`);
  buildAddon();
  const plugin = await acquire(target);
  return stageRuntime({
    target, addonPath: join(packageRoot, 'build/Release/bambu.node'),
    pluginDirectory: dirname(plugin), destination: join(packageRoot, 'out/runtime'),
    certificateDirectory: resolve(packageRoot, '../slicer-wasm/cpp/resources/cert'),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--build-only') buildAddon();
  else console.log(await prepareRuntime(process.argv[2]));
}
