import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { readBambuStorageResource, readBambuStorageResources, openBambuStorageResourceReader, loadBambuControlStream, readBambuStorageFile, discoverBambuStorage, listBambuStorageFiles, deleteBambuStorageFile } from '../dist/index.js';

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

test('backpressures the storage native backlog without rejecting incoming content', async () => {
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

test('translates discovered storage IDs to Orca LIST_INFO selectors used by H2D', async () => {
  for (const storage of ['external', 'udisk', 'sdcard', 'emmc', 'internal']) {
    const mode = storage === 'external' || storage === 'udisk' || storage === 'sdcard' ? 'selector-external' : 'selector-internal';
    const files = await listBambuStorageFiles(addon, source, `bambu:///local/${mode}`,
      { storage, collection: 'model', maxEntries: 100 }, queryOptions);
    assert.equal(files.length, 2);
  }
});

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


test('reads optional storage resources and preserves unavailable thumbnails', async () => {
  const request = { path: '/resource.3mf', resource: '_rels/.rels' };
  const resource = (mode, changes = {}) => readBambuStorageResource(addon, source, `bambu:///local/${mode}`, { ...request, ...changes }, options);
  assert.equal(Buffer.from(await resource('fixture')).toString(), 'abc');
  assert.equal(await resource('empty'), null);
  await assert.rejects(resource('mismatch'), error => error.code === 'invalid-response');
  for (const [mode, length] of [['resource-large', 17 * 1024 * 1024], ['resource-many-packets', 4097 * 4097]]) {
    const value = await resource(mode);
    assert.equal(value.byteLength, length);
    assert.equal(value[0], 120); assert.equal(value[length - 1], 120);
  }
  await assert.rejects(resource('fixture', { resource: '../outside' }), error => error.code === 'invalid-response');
  const controller = new AbortController();
  const pending = readBambuStorageResource(addon, source, 'bambu:///local/silent', request, { ...options, signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.code === 'cancelled'); controller.abort(); await rejected;
});

test('assembles interleaved SUB_FILE batches by exact resource path and rejects incomplete batches', async () => {
  const requests = ['_rels/.rels', 'thumbnail'].map(resource => ({ path: '/resource.3mf', resource }));
  const read = (mode, input = requests) => readBambuStorageResources(addon, source, `bambu:///local/${mode}`, input, options);
  assert.deepEqual((await read('resource-batch')).map(value => Buffer.from(value).toString()), ['abc', 'xyz']);
  await assert.rejects(read('resource-batch-missing'), error => error.code === 'invalid-response');
  await assert.rejects(read('resource-batch', [...requests, requests[0]]), error => error.code === 'invalid-response');
  await assert.rejects(read('resource-batch', []), error => error.code === 'invalid-response');
});

test('keeps successful thumbnails across a terminal missing-file response and reuses request sequences', async () => {
  const reader = await openBambuStorageResourceReader(addon, source, 'bambu:///local/resource-reuse', options);
  const file = name => ({ path: `/${name}.3mf`, resource: 'thumbnail' });
  try {
    assert.deepEqual((await reader.read(['one', 'missing', 'two'].map(file))).map(value => value && Buffer.from(value).toString()), ['a', null, 'b']);
    assert.equal(Buffer.from((await reader.read([file('one')]))[0]).toString(), 'a');
  } finally { await reader.close(); }
});
