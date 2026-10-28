// Reuse the wasm64 scaffold in a separate generated build tree. Keeping the
// authoritative native inputs unchanged also preserves existing wasm64 cache keys.
import { copyFile, mkdir, readFile, readdir, symlink, writeFile, lstat, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'packages/slicer-wasm');
export const work = join(pkg, '.work/wasm32');
const scaffold = join(work, 'scaffold');
export const generatedPackage = join(scaffold, 'packages/slicer-wasm');

function replaceRequired(source, from, to) {
  if (!source.includes(from)) throw new Error(`wasm32 scaffold input changed; missing ${from}`);
  return source.replaceAll(from, to);
}

export function wasm32Source(source, name) {
  let result = source.replaceAll('-m64', '-m32').replaceAll('wasm64', 'wasm32')
    .replaceAll('address-model=64', 'address-model=32')
    .replaceAll('CMAKE_SIZEOF_VOID_P:INTERNAL=8', 'CMAKE_SIZEOF_VOID_P:INTERNAL=4');
  if (name === 'CMakeLists.txt') result = replaceRequired(result, '-sMAXIMUM_MEMORY=16GB', '-sMAXIMUM_MEMORY=2GB');
  // Git's relative submodule .git file cannot be resolved through the scaffold.
  if (name === 'build.sh') result = replaceRequired(result, 'ORCA_SRC="$PKG_DIR/cpp"', `ORCA_SRC="${pkg.replaceAll('\\', '/')}/cpp"`);
  if (name === 'build.bat') {
    result = replaceRequired(result, 'set "ORCA_SRC=%PKG_DIR%\\cpp"', `set "ORCA_SRC=${join(pkg, 'cpp')}"`);
    result = result.replace('echo [wasm] Running fetch-deps.bat (Eigen/Boost/cereal + generated headers)',
      'echo [wasm] Running fetch-deps.bat ^(Eigen/Boost/cereal + generated headers^)');
    result = replaceRequired(result, 'emmake ninja -C "%BUILD_DIR%" orca_slice',
      'emmake ninja -C "%BUILD_DIR%" orca_slice -j %WASM_BUILD_JOBS%');
  }
  return name.endsWith('.bat') ? result.replace(/\r?\n/g, '\r\n') : result.replace(/\r\n/g, '\n');
}

async function linkDirectory(target, path) {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) throw new Error(`expected generated directory link at ${path}`);
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

export async function prepareWasm32() {
  await mkdir(generatedPackage, { recursive: true });
  await mkdir(join(scaffold, 'scripts'), { recursive: true });
  await writeFile(join(scaffold, 'package.json'), '{"type":"module"}\n');
  for (const name of ['cpp', 'src', 'stubs', 'shim', 'patches', 'harness', 'fixtures']) {
    await linkDirectory(join(pkg, name), join(generatedPackage, name));
  }
  await linkDirectory(work, join(generatedPackage, '.work'));
  for (const name of await readdir(pkg)) {
    if (name !== 'CMakeLists.txt' && !name.endsWith('.sh') && !name.endsWith('.bat')) continue;
    const source = await readFile(join(pkg, name), 'utf8');
    await writeFile(join(generatedPackage, name.replaceAll('wasm64', 'wasm32')), wasm32Source(source, name));
  }
  await copyFile(join(root, 'scripts/validate-wasm.mjs'), join(scaffold, 'scripts/validate-wasm.mjs'));
  const driver = await readFile(join(root, 'scripts/build-windows.bat'), 'utf8');
  await writeFile(join(scaffold, 'scripts/build-windows.bat'), driver.replaceAll('wasm64', 'wasm32').replace('  pause', '  REM non-interactive build'));
  // Invoke the repository's cmd-native driver, but collect only the requested
  // variant and never run desktop staging from this Web-only build tree.
  await writeFile(join(scaffold, 'scripts/build-wasm-dual.bat'), [
    '@echo off', 'setlocal EnableExtensions',
    'set "WASM_ARTIFACT_VARIANT=%VARIANT%"',
    'if /i "%VARIANT%"=="serial" (set "WASM_THREADING=0") else (set "WASM_THREADING=1")',
    'call "%~dp0..\\packages\\slicer-wasm\\build.bat"', 'exit /b %errorlevel%', '',
  ].join('\r\n'));
}

