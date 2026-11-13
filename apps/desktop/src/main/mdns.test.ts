import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { MdnsHost, type MdnsPacket } from './mdns';

const type = '_test._tcp.local.';
const fqdn = 'Test._test._tcp.local';
function packet(ttl = 10): MdnsPacket {
  return { answers: [{ name: type, type: 'PTR', ttl, data: fqdn }], additionals: [
    { name: fqdn, type: 'SRV', ttl, data: { target: 'test.local', port: 8080 } },
    { name: fqdn, type: 'TXT', ttl, data: [Buffer.from('Key=value'), Buffer.from('flag')] },
    { name: 'test.local', type: 'A', ttl, data: '192.168.1.10' },
    { name: 'test.local', type: 'AAAA', ttl, data: 'fe80::123' },
  ] };
}
const hosts: MdnsHost[] = [];
afterEach(() => { hosts.forEach(host => host.close()); hosts.length = 0; vi.useRealTimers(); });
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const owner = new EventEmitter() as WebContents;
  let receive!: (packet: MdnsPacket) => void, failed!: () => void;
  const socket = { query: vi.fn(), destroy: vi.fn() };
  const create = vi.fn((response, failure) => { receive = response; failed = failure; return socket; });
  const host = new MdnsHost(create); hosts.push(host);
  return { host, owner, socket, create, receive: (p: MdnsPacket) => receive(p), failed: () => failed() };
}
it('is lazy, joins split DNS-SD records and uses SRV plus A/AAAA rather than TXT addresses', () => {
  const f = fixture(); expect(f.create).not.toHaveBeenCalled();
  f.host.start(f.owner, 'browse', type); expect(f.socket.query).toHaveBeenCalledWith([{ name: type, type: 'PTR' }]);
  const records = packet(); f.receive({ answers: records.answers });
  expect(f.socket.query).toHaveBeenLastCalledWith([{ name: `${fqdn.toLowerCase()}.`, type: 'SRV' }, { name: `${fqdn.toLowerCase()}.`, type: 'TXT' }]);
  expect(f.host.snapshot(f.owner, 'browse')).toEqual([]);
  f.receive({ answers: records.additionals });
  expect(f.host.snapshot(f.owner, 'browse')).toEqual([{ id: `${fqdn.toLowerCase()}.`, serviceType: type, name: 'Test', host: 'test.local.', port: 8080,
    addresses: ['192.168.1.10', 'fe80::123'], txt: { key: 'value', flag: '' }, expiresAtMs: 110_000 }]);
});
it('refreshes unchanged records, replaces changed TXT/SRV and expires TTLs and goodbye records', () => {
  const f = fixture(); f.host.start(f.owner, 'browse', type); f.receive(packet());
  vi.advanceTimersByTime(6000); f.receive(packet());
  expect(f.host.snapshot(f.owner, 'browse')[0].expiresAtMs).toBe(116_000);
  f.receive({ answers: [{ name: fqdn, type: 'TXT', ttl: 10, data: [Buffer.from('key=changed')] }] });
  expect(f.host.snapshot(f.owner, 'browse')[0].txt).toEqual({ key: 'changed' });
  vi.advanceTimersByTime(5000); expect(f.host.snapshot(f.owner, 'browse')).toHaveLength(1);
  f.receive({ answers: [{ name: type, type: 'PTR', ttl: 0, data: fqdn }] });
  expect(f.host.snapshot(f.owner, 'browse')).toEqual([]);
  f.receive(packet(1)); vi.advanceTimersByTime(1100);
  expect(f.host.snapshot(f.owner, 'browse')).toEqual([]);
});
it('keeps browses owner-scoped and closes on renderer destruction, navigation or crash', () => {
  const f = fixture(), other = new EventEmitter() as WebContents;
  f.host.start(f.owner, 'browse', type);
  expect(() => f.host.snapshot(other, 'browse')).toThrow('Unknown');
  f.host.stop(other, 'browse'); expect(f.socket.destroy).not.toHaveBeenCalled();
  f.owner.emit('destroyed'); expect(f.socket.destroy).toHaveBeenCalledOnce();
  f.host.start(f.owner, 'next', type); vi.advanceTimersByTime(11_000);
  expect(f.socket.destroy).toHaveBeenCalledOnce(); // Background timer throttling does not cancel a live browse.
  f.owner.emit('did-start-navigation', {}, 'http://guest/', false, false);
  expect(f.socket.destroy).toHaveBeenCalledOnce();
  f.owner.emit('did-start-navigation', {}, 'http://app/', false, true);
  expect(f.socket.destroy).toHaveBeenCalledTimes(2);
  f.host.start(f.owner, 'crash', type); f.owner.emit('render-process-gone');
  expect(f.socket.destroy).toHaveBeenCalledTimes(3);
  expect(f.owner.listenerCount('destroyed')).toBe(0);
});
it('rejects invalid browse input, preserves socket failure and cleans up failed starts', () => {
  const f = fixture();
  for (const value of ['_test', '_test._tcp.example.', '*._tcp.local.']) expect(() => f.host.start(f.owner, 'browse', value)).toThrow();
  expect(f.create).not.toHaveBeenCalled();
  f.host.start(f.owner, 'browse', type); f.failed();
  expect(() => f.host.snapshot(f.owner, 'browse')).toThrow('permissions');
  f.host.stop(f.owner, 'browse'); f.socket.query.mockImplementation(() => { throw new Error('closed'); });
  expect(() => f.host.start(f.owner, 'next', type)).toThrow('could not start');
  expect(f.socket.destroy).toHaveBeenCalledTimes(2);
});
