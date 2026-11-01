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

test('rejects corrupt hashes, offsets, JSON and excessive declared sizes', async () => {
  for (const mode of ['checksum', 'offset', 'malformed']) await assert.rejects(read(local(mode)), error => error.code === 'invalid-resource');
  await assert.rejects(read(local('oversize')), error => error.code === 'out-of-range');
  await assert.rejects(read(local('silent'), { timeoutMs: 20 }), error => error.code === 'transport');
});

test('bounds paths, URL schemes and message size before privileged I/O', async () => {
  for (const resource of ['../secret', 'Metadata/../../secret', 'Metadata/plate_1.gcode', 'Metadata/pick_0.png', 'Metadata/pick_1000.png'])
    await assert.rejects(readBambuProjectResource(addon, source, local('fixture'), resource), error => error.code === 'invalid-resource');
  for (const url of ['https://printer/', 'bambu:///rtsps___printer', 'bambu:///local/x\0secret', 'bambu:///tutk_evil'])
    assert.throws(() => loadBambuControlStream(addon, source, url), /Unsupported/);
  const stream = loadBambuControlStream(addon, source, 'bambu:///local/fixture');
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
  const stream = loadBambuControlStream(addon, source, 'bambu:///local/fixture');
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

test('native backlog overflow is explicit and releases the reader', async () => {
  const stream = loadBambuControlStream(addon, source, 'bambu:///local/burst');
  try { await delay(60); assert.throws(() => stream.poll(), /overflow/); }
  finally { await stream.close(); }
});
