import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadBambuCamera } from '../dist/index.js';
const addon = fileURLToPath(new URL('../build/Release/bambu.node', import.meta.url));
const source = fileURLToPath(new URL(`../build/Release/fixture_camera.${process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'}`, import.meta.url));
async function first(camera) {
  // Native library loading can take seconds on a cold, parallel test run.
  const start = performance.now();
  const deadline = start + 5000;
  for (;;) {
    const result = camera.poll();
    if (result.samples.length) return result;
    const now = performance.now();
    if (now >= deadline) {
      throw new Error(`No fixture samples after ${Math.round(now - start)} ms (ready=${result.ready}, format=${JSON.stringify(result.format)})`);
    }
    await delay(5);
  }
}
test('camera owns borrowed bytes and 100ns timestamps; close is idempotent', async () => {
  const camera = loadBambuCamera(addon, source, 'bambu:///local/fixture');
  try {
    const initial = await first(camera); assert.equal(initial.format, 'jpeg');
    const sample = initial.samples[0], value = sample.bytes[2];
    assert.equal(sample.time100ns, BigInt(value) * 100000n);
    await delay(35); const later = await first(camera);
    assert(later.samples.at(-1).bytes[2] > value); assert.equal(sample.bytes[2], value);
  } finally { const closed = camera.close(); assert.equal(closed, camera.close()); await closed; }
  assert.throws(() => camera.poll(), /closed/);
});
test('camera waits for samples across delayed native startup', async () => {
  const camera = loadBambuCamera(addon, source, 'bambu:///local/delayed');
  try {
    const initial = await first(camera);
    assert.equal(initial.ready, true); assert.equal(initial.format, 'jpeg');
  } finally { await camera.close(); }
});
test('native queue overflow fails explicitly instead of silently losing interdependent samples', async () => {
  const camera = loadBambuCamera(addon, source, 'bambu:///local/burst');
  try { await delay(50); assert.throws(() => camera.poll(), /overflow/); } finally { await camera.close(); }
});
test('connection failure is sanitized and cancellation joins without blocking the JS event loop', async () => {
  const failed = loadBambuCamera(addon, source, 'bambu:///local/error?passwd=secret');
  try { await delay(50); assert.throws(() => failed.poll(), error => error.message === 'Camera connection failed'); } finally { await failed.close(); }
  const slow = loadBambuCamera(addon, source, 'bambu:///local/slow');
  await delay(25); let closed = false; const closing = slow.close().then(() => { closed = true; });
  await delay(10); assert.equal(closed, false, 'Close blocked the JS loop while waiting for native open');
  await closing;
});
test('native camera excludes WAN/TUTK and embedded NUL addresses', () => {
  for (const url of ['bambu:///tutk/example', 'https://printer/', 'bambu:///local/x\0secret']) assert.throws(() => loadBambuCamera(addon, source, url), /Unsupported/);
});
