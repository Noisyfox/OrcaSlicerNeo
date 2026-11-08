// Compile the STEP, convex-hull and XML dependencies with one recipe on all
// hosts. Every stage is tied to its source, patches, compiler and WASM variant.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilerVersion, digest, emscriptenRoot, source } from '../cgal/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '../..');
export const occtToolkits = ['TKBO', 'TKBRep', 'TKCAF', 'TKCDF', 'TKDE', 'TKDESTEP', 'TKG2d', 'TKG3d',
  'TKGeomAlgo', 'TKGeomBase', 'TKHLR', 'TKLCAF', 'TKMath', 'TKMesh', 'TKPrim', 'TKService',
  'TKShHealing', 'TKTopAlgo', 'TKV3d', 'TKVCAF', 'TKXCAF', 'TKXSBase', 'TKernel'];
export const recipes = {
  occt: { name: 'occt', version: '8.0.1', directory: 'OCCT-8_0_1', archive: 'occt-8.0.1.zip',
    url: 'https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/V8_0_1.zip',
    sha256: '7c033d917ee8f040c0512d289dcc5f02c148889d5bac17c3e25639accb44f0da',
    files: ['include/opencascade/Standard.hxx', 'include/opencascade/Standard_Version.hxx',
      ...occtToolkits.map(name => `lib/lib${name}.a`)] },
  qhull: { name: 'qhull', version: '8.0.2', directory: 'qhull-8.0.2', archive: 'qhull-8.0.2.zip',
    url: 'https://github.com/qhull/qhull/archive/v8.0.2.zip',
    sha256: 'a378e9a39e718e289102c20d45632f873bfdc58a7a5f924246ea4b176e185f1e',
    files: ['include/libqhull_r/libqhull_r.h', 'include/libqhullcpp/Qhull.h', 'lib/libqhullcpp.a', 'lib/libqhullstatic_r.a'] },
  expat: { name: 'expat', version: '2.5.0', files: ['include/expat.h', 'include/expat_external.h',
    'include/expat_config.h', 'include/expat_configure.h', 'lib/libexpat.a'] },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
  return result;
}

export function settings(args, environment = process.env) {
  const options = { command: 'build', width: 64, threaded: environment.WASM_THREADING !== '0' };
  if (args[0] && !args[0].startsWith('--')) options.command = args.shift();
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (args[i] === '--library' && Object.hasOwn(recipes, value)) options.library = value;
    else if (args[i] === '--target' && /^wasm(32|64)$/.test(value)) options.width = Number(value.slice(4));
    else if (args[i] === '--variant' && /^(serial|threaded)$/.test(value)) options.threaded = value === 'threaded';
    else if (args[i] === '--stage' && value) options.stage = resolve(value);
    else throw new Error(`Invalid option: ${args[i]} ${value}`);
  }
  if (!options.library || !['build', 'verify', 'fetch'].includes(options.command)) {
    throw new Error('Expected build|verify|fetch --library occt|qhull|expat [--target wasm32|wasm64] [--variant serial|threaded]');
  }
  options.work = resolve(environment.WORK_DIR || join(pkg, '.work'));
  options.variant = options.threaded ? 'threaded' : 'serial';
  const recipe = recipes[options.library];
  options.stage ||= join(options.work, `deps/${recipe.name}-${recipe.version}/stage-wasm${options.width}-${options.variant}`);
  return options;
}

async function directoryDigest(directory, hash = createHash('sha256'), prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await directoryDigest(join(directory, entry.name), hash, `${name}/`);
    else if (entry.isFile()) hash.update(name).update(await readFile(join(directory, entry.name)));
  }
  return hash;
}

async function identity(options) {
  const recipe = recipes[options.library];
  const hash = createHash('sha256');
  hash.update(await readFile(fileURLToPath(import.meta.url)));
  hash.update(await readFile(join(here, '../cgal/build.mjs')));
  if (options.library === 'occt') await directoryDigest(join(pkg, 'patches/occt'), hash);
  const sources = recipe.sha256 || (await directoryDigest(join(pkg, 'cpp/deps/EXPAT/expat'))).digest('hex');
  return { library: recipe.name, version: recipe.version, width: options.width, threaded: options.threaded,
    compiler: compilerVersion(), recipe: hash.digest('hex'), sources,
    ...(options.library === 'occt' ? { freetype: false } : {}) };
}

export async function verifyStage(options, expected = undefined) {
  expected ||= await identity(options);
  const manifest = JSON.parse(await readFile(join(options.stage, 'manifest.json'), 'utf8'));
  if (JSON.stringify(manifest.identity) !== JSON.stringify(expected)) throw new Error(`External stage configuration changed: ${options.stage}`);
  for (const name of recipes[options.library].files) {
    if (typeof manifest.files?.[name] !== 'string' || await digest(join(options.stage, name)) !== manifest.files[name]) {
      throw new Error(`External stage file changed or missing: ${name}`);
    }
  }
  return manifest;
}

async function prepareSource(options) {
  if (options.library === 'expat') return join(pkg, 'cpp/deps/EXPAT/expat');
  const directory = await source(recipes[options.library], options.work);
  if (options.library === 'occt') {
    run('git', ['-C', directory, 'init', '-q']);
    for (const name of (await readdir(join(pkg, 'patches/occt'))).filter(name => name.endsWith('.patch')).sort()) {
      const patch = join(pkg, 'patches/occt', name);
      const check = spawnSync('git', ['-C', directory, 'apply', '--check', patch], { stdio: 'ignore' });
      if (check.status === 0) run('git', ['-C', directory, 'apply', patch]);
      else run('git', ['-C', directory, 'apply', '--reverse', '--check', patch]);
    }
  }
  return directory;
}

