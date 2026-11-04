import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings, verifyStage } from './build.mjs';

test('numerical stages distinguish address width and threading', () => {
  const serial = settings(['build', '--target', 'wasm32', '--variant', 'serial'], { WORK_DIR: '/tmp/numbers' });
  const threaded = settings(['build', '--target', 'wasm64', '--variant', 'threaded'], { WORK_DIR: '/tmp/numbers' });
  assert.equal(serial.width, 32);
  assert.equal(serial.threaded, false);
  assert.notEqual(serial.stage, threaded.stage);
  for (const args of [['build', '--target', 'wasm16'], ['build', '--variant', 'typo'], ['build', '--stage']]) {
    assert.throws(() => settings(args), /Invalid option|Missing value/);
  }
});

test('cache verification rejects incompatible, incomplete and corrupted stages', async t => {
  const stage = await mkdtemp(join(tmpdir(), 'orca-numerical-stage-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const identity = { width: 64, threaded: false, compiler: 'compiler-1', recipe: 'recipe-1' };
  const files = {};
  const bytes = 'verified fixture';
  const hash = createHash('sha256').update(bytes).digest('hex');
  for (const name of ['lib/libgmp.a', 'lib/libgmpxx.a', 'lib/libmpfr.a', 'include/gmp.h',
    'include/gmpxx.h', 'include/mpfr.h', 'include/mpf2mpfr.h', 'include/CGAL/version.h',
    'include/CGAL/CORE/Expr.h', 'include/CGAL/FPU.h']) {
    await mkdir(dirname(join(stage, name)), { recursive: true });
    await writeFile(join(stage, name), bytes);
    files[name] = hash;
  }
  const manifest = { identity, files };
  const save = () => writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest));
  await save();
  await verifyStage({ stage }, identity);
  for (const changed of [{ width: 32 }, { threaded: true }, { compiler: 'compiler-2' }, { recipe: 'recipe-2' }]) {
    await assert.rejects(verifyStage({ stage }, { ...identity, ...changed }), /configuration changed/);
  }
  delete files['lib/libmpfr.a']; await save();
  await assert.rejects(verifyStage({ stage }, identity), /inventory missing/);
  files['lib/libmpfr.a'] = hash; await save();
  await writeFile(join(stage, 'lib/libmpfr.a'), 'different library');
  await assert.rejects(verifyStage({ stage }, identity), /file changed/);
});

test('the CLI also executes through the wasm32 scaffold directory link', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-numerical-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const link = join(directory, 'recipe');
  await symlink(fileURLToPath(new URL('.', import.meta.url)), link, process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, [join(link, 'build.mjs'), 'invalid-command'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected build, verify or fetch/);
});
