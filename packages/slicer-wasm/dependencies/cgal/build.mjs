// Pinned, host-neutral source preparation and numerical-library build.
// The native tools only generate target-independent tables; all libraries
// are built by Emscripten and are selected by address width/threading mode.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '../..');
const stageFiles = ['lib/libgmp.a', 'lib/libgmpxx.a', 'lib/libmpfr.a', 'include/gmp.h',
  'include/gmpxx.h', 'include/mpfr.h', 'include/mpf2mpfr.h', 'include/CGAL/version.h',
  'include/CGAL/CORE/Expr.h', 'include/CGAL/FPU.h'];
const recipes = [
  { name: 'gmp', version: '6.2.1', directory: 'gmp-6.2.1', archive: 'gmp-6.2.1.tar.bz2',
    url: 'https://github.com/SoftFever/OrcaSlicer_deps/releases/download/gmp-6.2.1/gmp-6.2.1.tar.bz2',
    sha256: 'eae9326beb4158c386e39a356818031bd28f3124cf915f8c5b1dc4c7a36b4d7c' },
  { name: 'mpfr', version: '4.2.2', directory: 'mpfr-4.2.2', archive: 'mpfr-4.2.2.tar.bz2',
    url: 'https://ftp.gnu.org/gnu/mpfr/mpfr-4.2.2.tar.bz2',
    sha256: '9ad62c7dc910303cd384ff8f1f4767a655124980bb6d8650fe62c815a231bb7b' },
  { name: 'cgal', version: '5.6.3', directory: 'CGAL-5.6.3', archive: 'CGAL-5.6.3.zip',
    url: 'https://github.com/CGAL/cgal/releases/download/v5.6.3/CGAL-5.6.3.zip',
    sha256: '5d577acb4a9918ccb960491482da7a3838f8d363aff47e14d703f19fd84733d4' },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
  return result;
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function writeChanged(path, bytes) {
  try { if ((await readFile(path)).equals(Buffer.from(bytes))) return; }
  catch { /* first generation */ }
  await writeFile(path, bytes);
}

async function recipeDigest() {
  const hash = createHash('sha256');
  for (const name of ['build.mjs', 'CMakeLists.txt', 'gmp-mpn.json', 'gmp-config.h.in',
    'mpfr-defs-32.json', 'mpfr-defs-64.json', 'host/CMakeLists.txt']) {
    hash.update(name).update(await readFile(join(here, name)));
  }
  hash.update(await readFile(join(pkg, 'cpp/deps/GMP/0001-GMP_GCC15.patch')));
  return hash.digest('hex');
}

export async function source(recipe, work) {
  const downloads = join(work, 'deps/downloads');
  await mkdir(downloads, { recursive: true });
  const archive = join(downloads, recipe.archive);
  let valid = false;
  try { valid = await digest(archive) === recipe.sha256; } catch { /* cold cache */ }
  if (!valid) {
    for (let attempt = 1; attempt <= 3; ++attempt) {
      try {
        const response = await fetch(recipe.url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        await pipeline(Readable.fromWeb(response.body), createWriteStream(`${archive}.part`));
        if (await digest(`${archive}.part`) !== recipe.sha256) throw new Error('Checksum mismatch');
        await rename(`${archive}.part`, archive);
        break;
      } catch (error) {
        await rm(`${archive}.part`, { force: true });
        const reason = [error.message, error.cause?.message].filter(Boolean).join(': ');
        if (attempt === 3) throw new Error(`Download failed after ${attempt} attempts: ${recipe.url}: ${reason}`, { cause: error });
        console.warn(`[cgal] Download attempt ${attempt} failed for ${recipe.url}: ${reason}; retrying`);
        await delay(attempt * 1000);
      }
    }
  }
  const parent = join(work, 'deps', `${recipe.name}-${recipe.version}`);
  const directory = join(parent, `src-${recipe.sha256.slice(0, 12)}`);
  const marker = recipe.sha256 + (recipe.name === 'gmp' ? `:${await digest(join(pkg, 'cpp/deps/GMP/0001-GMP_GCC15.patch'))}` : '');
  try {
    if ((await readFile(join(directory, '.source-sha256'), 'utf8')).trim() === marker) return directory;
  } catch { /* source preparation required */ }
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.unpack-${process.pid}`);
  await mkdir(temporary, { recursive: true });
  try {
    // CMake's libarchive supports both ZIP and tar.bz2 on all build hosts;
    // Linux GNU tar cannot extract the pinned CGAL ZIP.
    run('cmake', ['-E', 'tar', 'xf', archive], { cwd: temporary });
    const extracted = join(temporary, recipe.directory);
    if (recipe.name === 'gmp') {
      // Preserve Orca's GCC15 configure-probe fix. Its diff names the new
      // acinclude file .m4.2; apply the exact replacement to the two inputs
      // without requiring POSIX patch or following cache-directory symlinks.
      for (const name of ['configure', 'acinclude.m4']) {
        const path = join(extracted, name);
        const text = await readFile(path, 'utf8');
        if (!text.includes('void g(){}')) throw new Error(`GMP compatibility patch no longer applies: ${name}`);
        await writeFile(path, text.replaceAll('void g(){}', 'void g(int a,t1 const*b,t1 c,t2 dd,t1 const*e,int ff){}'));
      }
    }
    await writeFile(join(extracted, '.source-sha256'), `${marker}\n`);
    await rm(directory, { recursive: true, force: true });
    // Windows scanners can briefly hold freshly extracted files open, which
    // prevents renaming their parent directory even after CMake has exited.
    for (let attempt = 1; ; ++attempt) {
      try {
        await rename(extracted, directory);
        break;
      } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 6) throw error;
        console.warn(`[cgal] Source rename attempt ${attempt} failed (${error.code}); retrying`);
        await delay(attempt * 200);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return directory;
}

export function settings(args, environment = process.env) {
  const options = { command: 'build', width: 64, threaded: environment.WASM_THREADING !== '0' };
  if (args[0] && !args[0].startsWith('--')) options.command = args.shift();
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value) throw new Error(`Missing value for ${args[i]}`);
    if (args[i] === '--target' && /^wasm(32|64)$/.test(value)) options.width = Number(value.slice(4));
    else if (args[i] === '--variant' && /^(serial|threaded)$/.test(value)) options.threaded = value === 'threaded';
    else if (args[i] === '--stage') options.stage = resolve(value);
    else throw new Error(`Invalid option: ${args[i]} ${value}`);
  }
  if (!['build', 'verify', 'fetch'].includes(options.command)) throw new Error('Expected build, verify or fetch');
  options.work = resolve(environment.WORK_DIR || join(pkg, '.work'));
  options.variant = options.threaded ? 'threaded' : 'serial';
  options.stage ||= join(options.work, `deps/cgal-5.6.3/stage-wasm${options.width}-${options.variant}`);
  return options;
}

function emscriptenRoot() {
  const candidates = [process.env.EMSCRIPTEN, process.env.EMSDK && join(process.env.EMSDK, 'upstream/emscripten')];
  if (process.platform !== 'win32') {
    const result = spawnSync('em-config', ['EMSCRIPTEN_ROOT'], { encoding: 'utf8' });
    if (result.status === 0) candidates.push(result.stdout.trim());
  }
  const path = candidates.find(Boolean);
  if (!path) throw new Error('Activate emsdk or set EMSCRIPTEN before building numerical dependencies');
  return path;
}

export function compilerVersion() {
  // Use the active launcher, just like the build driver. It owns SDK Python
  // selection; Windows installations may expose either emcc.exe or emcc.bat.
  // The shell command is fixed text, with no paths or user arguments to quote.
  const compiler = process.platform === 'win32'
    ? spawnSync('emcc --version', { shell: true, encoding: 'utf8' })
    : spawnSync('emcc', ['--version'], { encoding: 'utf8' });
  const version = compiler.stdout?.trim();
  if (compiler.status !== 0 || !version) {
    const detail = [compiler.error?.message, compiler.stderr?.trim(), compiler.signal].filter(Boolean).join('; ');
    throw new Error(`Cannot identify the active Emscripten compiler (emcc --version, exit ${compiler.status ?? 'not started'}): ${detail || 'no version output'}`);
  }
  return version;
}

async function identity(options) {
  return { width: options.width, threaded: options.threaded,
    compiler: compilerVersion(), recipe: await recipeDigest(),
    sources: Object.fromEntries(recipes.map(r => [r.name, { version: r.version, sha256: r.sha256 }])) };
}

export async function verifyStage(options, expected = undefined) {
  expected ||= await identity(options);
  const manifest = JSON.parse(await readFile(join(options.stage, 'manifest.json'), 'utf8'));
  if (JSON.stringify(manifest.identity) !== JSON.stringify(expected)) throw new Error(`Numerical stage configuration changed: ${options.stage}`);
  for (const name of stageFiles) {
    const hash = manifest.files?.[name];
    if (typeof hash !== 'string') throw new Error(`Numerical stage inventory missing: ${name}`);
    if (await digest(join(options.stage, name)) !== hash) throw new Error(`Numerical stage file changed: ${name}`);
  }
  return manifest;
}

async function main(args) {
  const options = settings(args);
  if (options.command === 'verify') {
    await verifyStage(options);
    return;
  }
  const expected = await identity(options);
  try {
    await verifyStage(options, expected);
    console.log(`[cgal] Reusing ${options.stage}`);
    return;
  } catch { /* configuration mismatch or cold cache: rebuild */ }
  const [gmp, mpfr, cgal] = await Promise.all(recipes.map(r => source(r, options.work)));
  if (options.command === 'fetch') return;
  const jobs = process.env.WASM_BUILD_JOBS || '2';
  const host = join(options.work, 'cgal-generators');
  const nativeEnvironment = { ...process.env };
  for (const key of ['CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'CMAKE_TOOLCHAIN_FILE']) delete nativeEnvironment[key];
  run('cmake', ['-S', join(here, 'host'), '-B', host, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DGMP_SOURCE=${gmp}`], { env: nativeEnvironment });
  run('cmake', ['--build', host, '--parallel', jobs], { env: nativeEnvironment });
  const tables = join(options.work, `cgal-tables-wasm${options.width}`);
  await mkdir(join(tables, 'mpn'), { recursive: true });
  const generate = async (name, args, output) => {
    const result = run(join(host, `gen-${name}${process.platform === 'win32' ? '.exe' : ''}`), args,
      { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 8 * 1024 * 1024 });
    await writeChanged(join(tables, output), result.stdout);
  };
  const bits = String(options.width);
  await generate('fac', [bits, '0'], 'fac_table.h');
  await generate('fib', ['header', bits, '0'], 'fib_table.h');
  await generate('fib', ['table', bits, '0'], 'mpn/fib_table.c');
  await generate('bases', ['header', bits, '0'], 'mp_bases.h');
  await generate('bases', ['table', bits, '0'], 'mpn/mp_bases.c');
  await generate('trialdivtab', [bits, '8000'], 'trialdivtab.h');
  await generate('jacobitab', [], 'mpn/jacobitab.h');
  await generate('psqr', [bits, '0'], 'mpn/perfsqr.h');
  const build = join(options.work, `cgal-build-wasm${options.width}-${options.variant}`);
  const flags = `-m${options.width} -fexceptions${options.threaded ? ' -pthread' : ''}`;
  run('cmake', ['-S', here, '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_TOOLCHAIN_FILE=${join(emscriptenRoot(), 'cmake/Modules/Platform/Emscripten.cmake')}`,
    `-DCMAKE_C_FLAGS=${flags}`, `-DCMAKE_CXX_FLAGS=${flags}`, `-DCMAKE_INSTALL_PREFIX=${options.stage}`,
    `-DWASM_WIDTH=${bits}`, `-DWASM_THREADING=${options.threaded ? 'ON' : 'OFF'}`,
    `-DGMP_SOURCE=${gmp}`, `-DMPFR_SOURCE=${mpfr}`, `-DGMP_TABLES=${tables}`]);
  run('cmake', ['--build', build, '--parallel', jobs]);
  run('cmake', ['--install', build]);
  await cp(join(cgal, 'include'), join(options.stage, 'include'), { recursive: true });
  const files = {};
  for (const name of stageFiles) {
    files[name] = await digest(join(options.stage, name));
  }
  await writeFile(join(options.stage, 'manifest.json'), `${JSON.stringify({ identity: expected, files }, null, 2)}\n`);
  await verifyStage(options, expected);
  console.log(`[cgal] Staged full numerical dependency closure: ${options.stage}`);
}

// wasm32's scaffold links this directory to the authoritative recipe. Node
// resolves import.meta.url through that link, while argv retains its spelling.
if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`[cgal] ${error.message}`); process.exitCode = 1; }
}
