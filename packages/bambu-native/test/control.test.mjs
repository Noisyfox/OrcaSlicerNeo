import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { loadBambuControlStream, readBambuProjectResource } from '../dist/index.js';
const addon = fileURLToPath(new URL('../build/Release/bambu.node', import.meta.url));
const source = fileURLToPath(new URL(`../build/Release/fixture_control.${process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'}`, import.meta.url));
const path = 'Metadata/slice_info.config';
const local = mode => ({ localUrl: `bambu:///local/${mode}`, remoteUrl: null });
const read = (route, options) => readBambuProjectResource(addon, source, route, path, options);
async function pollUntil(stream, predicate) {
  for (let i = 0; i < 100; i++) { const value = stream.poll(); if (predicate(value)) return value; await delay(5); }
  throw new Error('No fixture control response');
}

for (const scheme of ['local', 'tutk', 'agora']) test(`assembles owned file bytes over ${scheme}, excluding parameter metadata and unrelated replies`, async () => {
  const result = await read({ localUrl: `bambu:///${scheme}/fixture`, remoteUrl: null });
  assert.equal(new TextDecoder().decode(result), 'abc');
});

test('prefers local and resolves a remote URL only after local acquisition fails', async () => {
  let calls = 0;
  const remoteUrl = async () => { calls++; return 'bambu:///tutk/fixture'; };
  assert.equal(new TextDecoder().decode(await read({ ...local('fixture'), remoteUrl })), 'abc');
  assert.equal(calls, 0);
  assert.equal(new TextDecoder().decode(await read({ ...local('error'), remoteUrl })), 'abc');
  assert.equal(calls, 1);
  await assert.rejects(read(local('error')), error => error.code === 'transport' && !error.message.includes('passwd'));
});

test('rejects corrupt hashes, offsets, JSON and incomplete declared content', async () => {
  for (const mode of ['checksum', 'offset', 'malformed']) await assert.rejects(read(local(mode)), error => error.code === 'invalid-resource');
  await assert.rejects(read(local('oversize')), error => error.code === 'invalid-resource');
  await assert.rejects(read(local('silent'), { timeoutMs: 20 }), error => error.code === 'transport');
});

test('bounds paths, URL schemes and message size before privileged I/O', async () => {
  for (const resource of ['../secret', 'Metadata/../../secret', 'Metadata/plate_1.gcode', 'Metadata/pick_0.png', 'Metadata/pick_1000.png'])
    await assert.rejects(readBambuProjectResource(addon, source, local('fixture'), resource), error => error.code === 'invalid-resource');
  for (const url of ['https://printer/', 'bambu:///rtsps___printer', 'bambu:///local/x\0secret', 'bambu:///tutk_evil'])
    assert.throws(() => loadBambuControlStream(addon, source, url, 'project-resource'), /Unsupported/);
  const stream = loadBambuControlStream(addon, source, 'bambu:///local/fixture', 'project-resource');
  try { for (const message of ['', 'x'.repeat(65537), 'x\0y']) assert.throws(() => stream.send(message), /Invalid/); }
  finally { await stream.close(); }
});

test('cancellation joins native open asynchronously and never triggers remote fallback', async () => {
  const abort = new AbortController(); let remote = false, tick = false;
  const pending = read({ ...local('slow'), remoteUrl: async () => { remote = true; return 'bambu:///tutk/fixture'; } }, { signal: abort.signal });
  await delay(20); abort.abort();
  const rejected = assert.rejects(pending, error => error.code === 'cancelled');
  setTimeout(() => { tick = true; }, 5);
  await delay(15); assert.equal(tick, true, 'native join must not block JavaScript');
  await rejected; assert.equal(remote, false);
  await assert.rejects(read(local('fixture'), { signal: abort.signal }), error => error.code === 'cancelled');
});

test('remote URL resolution has an independent deadline and abort listener cleanup', async () => {
  const pendingUrl = () => new Promise(() => {});
  const timed = new AbortController();
  await assert.rejects(read({ localUrl: null, remoteUrl: pendingUrl }, { timeoutMs: 10, signal: timed.signal }), error => error.code === 'transport');
  assert.equal(getEventListeners(timed.signal, 'abort').length, 0);
  const abort = new AbortController();
  const pending = read({ localUrl: null, remoteUrl: pendingUrl }, { signal: abort.signal });
  abort.abort(); await assert.rejects(pending, error => error.code === 'cancelled');
});

test('native packet buffers remain owned across reads; close is idempotent', async () => {
  const stream = loadBambuControlStream(addon, source, 'bambu:///local/fixture', 'project-resource');
  try {
    await pollUntil(stream, value => value.ready);
    const message = JSON.stringify({ cmdtype: 4, sequence: 1, req: { path: 'mem:/16' } }) + '\n\n' + JSON.stringify({ command: 'get_project_file', file_rel_path: path });
    stream.send(message);
    const first = (await pollUntil(stream, value => value.messages.length)).messages[0];
    const saved = first.slice();
    stream.send(message); await pollUntil(stream, value => value.messages.length);
    assert.deepEqual(first, saved);
  } finally { const closed = stream.close(); assert.equal(closed, stream.close()); await closed; }
  assert.throws(() => stream.poll(), /closed/);
});

test('backpressures project-resource reads instead of failing an overflowing backlog', async () => {
  const stream = loadBambuControlStream(addon, source, 'bambu:///local/burst', 'project-resource');
  try {
    await delay(60); const first = stream.poll();
    assert.equal(first.messages.length, 2); assert.equal(first.messages[0].length, 1024 * 1024);
    await delay(60); const second = stream.poll(); assert.equal(second.messages.length, 2);
    assert.equal(first.messages[0][0], 120);
  }
  finally { await stream.close(); }
});

test('reads large metadata and images without resource, packet or queue-byte caps', async () => {
  for (const resource of [path, 'Metadata/pick_1.png']) {
    const bytes = await readBambuProjectResource(addon, source, local('project-large'), resource);
    assert.equal(bytes.length, 17 * 1024 * 1024);
    assert.equal(bytes[0], 120); assert.equal(bytes[bytes.length - 1], 120);
  }
});

test('reads more than 4096 project-resource fragments with final integrity validation', async () => {
  const bytes = await read(local('project-many-packets'), { timeoutMs: 20_000 });
  assert.equal(bytes.length, 4097); assert.equal(bytes[0], 120); assert.equal(bytes[4096], 120);
});

test('accepts CTRL JSON headers and parameter metadata above the former 64 KiB cap', async () => {
  assert.equal(new TextDecoder().decode(await read(local('project-headers'))), 'abc');
});
