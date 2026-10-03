// Run the existing comprehensive bridge contract with /tmp backed by NODEFS.
// The child owns all WASM threads; cleanup waits until it has exited.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateGcode } from './run-slice.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const modulePath = resolve(process.argv[2] ?? join(repo, 'packages/slicer-wasm/out/threaded/orca_slice.js'));
const directory = await mkdtemp(join(tmpdir(), 'orca-nodefs-smoke space-'));
const native = join(directory, 'native-files');
const { mkdir } = await import('node:fs/promises');
await mkdir(native);
const wrapper = join(directory, 'nodefs-module.mjs');
const source = `import factory from ${JSON.stringify(pathToFileURL(modulePath).href)};
import { join } from 'node:path';
export default async function(options) {
  const module = await factory({ ...options, locateFile: (file) => join(${JSON.stringify(dirname(modulePath))}, file) });
  if (!module.FS.filesystems.NODEFS) throw new Error('threaded artifact lacks NODEFS');
  module.FS.mount(module.FS.filesystems.NODEFS, { root: ${JSON.stringify(native)} }, '/tmp');
  return module;
}
`;
try {
  await writeFile(wrapper, source);
  const started = performance.now();
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [
      join(repo, 'packages/slicer-wasm/harness/bridge-smoke.mjs'), wrapper,
      join(repo, 'packages/slicer-wasm/fixtures/cube.stl'),
      join(repo, 'packages/profile-resources/dist'),
    ], { cwd: repo, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolveExit(exitCode));
  });
  assert.equal(code, 0, 'NODEFS bridge contract failed');
  const files = await readdir(native);
  assert(files.includes('orca.log'), 'C++ logger did not write to native /tmp');
  const results = files.filter((file) => /^plate-result-.*\.gcode$/.test(file));
  assert(results.length > 0, 'C++ slicer did not leave a native generation file');
  for (const file of results) assert(validateGcode(await readFile(join(native, file))).ok, file);
  console.log('[nodefs-bridge-smoke]', JSON.stringify({ elapsedMs: performance.now() - started, files, results }));
} finally {
  // directory is the exact mkdtemp result; no caller path is recursively removed.
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
