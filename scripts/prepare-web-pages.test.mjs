import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const variants = ['threaded', 'serial', 'wasm32/threaded', 'wasm32/serial'];
const runtimeFiles = variants.flatMap(variant => ['js', 'wasm', 'data'].map(ext => `${variant}/orca_slice.${ext}`));
const script = fileURLToPath(new URL('./prepare-web-pages.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'orca-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, bytes = name) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), bytes);
  };
  await put('index.html');
  await put('profiles/manifest.json');
  for (const file of runtimeFiles) await put(`wasm/${file}`, file.endsWith('.data') ? '' : file);
  return { root, put, run: () => spawnSync(process.execPath, [script, root], { encoding: 'utf8' }) };
}

test('Pages preserves all four runtime variants and removes debug assets at every depth', async t => {
  const { root, put, run } = await fixture(t);
  const extras = ['package.json', 'orca_slice.js', 'profile-threaded/debug.wasm',
    'wasm32/debug.wasm', 'wasm32/profile-serial/orca_slice.wasm',
    ...variants.flatMap(variant => [`${variant}/orca_slice.wasm.map`, `${variant}/debug/trace.json`])];
  for (const file of extras) await put(`wasm/${file}`);
  await put('profiles/vendor.zip', 'profile bytes');
  const result = run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual((await readdir(join(root, 'wasm'), { recursive: true })).sort(),
    [...runtimeFiles, 'threaded', 'serial', 'wasm32', 'wasm32/threaded', 'wasm32/serial'].sort());
  for (const file of runtimeFiles) {
    assert.equal(await readFile(join(root, 'wasm', file), 'utf8'), file.endsWith('.data') ? '' : file);
  }
  assert.equal(await readFile(join(root, 'profiles/vendor.zip'), 'utf8'), 'profile bytes');
  assert.equal(await readFile(join(root, '.nojekyll'), 'utf8'), '');
});

test('Pages rejects an incomplete runtime set before pruning assets', async t => {
  for (const file of runtimeFiles) {
    await t.test(file, async t => {
      const { root, put, run } = await fixture(t);
      await rm(join(root, 'wasm', file));
      await put('wasm/debug/keep-until-validated.txt');
      const result = run();
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(file), result.stderr);
      assert.equal(await readFile(join(root, 'wasm/debug/keep-until-validated.txt'), 'utf8'),
        'wasm/debug/keep-until-validated.txt');
    });
  }
});
