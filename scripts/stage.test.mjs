import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { manageVersions, readBuildInfo } from './version.mjs';
import { stampWasm } from './artifact-version.mjs';

test('Electron stages threaded alone, removes stale fallbacks, and Web adds its own fallbacks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-stage-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const put = async (path, bytes = '') => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  };
  for (const path of ['scripts/stage.mjs', 'scripts/stage-web.mjs', 'scripts/validate-wasm.mjs', 'scripts/version.mjs', 'scripts/artifact-version.mjs',
    'packages/slicer-app/scripts/stage-handy-models.mjs']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(new URL(`../${path}`, import.meta.url), join(root, path));
  }
  await put('packages/slicer-app/resources/handy-models.json', '[]');
  await mkdir(join(root, 'packages/slicer-wasm/cpp/resources/handy_models'), { recursive: true });
  const buildInfo = readBuildInfo();
  await put('version.json', JSON.stringify({ version: buildInfo.neoVersion }));
  for (const path of ['package.json', 'apps/desktop/package.json', 'apps/web/package.json',
    'packages/slicer-app/package.json', 'packages/slicer-wasm/package.json', 'packages/profile-resources/package.json']) {
    await put(path, '{"version":"0.0.0"}');
  }
  await mkdir(join(root, 'packages/slicer-wasm/src/client'), { recursive: true });
  manageVersions('sync', undefined, root);
  for (const args of [['init'], ['update-index', '--add', '--cacheinfo', `160000,${buildInfo.coreRevision},packages/slicer-wasm/cpp`]]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  await put('packages/profile-resources/dist/manifest.json', JSON.stringify({ version: 1, buildInfo, packages: [] }));
  await put('configured-info.json', JSON.stringify(buildInfo));
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const artifact = async (variant) => {
    for (const extension of ['js', 'wasm', 'data']) {
      await put(`packages/slicer-wasm/out/${variant}/orca_slice.${extension}`, extension === 'wasm' ? wasm : variant);
    }
    await stampWasm(join(root, `packages/slicer-wasm/out/${variant}`), join(root, 'configured-info.json'));
  };
  const run = (name) => {
    const result = spawnSync(process.execPath, [`scripts/${name}.mjs`], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  };
  const desktop = 'apps/desktop/src/renderer/public/wasm';
  await put(`${desktop}/serial/stale.wasm`);
  await put(`${desktop}/wasm32/serial/stale.wasm`);
  await artifact('threaded');
  run('stage'); // No serial build exists: Electron must not require one.
  assert.deepEqual((await readdir(join(root, desktop))).sort(), ['package.json', 'threaded']);
  for (const variant of ['serial', 'wasm32/threaded', 'wasm32/serial']) await artifact(variant);
  run('stage-web');
  for (const variant of ['threaded', 'serial', 'wasm32/threaded', 'wasm32/serial']) {
    for (const extension of ['js', 'wasm', 'data']) {
      const file = `orca_slice.${extension}`;
      assert.deepEqual(await readFile(join(root, `apps/web/.generated/public/wasm/${variant}/${file}`)),
        await readFile(join(root, `packages/slicer-wasm/out/${variant}/${file}`)));
    }
  }
  assert.deepEqual((await readdir(join(root, desktop))).sort(), ['package.json', 'threaded']);
  await put('packages/slicer-wasm/out/threaded/orca_slice.data', 'foreign artifact');
  const corrupted = spawnSync(process.execPath, ['scripts/stage.mjs'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(corrupted.status, 0);
  assert.match(corrupted.stderr, /does not match its build metadata/);
});