export function configureArgs(options) {
  // Preserve OCCT's Release check policy from old Neo and the pinned Orca
  // recipe. No_Exception suppresses optional OCCT checks; it is independent
  // of the Emscripten C++ exception support enabled in the compiler flags.
  if (options.library === 'occt') return [
    '-DBUILD_LIBRARY_TYPE=Static', '-DBUILD_RELEASE_DISABLE_EXCEPTIONS=ON', '-DBUILD_MODULE_ApplicationFramework=OFF', '-DBUILD_MODULE_DataExchange=OFF',
    '-DBUILD_MODULE_FoundationClasses=OFF', '-DBUILD_MODULE_ModelingAlgorithms=OFF', '-DBUILD_MODULE_ModelingData=OFF',
    '-DBUILD_MODULE_Draw=OFF', '-DBUILD_MODULE_Visualization=OFF', '-DBUILD_ADDITIONAL_TOOLKITS=TKDESTEP',
    '-DBUILD_DOC_Overview=OFF', '-DUSE_TK=OFF', '-DUSE_TBB=OFF', '-DUSE_FFMPEG=OFF', '-DUSE_VTK=OFF',
    '-DUSE_OPENGL=OFF', '-DUSE_GLES2=OFF', '-DUSE_FREETYPE=OFF',
    `-DINSTALL_DIR:PATH=${options.stage}`, '-DINSTALL_DIR_LAYOUT=Unix', '-DINSTALL_DIR_INCLUDE=include/opencascade', '-DINSTALL_DIR_LIB=lib'];
  if (options.library === 'qhull') return ['-DBUILD_SHARED_LIBS=OFF', '-DBUILD_STATIC_LIBS=ON', '-DQHULL_ENABLE_TESTING=OFF'];
  // Emscripten's /dev/urandom device uses crypto.getRandomValues (Web) or
  // crypto.randomFillSync (Node). Its libc lacks the native getrandom APIs
  // tested by Expat; retain secure hash seeding through that device.
  return ['-DBUILD_SHARED_LIBS=OFF', '-DXML_NS=ON', '-DXML_DTD=ON', '-DXML_CONTEXT_BYTES=1024', '-DXML_DEV_URANDOM=ON'];
}

async function findFile(directory, filename) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, filename);
      if (found) return found;
    }
  }
}

async function main(args) {
  const options = settings(args);
  if (options.command === 'fetch') { await prepareSource(options); return; }
  if (options.command === 'verify') { await verifyStage(options); return; }
  const expected = await identity(options);
  try { await verifyStage(options, expected); console.log(`[${options.library}] Reusing ${options.stage}`); return; }
  catch { /* Cold or stale stage: rebuild with this exact recipe. */ }
  const directory = await prepareSource(options);
  const recipe = recipes[options.library];
  const build = join(options.work, `${recipe.name}-${recipe.version}-build-wasm${options.width}-${options.variant}-${createHash('sha256').update(expected.compiler).digest('hex').slice(0, 12)}`);
  const flags = `-m${options.width} -fexceptions${options.threaded ? ' -pthread' : ''}`;
  run('cmake', ['-S', directory, '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5', '-DCMAKE_CXX_STANDARD=17',
    `-DCMAKE_TOOLCHAIN_FILE=${join(emscriptenRoot(), 'cmake/Modules/Platform/Emscripten.cmake')}`,
    `-DCMAKE_C_FLAGS=${flags}`, `-DCMAKE_CXX_FLAGS=${flags}`, `-DCMAKE_EXE_LINKER_FLAGS=${flags}`,
    ...configureArgs(options)]);
  const targets = options.library === 'occt' ? occtToolkits : options.library === 'qhull' ? ['qhullcpp', 'qhullstatic_r'] : ['expat'];
  run('cmake', ['--build', build, '--target', ...targets, '--parallel', process.env.WASM_BUILD_JOBS || (options.library === 'occt' ? '4' : '2')]);
  await rm(options.stage, { recursive: true, force: true });
  await mkdir(join(options.stage, 'include'), { recursive: true });
  await mkdir(join(options.stage, 'lib'), { recursive: true });
  if (options.library === 'occt') {
    // OCCT's build headers forward to absolute source paths. Its install
    // rules copy the original headers and the generated version header,
    // making stages relocatable when the CI build tree is not restored.
    run('cmake', ['--install', build]);
  } else if (options.library === 'qhull') {
    for (const name of ['libqhull_r', 'libqhullcpp']) {
      await cp(join(directory, 'src', name), join(options.stage, 'include', name), {
        recursive: true, filter: path => !/\.(c|cpp)$/.test(path) });
    }
  } else {
    for (const name of ['expat.h', 'expat_external.h', 'expat_config.h']) await cp(join(directory, name), join(options.stage, 'include', name));
    await cp(join(build, 'expat_configure.h'), join(options.stage, 'include/expat_configure.h'));
  }
  for (const target of targets) {
    const archive = await findFile(build, `lib${target}.a`);
    if (!archive) throw new Error(`Missing ${target} archive`);
    await cp(archive, join(options.stage, `lib/lib${target}.a`));
  }
  const files = {};
  for (const name of recipe.files) files[name] = await digest(join(options.stage, name));
  await writeFile(join(options.stage, 'manifest.json'), `${JSON.stringify({ identity: expected, files }, null, 2)}\n`);
  await verifyStage(options, expected);
  console.log(`[${recipe.name}] Staged ${recipe.version}: ${options.stage}`);
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`[external] ${error.message}`); process.exitCode = 1; }
}
