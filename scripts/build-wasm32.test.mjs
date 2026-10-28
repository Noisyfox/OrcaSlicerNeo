import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { verifyDependencies, wasm32Source } from './build-wasm32.mjs';

const native = new URL('../packages/slicer-wasm/', import.meta.url);
test('wasm32 scaffold targets 32-bit code, separate dependency prefixes and a 4 GiB limit', async () => {
  for (const name of ['CMakeLists.txt', 'build.sh', 'build.bat', 'build-boost-wasm64.sh', 'build-occt-wasm64.sh', 'build-occt-wasm64.bat', 'build-onetbb.sh']) {
    const source = await readFile(new URL(name, native), 'utf8');
    const output = wasm32Source(source, name);
    assert.doesNotMatch(output, /-m64|stage-wasm64|address-model=64|CMAKE_SIZEOF_VOID_P:INTERNAL=8/);
    if (source.includes('-m64')) assert.match(output, /-m32/);
    if (name === 'CMakeLists.txt') assert.match(output, /-sMAXIMUM_MEMORY=4GB/);
    if (name === 'build-occt-wasm64.sh') assert.match(output, /CMAKE_SIZEOF_VOID_P:INTERNAL=4/);
    assert.doesNotMatch(output, /-sUSE_FREETYPE=1|libfreetype\.a|freetype-port-probe/);
    if (name.startsWith('build-occt-')) assert.match(output, /-DUSE_FREETYPE=OFF/);
    if (name.endsWith('.bat')) assert.doesNotMatch(output, /(?<!\r)\n/);
    assert.equal(await readFile(new URL(name, native), 'utf8'), source, 'authoritative wasm64 input was not changed');
  }
});

test('cached wasm32 dependencies require FreeType-free OCCT manifests for both variants', async (t) => {
  const deps = await mkdtemp(join(tmpdir(), 'orca-wasm32-deps-'));
  t.after(async () => {
    assert.equal(dirname(resolve(deps)), resolve(tmpdir()));
    assert.ok(basename(deps).startsWith('orca-wasm32-deps-'));
    await rm(deps, { recursive: true, force: true });
  });
  const put = async (path, text = '') => {
    const target = join(deps, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  for (const file of ['stage-wasm32/lib/libboost_filesystem.a', 'boost/version.hpp']) await put(`boost-1.84.0/${file}`);
  for (const file of ['include/tbb/tbb.h', 'lib/libtbb.a', 'lib/libtbbmalloc.a']) {
    await put(`oneTBB-3cdc6f6558ba23ec9ceed92078b49dc664ed5bf3/stage-wasm32-pthreads/${file}`);
  }
  for (const variant of ['threaded', 'serial']) {
    for (const file of [`nlopt-2.5.0/stage-wasm32-${variant}/include/nlopt.hpp`,
      `nlopt-2.5.0/stage-wasm32-${variant}/lib/libnlopt.a`, `draco-1.5.7/stage-wasm32-${variant}/lib/libdraco.a`,
      `occt-7.6.0/stage-wasm32-${variant}/include/opencascade/Standard.hxx`,
      `occt-7.6.0/stage-wasm32-${variant}/lib/libTKXDESTEP.a`]) await put(file);
    await put(`occt-7.6.0/stage-wasm32-${variant}/manifest.txt`, 'USE_FREETYPE=OFF\r\n');
  }
  await verifyDependencies(deps);
  for (const variant of ['threaded', 'serial']) {
    const manifest = `occt-7.6.0/stage-wasm32-${variant}/manifest.txt`;
    for (const stale of ['freetype=Emscripten port\n', 'USE_FREETYPE=ON\n']) {
      await put(manifest, stale);
      await assert.rejects(verifyDependencies(deps), new RegExp(`OCCT wasm32 ${variant}.*USE_FREETYPE=OFF`));
    }
    await put(manifest, 'USE_FREETYPE=OFF\n');
  }
  await verifyDependencies(deps);
});

test('refuses to silently lose the wasm32 memory limit when CMake inputs change', () => {
  assert.throws(() => wasm32Source('add_link_options(-m64)', 'CMakeLists.txt'), /scaffold input changed/);
});

test('Web-only wasm32 artifacts share the wasm64 native cache inputs', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = workflow.split(/^  (?=[a-z][\w-]*:)/m);
  const consumers = jobs.filter(job => /name: orca-slice-wasm32-(?:threaded|serial)/.test(job));
  assert.equal(consumers.length, 1);
  assert.match(consumers[0], /^pages-build:/);
  assert.match(consumers[0], /needs: \[wasm_threaded, wasm_serial, wasm32\]/);
  const dependencies = jobs.find(job => job.startsWith('wasm32_deps:'));
  assert.match(dependencies, /path: packages\/slicer-wasm\/\.work\/wasm32\/deps/);
  const nativeDependencies = jobs.find(job => job.startsWith('wasm_deps:'));
  for (const key of ['DEPS_INPUT_HASH', 'WASM_INPUT_HASH']) {
    const expression = (job) => new RegExp(`${key}: (.+)`).exec(job)[1];
    assert.equal(expression(dependencies).replace(", 'scripts/build-wasm32.mjs'", ''), expression(nativeDependencies),
      `${key} must track the authoritative wasm64 inputs plus the wasm32 driver`);
  }
  const builds = jobs.find(job => job.startsWith('wasm32:'));
  assert.match(builds, /variant: \[threaded, serial\]/);
  assert.match(builds, /if: success\(\) && steps.wasm-cache.outputs.cache-hit != 'true'/);
});
