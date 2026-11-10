import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { manageVersions, readPinnedOrcaVersion, validateVersion } from './version.mjs';

test('validates SemVer including development versions', () => {
  for (const value of ['1.0.0-dev', '1.0.0', '1.2.3-rc.1+build.42']) assert.equal(validateVersion(value), value);
  for (const value of ['v1.0.0', '01.0.0', '1.0.0-01', '1.0.0\n', '1.0', null]) {
    assert.throws(() => validateVersion(value), /Invalid Neo SemVer/);
  }
});

test('synchronizes every workspace and checks drift without writing', t => {
  const root = mkdtempSync(join(tmpdir(), 'neo-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  put('version.json', '{"version":"1.0.0-dev"}\n');
  for (const path of ['package.json', 'apps/desktop/package.json', 'packages/slicer-wasm/package.json']) {
    put(path, '{\n  "name": "fixture",\n  "version": "0.0.0"\n}\n');
  }
  mkdirSync(join(root, 'packages/slicer-wasm/src/client'), { recursive: true });
  const core = join(root, 'packages/slicer-wasm/cpp');
  put('packages/slicer-wasm/cpp/version.inc', 'set(SoftFever_VERSION "2.5.0")\n');
  mkdirSync(join(root, 'empty-hooks'));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['init', '-q', core]);
  git(['-C', core, '-c', 'core.autocrlf=false', 'add', 'version.inc']);
  git(['-C', core, '-c', 'user.name=Version Test', '-c', 'user.email=version@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, 'empty-hooks')}`, 'commit', '-qm', 'Fixture core']);
  const revision = git(['-C', core, 'rev-parse', 'HEAD']);
  git(['update-index', '--add', '--cacheinfo', `160000,${revision},packages/slicer-wasm/cpp`]);
  put('packages/slicer-wasm/cpp/version.inc', 'set(SoftFever_VERSION "3.0.0")\n');
  assert.equal(readPinnedOrcaVersion(root), '2.5.0');
  manageVersions('sync', undefined, root);
  assert.equal(manageVersions('check', undefined, root), '1.0.0-dev');
  const generated = join(root, 'packages/slicer-wasm/src/client/version.ts');
  assert.match(readFileSync(generated, 'utf8'), /ORCA_VERSION = "2\.5\.0"/);
  writeFileSync(generated, readFileSync(generated, 'utf8').replaceAll('\n', '\r\n'));
  assert.equal(manageVersions('check', undefined, root), '1.0.0-dev');
  manageVersions('set', '2.1.0-beta.2', root);
  assert.equal(manageVersions('check', undefined, root), '2.1.0-beta.2');
  const path = join(root, 'apps/desktop/package.json');
  writeFileSync(path, '{"version":"0.0.0"}');
  assert.throws(() => manageVersions('check', undefined, root), /version drift/);
  assert.equal(readFileSync(path, 'utf8'), '{"version":"0.0.0"}');
  assert.throws(() => manageVersions('set', 'bad', root), /Invalid Neo SemVer/);
  assert.equal(JSON.parse(readFileSync(join(root, 'version.json'))).version, '2.1.0-beta.2');
});