function run(file, args = [], env = {}) {
  const result = spawnSync(file, args, { stdio: 'inherit', env: { WASM_BUILD_JOBS: '4', ...process.env, WORK_DIR: work, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} exited ${result.status}`);
}

function linuxHelper(name, env) { run('bash', [join(generatedPackage, name)], env); }

export async function verifyDependencies() {
  const deps = join(work, 'deps');
  const requireFile = async path => { if (!(await stat(path)).isFile()) throw new Error(`Missing compiled wasm32 dependency: ${path}`); };
  const boost = join(deps, 'boost-1.84.0/stage-wasm32/lib');
  const archives = await readdir(boost);
  if (!archives.some(name => /(?:lib)?boost_filesystem.*\.(?:a|lib)$/.test(name))) throw new Error(`No Boost.Filesystem archive in ${boost}`);
  await requireFile(join(deps, 'boost-1.84.0/boost/version.hpp'));
  for (const file of ['include/tbb/tbb.h', 'lib/libtbb.a', 'lib/libtbbmalloc.a']) {
    await requireFile(join(deps, 'oneTBB-3cdc6f6558ba23ec9ceed92078b49dc664ed5bf3/stage-wasm32-pthreads', file));
  }
  for (const variant of ['threaded', 'serial']) {
    for (const suffix of [`nlopt-2.5.0/stage-wasm32-${variant}/include/nlopt.hpp`,
      `nlopt-2.5.0/stage-wasm32-${variant}/lib/libnlopt.a`, `draco-1.5.7/stage-wasm32-${variant}/lib/libdraco.a`,
      `occt-7.6.0/stage-wasm32-${variant}/include/opencascade/Standard.hxx`, `occt-7.6.0/stage-wasm32-${variant}/lib/libTKXDESTEP.a`]) {
      await requireFile(join(deps, suffix));
    }
  }
}

async function main() {
  const [command = 'help', option, variant = 'both'] = process.argv.slice(2);
  if (command === 'help') {
    console.log('node scripts/build-wasm32.mjs prepare|deps|verify-deps|build [--variant threaded|serial|both]');
    return;
  }
  if (!['prepare', 'deps', 'verify-deps', 'build'].includes(command) || (option && option !== '--variant')
    || !['threaded', 'serial', 'both'].includes(variant)) throw new Error('Invalid wasm32 build command (see help)');
  if (command === 'verify-deps') return verifyDependencies();
  await prepareWasm32();
  if (command === 'prepare') return;
  if (command === 'deps') {
    if (process.platform === 'win32') throw new Error('Dependency bootstrap runs in Linux CI. On Windows activate emsdk and run the generated cmd-native dependency helpers.');
    linuxHelper('fetch-deps.sh');
    linuxHelper('build-boost-wasm32.sh');
    linuxHelper('build-onetbb.sh');
    run(process.execPath, [join(pkg, 'harness/run-tbb-parallelism-probe.mjs'), join(generatedPackage, 'out/orca_tbb_probe.js')]);
    for (const mode of ['threaded', 'serial']) for (const dep of ['nlopt', 'draco', 'occt']) {
      linuxHelper(`build-${dep}-wasm32.sh`, { WASM_THREADING: mode === 'threaded' ? '1' : '0', WASM_ARTIFACT_VARIANT: mode });
    }
    await verifyDependencies();
    return;
  }
  for (const mode of variant === 'both' ? ['threaded', 'serial'] : [variant]) {
    const env = { WASM_THREADING: mode === 'threaded' ? '1' : '0', WASM_ARTIFACT_VARIANT: mode,
      WASM_OUT_DIR: join(pkg, 'out/wasm32', mode) };
    if (process.platform === 'win32') {
      run('cmd.exe', ['/d', '/c', join(scaffold, 'scripts/build-windows.bat'), 'deps'], env);
      run('cmd.exe', ['/d', '/c', join(scaffold, 'scripts/build-windows.bat'), 'build', '--variant', mode], env);
    } else {
      linuxHelper('fetch-deps.sh');
      linuxHelper('build.sh', env);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
