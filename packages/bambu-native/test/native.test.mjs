import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { loadBambuNative } from '../dist/index.js';
const addon = fileURLToPath(new URL('../build/Release/bambu.node', import.meta.url));
const fixture = fileURLToPath(new URL(`../build/Release/fixture_plugin.${process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'}`, import.meta.url));

async function session(work) {
  const directory = await mkdtemp(join(tmpdir(), 'neo-bambu-native-'));
  const trace = join(directory, 'trace'); const events = [];
  const agent = loadBambuNative(addon, fixture, event => events.push(event));
  try { await work(agent, trace, events); } finally { await agent.close(); await rm(directory, { recursive: true, force: true }); }
}

test('copies strings and HTTP output parameters, and serializes submitted calls', async () => {
  await session(async (agent, trace) => {
    assert.equal(await agent.getVersion(), 'fixture-1');
    await agent.createAgent(trace);
    await Promise.all([agent.setConfigDirectory('/configuration/路径'), agent.initLog(), agent.setCertificate('/cert', 'root.cer')]);
    const payload = '登录\u0000opaque-payload';
    assert.equal(await agent.changeUser(payload), 0);
    assert.equal(await agent.isUserLoggedIn(), true);
    assert.equal(await agent.getUserId(), payload);
    assert.equal(await agent.getUserName(), '账户名');
    assert.equal(await agent.getCameraUrl('fixture-device'), 'bambu:///local/fixture?port=6000&user=bblp&passwd=fixture');
    assert.deepEqual(await agent.getMyToken('ticket-值'), { result: -19, httpCode: 201, body: 'ticket-值' });
    assert.deepEqual(await agent.getUserPrintInfo(), { result: 0, httpCode: 200, body: '{"devices":[]}' });
    assert.deepEqual(await agent.getSubtaskInfo('task-值'), { result: 0, httpCode: 200, body: 'task-值' });
    assert.deepEqual(await agent.getMyProfile('opaque'), { result: 0, httpCode: 200, body: 'opaque' });
    assert.equal(await agent.startDiscovery(true, false), true);
    await agent.connectPrinter('id', '192.0.2.1', 'bblp', 'fixture-code', true);
    await agent.setSelectedMachine('id'); assert.equal(await agent.getSelectedMachine(), 'id');
    await agent.setExtraHttpHeaders({ source: 'fixture', version: '1' });
    await agent.trackEnable(false); await agent.trackRemoveFiles();
    await agent.close(); await agent.close();
    const lines = (await readFile(trace, 'utf8')).trim().split('\n');
    assert.deepEqual(lines.slice(0, 4), ['create', 'config:/configuration/路径', 'init-log', 'cert:/cert/root.cer']);
    assert(lines.includes('discovery:true:false'));
    assert(lines.includes('connect:id:192.0.2.1:bblp:fixture-code:true'));
    assert(lines.includes('headers:2')); assert(lines.includes('track:false'));
    assert.equal(lines.at(-1), 'destroy');
    assert(lines.indexOf('discovery:false:false') < lines.indexOf('disconnect'));
    assert(lines.indexOf('disconnect') < lines.indexOf('destroy'));
    assert(!lines.some(line => line.startsWith('logout:')), 'Normal close must preserve remembered login');
    await assert.rejects(agent.getVersion(), /closed/);
  });
});

test('delivers plugin-thread callbacks and drains native main-queue work before destruction', async () => {
  await session(async (agent, trace, events) => {
    await agent.createAgent(trace); await agent.installCallbacks(); await agent.installDiscoveryCallbacks(); await agent.setCountryCode('CN');
    await agent.start(); await agent.close();
    assert.deepEqual(events.map(event => event.type), ['ssdp', 'server-connected', 'local-connect', 'http-error']);
    assert.deepEqual(events[2], { type: 'local-connect', args: [0, 'fixture-device', 'connected'] });
    assert.deepEqual(events[3], { type: 'http-error', args: [401, 'fixture-body'] });
    const lines = (await readFile(trace, 'utf8')).trim().split('\n');
    assert(lines.includes('country:CN'));
    assert(lines.indexOf('queued-on-main') < lines.indexOf('destroy'));
    assert.equal(lines.filter(line => line.startsWith('clear:')).length, 12);
  });
});

test('keeps explicit logout separate from disposal and preserves its request flag', async () => {
  await session(async (agent, trace) => {
    await agent.createAgent(trace); await agent.changeUser('user'); await agent.logout(true);
    assert.equal(await agent.isUserLoggedIn(), false);
    await agent.close();
    assert((await readFile(trace, 'utf8')).includes('logout:true\n'));
  });
});

test('rejects malformed arguments without poisoning subsequent calls or echoing secrets', async () => {
  await session(async (agent, trace) => {
    await agent.createAgent(trace);
    await assert.rejects(agent.changeUser(123), /Invalid native argument/);
    await assert.rejects(agent.setExtraHttpHeaders({ token: 123 }), /Header values/);
    assert.equal(await agent.isUserLoggedIn(), false);
  });
  const binding = createRequire(import.meta.url)(addon);
  assert.throws(() => new binding.Agent('/not/a/plugin', () => {}), /Unable to load/);
  assert.throws(() => new binding.Agent(addon, () => {}), /Missing plugin export/);
  assert.throws(() => loadBambuNative('relative.node', fixture, () => {}), /absolute/);
});

test('copies LAN bootstrap arguments and rejects non-integer QoS without leaking payloads', async () => {
  await session(async (agent, trace) => {
    await agent.createAgent(trace);
    await agent.sendMessageToPrinter('device', '{"info":{"command":"get_version"}}', 1, 0);
    await agent.installDeviceCertificate('device', true);
    await assert.rejects(agent.sendMessageToPrinter('device', 'private', 0.5, 0), /integer argument/);
    await agent.close();
    const lines = await readFile(trace, 'utf8');
    assert(lines.includes('send:device:{"info":{"command":"get_version"}}:1:0'));
    assert(lines.includes('cert:device:lan'));
  });
});

test('copies Cloud control and subscription arguments without sharing the LAN send path', async () => {
  await session(async (agent, trace) => {
    await agent.createAgent(trace);
    await agent.startSubscribe('app');
    await agent.sendMessage('cloud-device', '{"pushing":{"command":"pushall"}}', 1, 0);
    await agent.stopSubscribe('app');
    await assert.rejects(agent.sendMessage('cloud-device', 'private', 0.5, 0), /integer argument/);
    await agent.close();
    const lines = (await readFile(trace, 'utf8')).split('\n');
    assert(lines.includes('subscribe:app'));
    assert(lines.includes('cloud-send:cloud-device:{"pushing":{"command":"pushall"}}:1:0'));
    assert(lines.includes('unsubscribe:app'));
    assert(!lines.some(line => line.startsWith('send:')));
  });
});
