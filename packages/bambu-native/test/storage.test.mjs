import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { loadBambuControlStream, readBambuStorageFile, discoverBambuStorage, listBambuStorageFiles, deleteBambuStorageFile } from '../dist/index.js';

const addon = fileURLToPath(new URL('../build/Release/bambu.node', import.meta.url));
const source = fileURLToPath(new URL(`../build/Release/fixture_control.${process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'}`, import.meta.url));
const options = { connectTimeoutMs: 5000, inactivityTimeoutMs: 1000 };
const read = (mode, extra = {}) => readBambuStorageFile(addon, source, `bambu:///local/${mode}`, { path: '/storage-file' }, { ...options, ...extra });
async function collect(value) {
  const chunks = [];
  for await (const chunk of value.chunks) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('streams owned file chunks and verifies terminal MD5 without file-sized buffering', async () => {
  const value = await read('fixture');
  assert.equal(value.totalBytes, 3);
  const iterator = value.chunks[Symbol.asyncIterator]();
  const first = (await iterator.next()).value;
  assert.equal(Buffer.from(first).toString(), 'a');
  assert.equal(Buffer.from((await iterator.next()).value).toString(), 'bc');
  assert.equal((await iterator.next()).done, true);
  assert.equal(Buffer.from(first).toString(), 'a');
  assert.throws(() => value.chunks[Symbol.asyncIterator](), /already owned/);
});

test('accepts a validated zero-byte file and rejects terminal integrity/offset errors', async () => {
  const empty = await read('empty'); assert.equal(empty.totalBytes, 0); assert.equal(await collect(empty), '');
  for (const mode of ['checksum', 'offset']) await assert.rejects(collect(await read(mode)), error => error.code === 'invalid-response');
  await assert.rejects(read('rejected'), error => error.code === 'device-rejected' && error.result === 10);
});

test('consumer pauses do not count as printer inactivity; abort closes an unread iterator', async () => {
  const signal = new AbortController();
  const value = await read('fixture', { signal: signal.signal, inactivityTimeoutMs: 10 });
  await delay(40);
  assert.equal(await collect(value), 'abc');
  assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
  const second = await read('fixture', { signal: signal.signal });
  assert.equal(getEventListeners(signal.signal, 'abort').length, 1);
  signal.abort(); assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
  await assert.rejects(second.chunks[Symbol.asyncIterator]().next(), error => error.code === 'cancelled');
});

test('return before the first consumer pull releases the primed native reader', async () => {
  const signal = new AbortController();
  const value = await read('fixture', { signal: signal.signal });
  const iterator = value.chunks[Symbol.asyncIterator]();
  assert.equal((await iterator.return()).done, true);
  assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
  assert.equal((await iterator.next()).done, true);
});

test('timeouts and cancellation join a silent source, without credential leaks', async () => {
  await assert.rejects(read('silent?passwd=secret', { inactivityTimeoutMs: 15 }), error => error.code === 'transport' && !error.message.includes('secret'));
  const abort = new AbortController();
  const pending = read('silent', { signal: abort.signal });
  await delay(15); abort.abort();
  await assert.rejects(pending, error => error.code === 'cancelled');
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('bounds the storage native backlog while leaving resource overflow behavior separate', async () => {
  const stream = loadBambuControlStream(addon, source, 'bambu:///local/burst', 'storage');
  try {
    await delay(50); const first = stream.poll();
    assert.equal(first.messages.length, 2); assert.equal(first.messages[0].length, 1024 * 1024);
    await delay(50); const second = stream.poll(); assert.equal(second.messages.length, 2);
    assert.equal(first.messages[0][0], 'x'.charCodeAt(0));
  } finally { await stream.close(); }
});

test('rejects non-LAN storage and invalid paths before creating native sessions', async () => {
  for (const path of ['../secret', 'mem:/16', 'bad\0path'])
    await assert.rejects(readBambuStorageFile(addon, source, 'bambu:///local/fixture', { path }, options), error => error.code === 'invalid-response');
  await assert.rejects(readBambuStorageFile(addon, source, 'bambu:///tutk/fixture', { path: '/storage-file' }, options), /authorized LAN/);
});

test('sustained storage progress survives the old twenty-second resource deadline', { timeout: 30000 }, async () => {
  const start = performance.now();
  assert.equal(await collect(await read('long-progress', { inactivityTimeoutMs: 3000 })), 'a'.repeat(22));
  assert.ok(performance.now() - start >= 20_000);
});

const queryOptions = { ...options, requestTimeoutMs: 5000 };
const list = (mode, maxEntries = 2000, collection = 'model') => listBambuStorageFiles(addon, source,
  `bambu:///local/${mode}`, { storage: 'sdcard', collection, maxEntries }, queryOptions);

test('discovers storage explicitly and assembles deterministic multipart file listings', async () => {
  assert.deepEqual(await discoverBambuStorage(addon, source, 'bambu:///local/fixture', queryOptions), ['sdcard', 'internal']);
  assert.deepEqual(await list('fixture'), [
    { name: 'a.3mf', path: '/a.3mf', sizeBytes: 4, modifiedAtSeconds: 10 },
    { name: 'b.3mf', path: '/b.3mf', sizeBytes: 3, modifiedAtSeconds: 10 },
  ]);
  assert.equal((await list('largeheader')).length, 1000);
});

test('rejects inconsistent/oversized listings and legacy wrong-type responses', async () => {
  for (const mode of ['duplicate', 'legacy', 'continued-empty']) await assert.rejects(list(mode), error => error.code === 'invalid-response');
  await assert.rejects(list('fixture', 1), error => error.code === 'invalid-response');
  assert.equal((await list('legacy', 2000, 'timelapse'))[0].path, '');
});

test('single-file deletion distinguishes acknowledgment, rejection and uncertain response', async () => {
  const remove = mode => deleteBambuStorageFile(addon, source, `bambu:///local/${mode}`, { path: '/storage-file' }, queryOptions);
  await remove('fixture');
  await assert.rejects(remove('rejected'), error => error.code === 'device-rejected' && error.result === 10);
  await assert.rejects(remove('uncertain'), error => error.code === 'invalid-response');
  await assert.rejects(deleteBambuStorageFile(addon, source, 'bambu:///local/silent', { path: '/storage-file' },
    { ...queryOptions, requestTimeoutMs: 30 }), error => error.code === 'transport');
});
