import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadBambuNative } from '../dist/index.js';
const addon = fileURLToPath(new URL('../build/Release/bambu.node', import.meta.url));
const fixture = fileURLToPath(new URL(`../build/Release/fixture_plugin.${process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'}`, import.meta.url));
const params = { dev_id: 'device', filename: '/private/print.3mf', plate_index: 1, ams_mapping: '[1,2]', slicer_uid: 'neo' };
async function session(work) {
  const dir = await mkdtemp(join(tmpdir(), 'neo-native-print-')); const trace = join(dir, 'trace'); const events = [];
  const agent = loadBambuNative(addon, fixture, event => events.push(event));
  try { await agent.createAgent(trace); await work(agent, events, trace); }
  finally { await agent.close(); await rm(dir, { recursive: true, force: true }); }
}
async function until(predicate) {
  for (let i = 0; i < 200; ++i) { if (predicate()) return; await delay(5); }
  throw new Error('Native callback timed out');
}
test('upload cancellation bypasses call queue; live observations and duplicate admission remain safe', async () => {
  await session(async (agent, events, trace) => {
    const print = agent.startPrint('lan', params);
    await until(() => events.length > 0);
    await assert.rejects(agent.startPrint('lan', params), /busy/);
    assert.equal(await agent.isServerConnected(), true);
    await agent.sendMessageToPrinter('device', '{"pushing":{"command":"pushall"}}', 1, 0);
    assert.equal(agent.cancelPrint(), true);
    assert.deepEqual(await print, { code: -18, mayHaveStarted: false, cancelRequested: true });
    await agent.close();
    const text = await readFile(trace, 'utf8');
    assert(text.includes('print:device:/private/print.3mf:1:[1,2]:neo'));
    assert(text.indexOf('print-cancelled') < text.indexOf('destroy'));
    assert(!JSON.stringify(events).includes('private'));
  });
});
for (const route of ['lan', 'cloud']) test(`${route} dispatch disables send-cancellation and keeps ownership through close`, async () => {
  await session(async (agent, events, trace) => {
    const print = agent.startPrint(route, params);
    await until(() => events.some(e => e.type === 'print-progress' && e.args[2]));
    assert.equal(agent.cancelPrint(), false);
    const closed = agent.close();
    await assert.rejects(agent.startPrint(route, params), /closed/);
    assert.deepEqual(await print, { code: 0, mayHaveStarted: true, cancelRequested: false });
    await closed;
    const text = await readFile(trace, 'utf8');
    assert(text.indexOf('print-published') < text.indexOf('destroy'));
  });
});
test('failure before dispatch and uncertain failure after dispatch are distinct', async () => {
  await session(async agent => {
    assert.deepEqual(await agent.startPrint('lan', { ...params, task_name: 'fail' }), { code: -4010, mayHaveStarted: false, cancelRequested: false });
    assert.deepEqual(await agent.startPrint('lan', { ...params, task_name: 'unknown' }), { code: -4020, mayHaveStarted: true, cancelRequested: false });
    await assert.rejects(agent.startPrint('lan', { ...params, plate_index: 1.5 }), /integer/);
  });
});
