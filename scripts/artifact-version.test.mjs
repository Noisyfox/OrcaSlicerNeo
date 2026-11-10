import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampWasm, verifyWasm, assertBuildInfo } from './artifact-version.mjs';

test('validates release, core pin and exact WASM artifact bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const info = { neoVersion: '1.0.0-dev', coreRevision: 'a'.repeat(40) };
  const configured = join(directory, 'configured.json');
  await writeFile(configured, JSON.stringify(info));
  for (const extension of ['js', 'wasm', 'data']) await writeFile(join(directory, `orca_slice.${extension}`), extension);
  await stampWasm(directory, configured);
  assert.deepEqual((await verifyWasm(directory, info)).neoVersion, info.neoVersion);
  await assert.rejects(verifyWasm(directory, { ...info, neoVersion: '2.0.0' }), /version mismatch/);
  assert.throws(() => assertBuildInfo({ ...info, coreRevision: 'b'.repeat(40) }, info, 'fixture'), /version mismatch/);
  const before = await readFile(join(directory, 'build-info.json'), 'utf8');
  await stampWasm(directory, configured);
  assert.equal(await readFile(join(directory, 'build-info.json'), 'utf8'), before);
  await writeFile(join(directory, 'orca_slice.wasm'), 'foreign binary');
  await assert.rejects(verifyWasm(directory, info), /does not match its build metadata/);
});
