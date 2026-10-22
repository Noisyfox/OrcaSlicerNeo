import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BambuNative, NativeEvent } from '@orca/bambu-native';
import { BambuRuntime } from './runtime';
import { BambuRepository } from './repository';

async function fixture(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'neo-bambu-runtime-'));
  try { await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function nativeFixture() {
  const calls: { method: string; args: unknown[] }[] = [];
  const methods = ['createAgent', 'setConfigDirectory', 'initLog', 'setCertificate', 'installCallbacks', 'setCountryCode', 'setExtraHttpHeaders', 'start', 'trackEnable', 'trackRemoveFiles', 'installDiscoveryCallbacks', 'connectServer'];
  const native = Object.fromEntries(methods.map(method => [method, vi.fn(async (...args: unknown[]) => { calls.push({ method, args }); return 0; })])) as unknown as BambuNative;
  native.getVersion = vi.fn(async () => '02.08.01.99');
  native.startDiscovery = vi.fn(async (...args) => { calls.push({ method: 'startDiscovery', args }); return true; });
  native.isUserLoggedIn = vi.fn(async () => false);
  native.getUserNickname = vi.fn(async () => 'User'); native.getUserAvatar = vi.fn(async () => '');
  native.close = vi.fn(async () => { calls.push({ method: 'close', args: [] }); });
  return { native, calls };
}

describe('Bambu utility runtime', () => {
  it('uses Orca startup ordering, Neo-owned configuration and public-only invalidations', async () => fixture(async directory => {
    const { native, calls } = nativeFixture(); const changes = vi.fn(); let emit!: (event: NativeEvent) => void;
    const runtime = new BambuRuntime({ directory, addonPath: '/addon', pluginPath: '/plugin', certificateDirectory: '/cert', osType: 'macos', osVersion: '15.6.0' }, changes,
      (_addon, _plugin, listener) => { emit = listener; return native; });
    expect(await runtime.read('account.state')).toEqual({ status: 'signed-out', error: null });
    expect(calls.map(call => call.method)).toEqual(['createAgent', 'setConfigDirectory', 'initLog', 'setCertificate', 'installCallbacks', 'setCountryCode', 'setExtraHttpHeaders', 'start', 'trackEnable', 'trackRemoveFiles', 'installDiscoveryCallbacks', 'startDiscovery']);
    expect(calls[0].args).toEqual([join(directory, 'plugin')]);
    expect(calls[1].args).toEqual([join(directory, 'plugin')]);
    expect(calls[5].args).toEqual(['Others']);
    expect(calls[6].args[0]).toMatchObject({ 'X-BBL-Client-Type': 'slicer', 'X-BBL-Client-Name': 'BambuStudio', 'X-BBL-Client-Version': '02.08.01.55' });
    expect(calls.at(-1)?.args).toEqual([true, false]);
    emit({ type: 'http-error', args: [401, 'must-not-cross-ipc'] }); emit({ type: 'ssdp', args: ['access-code-must-not-cross-ipc'] });
    expect(changes.mock.calls).toEqual([['account'], ['account'], ['printers']]);
    expect(await runtime.read('printers.saved')).toEqual({ ok: true, value: [] });
    expect((await runtime.read('account.settings'))[0].value).toBe('Others');
    await runtime.close(); expect(native.close).toHaveBeenCalledOnce();
  }));

  it('restores a stored region and summarizes a native remembered login without public account IDs', async () => fixture(async directory => {
    const repository = new BambuRepository(directory);
    await repository.update(state => ({ ...state, region: 'China' }));
    const { native } = nativeFixture(); vi.mocked(native.isUserLoggedIn).mockResolvedValue(true);
    const runtime = new BambuRuntime({ directory, addonPath: '/addon', pluginPath: '/plugin', certificateDirectory: '/cert', osType: 'linux', osVersion: '6.0.0' }, () => {}, () => native);
    expect(await runtime.read('account.state')).toEqual({ status: 'signed-in', account: { displayName: 'User', avatarUrl: null }, error: null });
    expect(native.setCountryCode).toHaveBeenCalledWith('CN'); expect(native.connectServer).toHaveBeenCalledOnce();
    await runtime.close();
  }));

  it('closes partial initialization and exposes a fixed error without native payloads', async () => fixture(async directory => {
    const { native } = nativeFixture(); vi.mocked(native.start).mockRejectedValue(new Error('private-native-data'));
    const runtime = new BambuRuntime({ directory, addonPath: '/addon', pluginPath: '/plugin', certificateDirectory: '/cert', osType: 'linux', osVersion: '6.0.0' }, () => {}, () => native);
    expect(await runtime.read('account.state')).toEqual({ status: 'unavailable', error: { code: 'unavailable', message: 'Bambu networking is unavailable.' } });
    await runtime.close(); expect(native.close).toHaveBeenCalledOnce();
  }));
});

it('serializes host-owned state changes and persists LAN credentials independently of the plugin directory', async () => fixture(async directory => {
  const repository = new BambuRepository(directory);
  const initial = await repository.read();
  await Promise.all([
    repository.update(state => ({ ...state, region: 'Europe' })),
    repository.update(state => ({ ...state, lan: [{ deviceId: 'device', name: 'Printer', model: 'X1C', ip: '192.0.2.1', accessCode: 'fixture-code' }] })),
  ]);
  const reopened = await new BambuRepository(directory).read();
  expect(reopened).toMatchObject({ region: 'Europe', clientId: initial.clientId, lan: [{ accessCode: 'fixture-code' }] });
  await expect(repository.update(state => ({ ...state, region: 'invalid' as never }))).rejects.toThrow('Invalid Bambu');
  expect(JSON.parse(await readFile(join(directory, 'provider.json'), 'utf8'))).toEqual(reopened);
}));
