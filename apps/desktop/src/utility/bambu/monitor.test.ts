import { expect, it, vi } from 'vitest';
import type { BambuNative } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import type { BambuDevice } from '../../shared/bambuDevices';
import { BambuMonitor } from './monitor';
const target = (id: string, channel = 'cloud'): D.PrinterTarget => ({ printerId: `bambu:${id}` as D.Id<'printer'>, routeId: `bambu:${id}:${channel}` as D.Id<'route'> });
function fixture() {
  let now = 100; let devices: BambuDevice[] = ['a', 'b'].map(deviceId => ({ deviceId, name: deviceId, model: null, routes: [{ channel: 'cloud', revision: 'r1' }, { channel: 'lan', revision: 'l1', address: '192.0.2.1' }] }));
  const methods = ['setSelectedMachine', 'startSubscribe', 'stopSubscribe', 'sendMessage', 'sendMessageToPrinter', 'disconnectPrinter', 'connectPrinter'];
  const native = Object.fromEntries(methods.map(method => [method, vi.fn(async () => 0)])) as unknown as BambuNative;
  const changed = vi.fn(), release = vi.fn(async () => {});
  const repository = { read: async () => ({ version: 1 as const, region: 'Others' as const, clientId: 'test', lan: [{ deviceId: 'a', name: 'a', model: '', ip: '192.0.2.1', accessCode: 'SECRET', revision: 'l1' }] }) };
  const monitor = new BambuMonitor(native, { list: async () => devices }, repository, release, changed, () => now, 30);
  const push = (id: string, value = { msg: 0, gcode_state: 'RUNNING', mc_percent: 50 }, lan = false) => monitor.onEvent({ type: lan ? 'local-message' : 'message', args: [id, JSON.stringify({ print: { command: 'push_status', ...value } })] });
  return { monitor, native, changed, release, push, setDevices: (value: BambuDevice[]) => { devices = value; }, advance: (ms: number) => { now += ms; } };
}
const read = (f: ReturnType<typeof fixture>, id = 'a', channel = 'cloud') => f.monitor.read({ target: target(id, channel), topics: ['status'], source: 'cache' });
it('reads/description are local, starts one Cloud route, and late cleanup cannot stop a new selection', async () => {
  const f = fixture(); try {
    expect(await read(f)).toMatchObject({ ok: true, value: { values: { status: { kind: 'unknown' } } } });
    expect(await f.monitor.describe(target('a'))).toMatchObject({ ok: true, value: { descriptor: { kind: 'unknown' } } });
    expect(f.native.setSelectedMachine).not.toHaveBeenCalled();
    expect(await f.monitor.start(target('a'), 'first')).toEqual({ ok: true, value: null }); f.push('a');
    expect(await read(f)).toMatchObject({ ok: true, value: { values: { status: { kind: 'known', freshness: 'fresh' } } } });
    await f.monitor.start(target('b'), 'second'); f.push('a');
    expect(await read(f, 'b')).toMatchObject({ ok: true, value: { values: { status: { kind: 'unknown' } } } });
    await f.monitor.stop('first'); expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('b');
    expect(await read(f)).toMatchObject({ ok: true, value: { values: { status: { freshness: 'stale' } } } });
    f.push('b'); await f.monitor.stop('second'); expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('');
  } finally { await f.monitor.close(); }
});
it('isolates route callbacks and never falls back to LAN after Cloud failure', async () => {
  const f = fixture(); try {
    expect(await f.monitor.start(target('a', 'lan'), 'lan')).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
    await f.monitor.start(target('a'), 'cloud'); f.push('a');
    f.monitor.onEvent({ type: 'server-error', args: ['private error', -1] });
    f.push('a', undefined, true);
    expect(await read(f)).toMatchObject({ ok: true, value: { values: { status: { freshness: 'stale' } } } });
    expect(f.native.connectPrinter).not.toHaveBeenCalled();
    expect(JSON.stringify(await read(f))).not.toContain('private error');
    f.push('a', { msg: 1, gcode_state: 'RUNNING', mc_percent: 70 });
    expect(await read(f)).toMatchObject({ ok: true, value: { values: { status: { freshness: 'stale' } } } });
    f.push('a'); expect(await read(f)).toMatchObject({ ok: true, value: { values: { status: { freshness: 'fresh' } } } });
    f.advance(16_000); expect(await read(f)).toMatchObject({ ok: true, value: { values: { status: { freshness: 'stale' } } } });
  } finally { await f.monitor.close(); }
});
it('invalidates removed Cloud and can subsequently monitor the retained authorized LAN route', async () => {
  const f = fixture(); try {
    await f.monitor.start(target('a'), 'cloud'); f.push('a');
    f.setDevices([{ deviceId: 'a', name: 'a', model: null, routes: [{ channel: 'lan', revision: 'l1', address: '192.0.2.1' }] }]);
    await f.monitor.reconcile(); expect(await read(f)).toMatchObject({ ok: false, error: { code: 'invalid-target' } });
    await f.monitor.start(target('a', 'lan'), 'lan');
    expect(f.native.connectPrinter).toHaveBeenCalledWith('a', '192.0.2.1', 'bblp', 'SECRET', true);
    f.monitor.onEvent({ type: 'local-connect', args: [0, 'a', ''] }); f.push('a', undefined, true);
    const result = await read(f, 'a', 'lan'); expect(result).toMatchObject({ ok: true, value: { values: { status: { freshness: 'fresh' } } } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    await f.monitor.stop('cloud'); expect(f.native.disconnectPrinter).not.toHaveBeenCalled();
    await f.monitor.stop('lan'); expect(f.native.disconnectPrinter).toHaveBeenCalledOnce();
  } finally { await f.monitor.close(); }
});
it('device read has no watch prerequisite and releases its temporary connection with a fresh result', async () => {
  const f = fixture(); try {
    vi.mocked(f.native.sendMessage).mockImplementation(async (_id, payload) => {
      if (JSON.parse(payload).pushing) setImmediate(() => f.push('a'));
      return 0;
    });
    const result = await f.monitor.read({ target: target('a'), topics: ['status', 'materials'], source: 'device' });
    expect(result).toMatchObject({ ok: true, value: { values: { status: { freshness: 'fresh' }, materials: { freshness: 'fresh' } } } });
    expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('');
    expect(await read(f)).toMatchObject({ ok: true, value: { values: { status: { freshness: 'stale' } } } });
  } finally { await f.monitor.close(); }
});
it('device read times out without leaving monitoring and does not steal another selected device', async () => {
  const f = fixture(); try {
    expect(await f.monitor.read({ target: target('a'), topics: ['status'], source: 'device' })).toMatchObject({ ok: false, error: { code: 'offline' } });
    expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('');
    await f.monitor.start(target('b'), 'selected');
    expect(await f.monitor.read({ target: target('a'), topics: ['status'], source: 'device' })).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('b');
  } finally { await f.monitor.close(); }
});
