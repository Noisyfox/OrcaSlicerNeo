import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { wasm32Source } from './build-wasm32.mjs';

const native = new URL('../packages/slicer-wasm/', import.meta.url);
test('wasm32 scaffold targets 32-bit code, separate dependency prefixes and a 2 GiB limit', async () => {
  for (const name of ['CMakeLists.txt', 'build.sh', 'build.bat', 'build-boost-wasm64.sh', 'build-occt-wasm64.sh', 'build-onetbb.sh']) {
    const source = await readFile(new URL(name, native), 'utf8');
    const output = wasm32Source(source, name);
    assert.doesNotMatch(output, /-m64|stage-wasm64|address-model=64|CMAKE_SIZEOF_VOID_P:INTERNAL=8/);
    if (source.includes('-m64')) assert.match(output, /-m32/);
    if (name === 'CMakeLists.txt') assert.match(output, /-sMAXIMUM_MEMORY=2GB/);
    if (name === 'build-occt-wasm64.sh') assert.match(output, /CMAKE_SIZEOF_VOID_P:INTERNAL=4/);
    if (name.endsWith('.bat')) assert.doesNotMatch(output, /(?<!\r)\n/);
    assert.equal(await readFile(new URL(name, native), 'utf8'), source, 'authoritative wasm64 input was not changed');
  }
});

test('refuses to silently lose the wasm32 memory limit when CMake inputs change', () => {
  assert.throws(() => wasm32Source('add_link_options(-m64)', 'CMakeLists.txt'), /scaffold input changed/);
});

test('only the Web artifact consumer downloads the wasm32 fallback', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = workflow.split(/^  (?=[a-z][\w-]*:)/m);
  const consumers = jobs.filter(job => /name: orca-slice-wasm32-(?:threaded|serial)/.test(job));
  assert.equal(consumers.length, 1);
  assert.match(consumers[0], /^pages-build:/);
  assert.match(consumers[0], /needs: \[wasm_threaded, wasm_serial, wasm32\]/);
  const dependencies = jobs.find(job => job.startsWith('wasm32_deps:'));
  assert.match(dependencies, /path: packages\/slicer-wasm\/\.work\/wasm32\/deps/);
  const builds = jobs.find(job => job.startsWith('wasm32:'));
  assert.match(builds, /variant: \[threaded, serial\]/);
  assert.match(builds, /if: success\(\) && steps.wasm-cache.outputs.cache-hit != 'true'/);
});
