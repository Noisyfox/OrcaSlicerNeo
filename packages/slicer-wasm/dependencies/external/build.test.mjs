import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configureArgs, recipes, settings, verifyStage } from './build.mjs';

test('external stages separate every library, address width and threading mode', () => {
  const stages = new Set();
  for (const library of Object.keys(recipes)) for (const target of ['wasm32', 'wasm64']) for (const variant of ['serial', 'threaded']) {
    const options = settings(['build', '--library', library, '--target', target, '--variant', variant], { WORK_DIR: '/tmp/external' });
    stages.add(options.stage);
    assert.equal(options.width, Number(target.slice(4)));
    assert.equal(options.threaded, variant === 'threaded');
    if (library === 'occt') {
      assert.ok(configureArgs(options).includes('-DUSE_FREETYPE=OFF'));
      assert.ok(configureArgs(options).includes('-DBUILD_ADDITIONAL_TOOLKITS=TKDESTEP'));
      assert.ok(configureArgs(options).includes('-DBUILD_RELEASE_DISABLE_EXCEPTIONS=ON'));
    } else if (library === 'expat') {
      assert.ok(configureArgs(options).includes('-DXML_DEV_URANDOM=ON'));
      assert.ok(configureArgs(options).includes('-DXML_NS=ON'));
    }
  }
  assert.equal(stages.size, 12);
  for (const args of [[], ['build', '--library', 'wrong'], ['build', '--library', 'occt', '--target', 'wasm16']]) {
    assert.throws(() => settings(args));
  }
});

test('external verification rejects stale identities and damaged or incomplete archives', async t => {
  const stage = await mkdtemp(join(tmpdir(), 'orca-external-stage-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const identity = { version: '8.0.2', width: 64, threaded: true, compiler: 'compiler-1', recipe: 'recipe-1' };
  const files = {};
  for (const name of recipes.qhull.files) {
    await mkdir(dirname(join(stage, name)), { recursive: true });
    await writeFile(join(stage, name), 'fixture');
    files[name] = createHash('sha256').update('fixture').digest('hex');
  }
  await writeFile(join(stage, 'manifest.json'), JSON.stringify({ identity, files }));
  const options = { library: 'qhull', stage };
  await verifyStage(options, identity);
  for (const change of [{ version: '7.2.0' }, { width: 32 }, { threaded: false }, { compiler: 'compiler-2' }, { recipe: 'recipe-2' }]) {
    await assert.rejects(verifyStage(options, { ...identity, ...change }), /configuration changed/);
  }
  await writeFile(join(stage, 'lib/libqhullcpp.a'), 'damaged');
  await assert.rejects(verifyStage(options, identity), /file changed or missing/);
  delete files['lib/libqhullcpp.a'];
  await writeFile(join(stage, 'manifest.json'), JSON.stringify({ identity, files }));
  await assert.rejects(verifyStage(options, identity), /file changed or missing/);
});
