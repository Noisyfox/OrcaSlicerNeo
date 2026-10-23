import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BambuNative } from '@orca/bambu-native';
import { BambuLan } from './lan';
import { BambuDevices } from './devices';
import { BambuRepository } from './repository';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const announcement = (fields = {}) => JSON.stringify({ dev_id: 'serial', dev_name: 'Printer', dev_type: 'X1C', dev_ip: '192.0.2.1', connect_type: 'lan', connection_name: 'wifi', ...fields });
async function fixture(timeoutMs = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'neo-bambu-lan-')); let repository = new BambuRepository(directory); let now = 100_000;
  const calls: string[] = []; let callback = true; let failure = false;
  const native = {
    connectPrinter: vi.fn(async (_id: string, _ip: string, _user: string, _code: string, _ssl: boolean) => {
      calls.push('connect');
      if (callback) queueMicrotask(() => { lan.onEvent({ type: 'local-connect', args: [failure ? 1 : 0, 'serial', failure ? '5' : 'connected'] }); if (!failure) lan.onEvent({ type: 'printer-connected', args: ['serial'] }); });
      return 0;
    }),
    disconnectPrinter: vi.fn(async () => { calls.push('disconnect'); return 0; }),
    getSelectedMachine: vi.fn(async () => ''), setSelectedMachine: vi.fn(async () => 0),
    sendMessageToPrinter: vi.fn(async (_id: string, payload: string, qos: number, flag: number) => { const data = Object.values(JSON.parse(payload))[0] as { command: string }; calls.push(`${data.command}:${qos}:${flag}`); return 0; }),
    installDeviceCertificate: vi.fn(async () => { calls.push('cert'); }),
  };
  const changed = vi.fn(); let lan = new BambuLan(native as unknown as BambuNative, repository, changed, () => now, timeoutMs);
  cleanups.push(async () => { await lan.close(); await rm(directory, { recursive: true, force: true }); });
  const announce = async (fields = {}) => { lan.onEvent({ type: 'ssdp', args: [announcement(fields)] }); return lan.list(); };
  return { get lan() { return lan; }, get repository() { return repository; }, native, calls, changed, announce,
    failure: () => { failure = true; }, silent: () => { callback = false; }, advance: (ms: number) => { now += ms; },
    restart: async () => { await lan.close(); repository = new BambuRepository(directory); lan = new BambuLan(native as unknown as BambuNative, repository, changed, () => now, timeoutMs); },
  };
}
it('keeps announcements as candidates, authenticates with Orca parameters, and serializes both bootstrap callback sequences', async () => {
  const f = await fixture(); const [candidate] = await f.announce(); expect((await f.repository.read()).lan).toEqual([]);
  expect(await f.lan.authorize(candidate.candidateId, 'ABCDEFGH')).toEqual({ ok: true, value: null }); await f.lan.list();
  expect(f.native.connectPrinter).toHaveBeenCalledWith('serial', '192.0.2.1', 'bblp', 'ABCDEFGH', true);
  expect(f.calls).toEqual(['connect', 'pushall:0:0', 'get_version:1:0', 'pushall:0:0', 'get_version:1:0', 'get_access_code:0:0', 'cert']);
  expect(f.native.installDeviceCertificate).toHaveBeenCalledWith('serial', true);
  expect((await f.repository.read()).lan[0].accessCode).toBe('ABCDEFGH'); expect(JSON.stringify(await f.lan.list())).not.toContain('ABCDEFGH');
});
it('rejects invalid codes, native authentication failure and expired candidates without saving credentials', async () => {
  const f = await fixture(); const [candidate] = await f.announce();
  expect(await f.lan.authorize(candidate.candidateId, 'bad!')).toMatchObject({ ok: false, error: { code: 'permission-denied' } }); expect(f.native.connectPrinter).not.toHaveBeenCalled();
  f.failure(); expect(await f.lan.authorize(candidate.candidateId, 'ABCDEFGH')).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
  expect((await f.repository.read()).lan).toEqual([]);
  f.advance(30_001); expect(await f.lan.list()).toEqual([]); expect(await f.lan.authorize(candidate.candidateId, 'ABCDEFGH')).toMatchObject({ ok: false, error: { code: 'stale-context' } });
});
it('restores and reuses a remembered code after restart and forgets only LAN access', async () => {
  const f = await fixture(); let [candidate] = await f.announce(); await f.lan.authorize(candidate.candidateId, 'ABCDEFGH');
  await f.restart(); [candidate] = await f.announce(); expect(await f.lan.authorize(candidate.candidateId, '')).toMatchObject({ ok: true });
  expect(f.native.connectPrinter).toHaveBeenLastCalledWith('serial', '192.0.2.1', 'bblp', 'ABCDEFGH', true);
  const devices = new BambuDevices(f.repository, () => {}); devices.activate(); await devices.refresh(async () => ({ result: 0, httpCode: 200, body: JSON.stringify({ devices: [{ dev_id: 'serial', dev_name: 'Printer' }] }) }));
  expect((await devices.list())[0].routes).toHaveLength(2);
  const record = (await f.repository.read()).lan[0]; expect(await f.lan.forget('serial', record.revision)).toMatchObject({ ok: true });
  expect((await devices.list())[0].routes.map(route => route.channel)).toEqual(['cloud']); expect((await f.repository.read()).lan).toEqual([]);
  expect(await f.lan.authorize(candidate.candidateId, '')).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
});
it('follows Orca connection_name address rules and rejects stale forget requests without changing remembered access', async () => {
  const f = await fixture(); const [candidate] = await f.announce(); await f.lan.authorize(candidate.candidateId, 'ABCDEFGH'); const original = (await f.repository.read()).lan[0];
  await f.announce({ dev_ip: '192.0.2.2', connection_name: 'other', dev_name: 'Renamed' });
  expect((await f.repository.read()).lan[0]).toMatchObject({ ip: '192.0.2.1', name: 'Renamed' });
  await f.announce({ dev_ip: '192.0.2.3', connection_name: '' }); expect((await f.repository.read()).lan[0]).toMatchObject({ ip: '192.0.2.3', accessCode: 'ABCDEFGH' });
  expect(await f.lan.forget('serial', original.revision)).toMatchObject({ ok: false, error: { code: 'stale-context' } });
  await f.announce({ dev_id: 'another', dev_name: 'Printer' }); expect(await f.lan.list()).toHaveLength(2);
});
it('bounds silent connections and prevents concurrent operations and closure from persisting unfinished access', async () => {
  const f = await fixture(5); const [candidate] = await f.announce(); f.silent();
  const pending = f.lan.authorize(candidate.candidateId, 'ABCDEFGH'); expect(await f.lan.authorize(candidate.candidateId, 'ABCDEFGH')).toMatchObject({ ok: false, error: { code: 'busy' } });
  expect(await pending).toMatchObject({ ok: false, error: { code: 'transport' } }); expect((await f.repository.read()).lan).toEqual([]);
  const second = await fixture(1000); const [other] = await second.announce(); second.silent();
  const closing = second.lan.authorize(other.candidateId, 'ABCDEFGH'); await vi.waitFor(() => expect(second.native.connectPrinter).toHaveBeenCalledOnce()); await second.lan.close();
  expect(await closing).toMatchObject({ ok: false, error: { code: 'cancelled' } }); expect((await second.repository.read()).lan).toEqual([]);
});
