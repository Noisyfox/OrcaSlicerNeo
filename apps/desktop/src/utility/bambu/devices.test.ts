import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativeHttpResult } from '@orca/bambu-native';
import { BambuDevices } from './devices';
import { BambuRepository } from './repository';
import { isBambuReadResult } from '../../shared/bambu';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const response = (devices: unknown[]): NativeHttpResult => ({ result: 0, httpCode: 200, body: JSON.stringify({ devices }) });
const device = (id: string, name = 'Printer') => ({ dev_id: id, dev_name: name, dev_model_name: 'X1C', dev_access_code: 'private-cloud-code' });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'neo-bambu-devices-')); directories.push(directory);
  const repository = new BambuRepository(directory); const changed = vi.fn(); const devices = new BambuDevices(repository, changed); devices.activate();
  return { devices, repository, changed };
}
it('atomically reconciles full and empty lists, follows names, and never publishes cloud access codes', async () => {
  const f = await fixture(); await f.devices.refresh(async () => response([device('a'), device('b')]));
  const initial = await f.devices.list(); expect(initial).toHaveLength(2);
  expect(JSON.stringify(initial)).not.toContain('private-cloud-code'); expect(isBambuReadResult('printers.saved', { ok: true, value: initial })).toBe(true);
  await f.devices.refresh(async () => response([device('a', 'Renamed')]));
  const renamed = await f.devices.list(); expect(renamed).toHaveLength(1); expect(renamed[0].name).toBe('Renamed');
  expect(renamed[0].routes[0].revision).not.toBe(initial[0].routes[0].revision);
  await f.devices.refresh(async () => response([device('a', 'Renamed')])); expect((await f.devices.list())[0].routes[0].revision).toBe(renamed[0].routes[0].revision);
  await f.devices.refresh(async () => response([])); expect(await f.devices.list()).toEqual([]);
});
it('retains the last complete list for malformed, incomplete, duplicate and failed responses', async () => {
  const f = await fixture(); await f.devices.refresh(async () => response([device('a')])); const before = await f.devices.list();
  for (const result of [{ result: -1, httpCode: 503, body: '{}' }, { result: 0, httpCode: 200, body: '{}' }, { result: 0, httpCode: 200, body: '{' }, response([device('b'), { dev_name: 'missing id' }]), response([device('b'), device('b')])]) {
    expect(await f.devices.refresh(async () => result)).toBe(false); expect(await f.devices.list()).toEqual(before);
  }
});
it('ignores old requests after logout, account/region replacement and a newer refresh', async () => {
  const f = await fixture(); let complete!: (value: NativeHttpResult) => void;
  const pending = f.devices.refresh(() => new Promise(resolve => { complete = resolve; })); f.devices.clear(); f.devices.activate();
  await f.devices.refresh(async () => response([device('new')])); complete(response([device('old')])); expect(await pending).toBe(false);
  expect((await f.devices.list()).map(device => device.deviceId)).toEqual(['new']);
  const older = f.devices.refresh(() => new Promise(resolve => { complete = resolve; })); await f.devices.refresh(async () => response([])); complete(response([device('old')]));
  expect(await older).toBe(false); expect(await f.devices.list()).toEqual([]);
});
it('uses serial identity and preserves independently authorized LAN routes across cloud cleanup', async () => {
  const f = await fixture(); await f.repository.update(state => ({ ...state, lan: [{ deviceId: 'a', name: 'LAN name', model: 'X1C', ip: '192.0.2.1', accessCode: 'private-lan-code', revision: 'lan-fixture' }] }));
  await f.devices.refresh(async () => response([device('a')])); const combined = await f.devices.list(); expect(combined).toHaveLength(1); expect(combined[0].routes.map(route => route.channel)).toEqual(['cloud', 'lan']);
  f.devices.clear(); const remaining = await f.devices.list(); expect(remaining).toHaveLength(1); expect(remaining[0].routes.map(route => route.channel)).toEqual(['lan']);
  expect((await f.repository.read()).lan[0].accessCode).toBe('private-lan-code'); expect(JSON.stringify(remaining)).not.toContain('private-lan-code');
  expect(isBambuReadResult('printers.saved', { ok: true, value: [{ ...remaining[0], token: 'private' }] })).toBe(false);
  expect(isBambuReadResult('printers.saved', { ok: true, value: [{ ...remaining[0], routes: [{ channel: 'lan', revision: 'x', address: '192.0.2.1', accessCode: 'private' }] }] })).toBe(false);
});
