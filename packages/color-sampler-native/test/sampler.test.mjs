import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createNativeScreenColorSampler, loadNativeScreenColorSampler } from '../dist/index.js';

const require = createRequire(import.meta.url);
const fixture = require('../build/Release/screen_color_fixture.node');
const signal = () => new AbortController().signal;

test('production addon loads without opening native UI and contains no fixture entrypoint', async () => {
  const path = resolve('build/Release/screen_color.node');
  const binding = require(path);
  assert.equal(binding.apiVersion, 1);
  assert.equal(typeof binding.available, 'boolean');
  assert.equal(binding.completeFixture, undefined);
  assert.ok(!(await readFile(path)).includes(Buffer.from('completeFixture')));
  const sampler = loadNativeScreenColorSampler(path);
  assert.ok(sampler);
  const request = new AbortController(); request.abort();
  assert.deepEqual(await sampler.pick(request.signal), { status: 'cancelled' });
  sampler.close();
});

test('missing, relative and incompatible addons are unavailable', () => {
  assert.equal(loadNativeScreenColorSampler('relative.node'), null);
  assert.equal(loadNativeScreenColorSampler('/missing/screen_color.node'), null);
  assert.throws(() => createNativeScreenColorSampler({ apiVersion: 0 }));
});

test('real Node-API bridge returns color, cancellation and failure exactly once', async () => {
  const sampler = createNativeScreenColorSampler(fixture);
  for (const status of ['picked', 'cancelled', 'failed']) {
    const done = sampler.pick(signal());
    fixture.completeFixture(status);
    assert.deepEqual(await done, status === 'picked' ? { status, color: '#12ABEF' } : { status });
  }
  assert.throws(() => fixture.start(0, () => {}));
  assert.throws(() => fixture.start('1', () => {}));
  sampler.close();
});

test('native cancellation ignores stale callbacks and permits the next request', async () => {
  const sampler = createNativeScreenColorSampler(fixture);
  const request = new AbortController();
  const pending = sampler.pick(request.signal);
  assert.deepEqual(await sampler.pick(signal()), { status: 'failed' });
  request.abort();
  fixture.completeFixture('picked');
  assert.deepEqual(await pending, { status: 'cancelled' });
  const next = sampler.pick(signal()); fixture.completeFixture('picked');
  assert.deepEqual(await next, { status: 'picked', color: '#12ABEF' });
  const closing = sampler.pick(signal()); sampler.close();
  assert.deepEqual(await closing, { status: 'cancelled' });
  assert.deepEqual(await sampler.pick(signal()), { status: 'cancelled' });
});

test('wrapper validates results and closes even if native cancellation throws', async () => {
  let callback;
  const sampler = createNativeScreenColorSampler({ apiVersion: 1, available: true,
    start(_id, done) { callback = done; return true; }, cancel() { throw new Error('cancel failed'); } });
  const pending = sampler.pick(signal()); callback({ status: 'picked', color: '#abc' });
  assert.deepEqual(await pending, { status: 'failed' });
  const next = sampler.pick(signal()); sampler.close();
  callback({ status: 'picked', color: '#ABCDEF' });
  assert.deepEqual(await next, { status: 'cancelled' });
});


test('environment teardown safely drains queued callbacks and cancels abandoned requests', () => {
  for (const complete of [false, true]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      const binding = createRequire(import.meta.url)('./build/Release/screen_color_fixture.node');
      binding.start(1, () => {});
      ${complete ? "binding.completeFixture('picked');" : ''}
      process.exit(0);
    `], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
  }
});


test('real Linux backend speaks PickColor, cancels requests and handles portal loss', { skip: process.platform !== 'linux' }, () => {
  const result = spawnSync(resolve('build/Release/portal_test'), [], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});


test('runtime staging excludes fixture binaries and rejects a mismatched packaging target', async () => {
  const { stageRuntime, prepareRuntime } = await import('../scripts/stage.mjs');
  await stageRuntime();
  assert.deepEqual(await readdir(new URL('../out/runtime/', import.meta.url)), ['screen_color.node']);
  await assert.rejects(prepareRuntime('wrong-platform'), /matching native runner/);
});


test('completion is delivered even when it is the only live Node handle', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    const binding = createRequire(import.meta.url)('./build/Release/screen_color_fixture.node');
    binding.start(1, result => console.log(result.status));
    binding.completeFixture('picked');
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'picked');
});
