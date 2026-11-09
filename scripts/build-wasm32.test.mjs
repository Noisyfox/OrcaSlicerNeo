import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { verifyDependencies, wasm32Source } from './build-wasm32.mjs';
import { recipes as externalRecipes } from '../packages/slicer-wasm/dependencies/external/build.mjs';

const native = new URL('../packages/slicer-wasm/', import.meta.url);
test('wasm32 scaffold targets 32-bit code, separate dependency prefixes and a 4 GiB limit', async () => {
  for (const name of ['CMakeLists.txt', 'build.sh', 'build.bat', 'build-boost-wasm64.sh', 'build-occt-wasm64.sh', 'build-occt-wasm64.bat', 'build-onetbb.sh']) {
    const source = await readFile(new URL(name, native), 'utf8');
    const output = wasm32Source(source, name);
    assert.doesNotMatch(output, /-m64|stage-wasm64|address-model=64|CMAKE_SIZEOF_VOID_P:INTERNAL=8/);
    if (source.includes('-m64')) assert.match(output, /-m32/);
    if (name === 'CMakeLists.txt') assert.match(output, /-sMAXIMUM_MEMORY=4GB/);
    if (name.startsWith('build-occt-')) assert.match(output, /--target wasm32/);
    assert.doesNotMatch(output, /-sUSE_FREETYPE=1|libfreetype\.a|freetype-port-probe/);

    if (name.endsWith('.bat')) assert.doesNotMatch(output, /(?<!\r)\n/);
    assert.equal(await readFile(new URL(name, native), 'utf8'), source, 'authoritative wasm64 input was not changed');
  }
});

test('cached wasm32 dependencies require correct external versions, widths and threading', async (t) => {
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
      `occt-8.0.1/stage-wasm32-${variant}/include/opencascade/Standard.hxx`,
      `occt-8.0.1/stage-wasm32-${variant}/lib/libTKDESTEP.a`]) await put(file);
    for (const file of ['include/CGAL/CORE/Expr.h', 'include/gmpxx.h', 'include/mpfr.h',
      'lib/libgmp.a', 'lib/libgmpxx.a', 'lib/libmpfr.a']) await put(`cgal-6.2.1/stage-wasm32-${variant}/${file}`);
    await put(`cgal-6.2.1/stage-wasm32-${variant}/manifest.json`, JSON.stringify({ identity: { width: 32, threaded: variant === 'threaded' } }));
    for (const recipe of Object.values(externalRecipes)) {
      const stage = `${recipe.name}-${recipe.version}/stage-wasm32-${variant}`;
      for (const file of recipe.files) await put(`${stage}/${file}`);
      await put(`${stage}/manifest.json`, JSON.stringify({ identity: { version: recipe.version, width: 32,
        threaded: variant === 'threaded', ...(recipe.name === 'occt' ? { freetype: false } : {}) } }));
    }
  }
  await verifyDependencies(deps);
  for (const variant of ['threaded', 'serial']) {
    const manifest = `occt-8.0.1/stage-wasm32-${variant}/manifest.json`;
    const identity = { version: '8.0.1', width: 32, threaded: variant === 'threaded', freetype: false };
    for (const change of [{ freetype: true }, { width: 64 }, { version: '7.6.0' }, { threaded: variant !== 'threaded' }]) {
      await put(manifest, JSON.stringify({ identity: { ...identity, ...change } }));
      await assert.rejects(verifyDependencies(deps), new RegExp(`occt wasm32 ${variant}.*configuration mismatch`));
    }
    await put(manifest, JSON.stringify({ identity }));
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
