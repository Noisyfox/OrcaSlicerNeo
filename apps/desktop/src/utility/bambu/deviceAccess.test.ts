import { expect, it, vi } from 'vitest';
import type { BambuNative } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import type { BambuDevice } from '../../shared/bambuDevices';
import { BambuDeviceAccess } from './deviceAccess';
const target = (id: string): D.PrinterTarget => ({ printerId: `bambu:${id}` as D.Id<'printer'>, routeId: `bambu:${id}:agent` as D.Id<'route'> });
function fixture() {
  let now = 100; let devices: BambuDevice[] = ['a', 'b'].map(deviceId => ({ deviceId, name: deviceId, model: null, routes: [{ channel: 'cloud', revision: 'r1' }, { channel: 'lan', revision: 'l1', address: '192.0.2.1' }] }));
  const methods = ['setSelectedMachine', 'startSubscribe', 'stopSubscribe', 'sendMessage', 'sendMessageToPrinter', 'disconnectPrinter', 'connectPrinter'];
  const native = Object.fromEntries(methods.map(method => [method, vi.fn(async () => 0)])) as unknown as BambuNative;
  const changed = vi.fn(), release = vi.fn(async () => {});
  const repository = { read: async () => ({ version: 1 as const, region: 'Others' as const, clientId: 'test', lan: [{ deviceId: 'a', name: 'a', model: '', ip: '192.0.2.1', accessCode: 'SECRET', revision: 'l1' }] }) };
  const access = new BambuDeviceAccess(native, { list: async () => devices }, repository, release, changed, () => now, 30);
  const push = (id: string, value = { msg: 0, gcode_state: 'RUNNING', mc_percent: 50 }, lan = false) => access.onEvent({ type: lan ? 'local-message' : 'message', args: [id, JSON.stringify({ print: { command: 'push_status', ...value } })] });
  return { access, native, changed, release, push, setDevices: (value: BambuDevice[]) => { devices = value; }, advance: (ms: number) => { now += ms; } };
}
const read = (f: ReturnType<typeof fixture>, id = 'a') => f.access.read({ target: target(id), topics: ['status'], source: 'cache' });
it('reads/description are local, starts one Cloud route, and late cleanup cannot stop a new selection', async () => {
  const f = fixture(); try {
    expect(await read(f)).toMatchObject({ ok: true, value: { values: { status: { kind: 'unknown' } } } });
    expect(f.native.setSelectedMachine).not.toHaveBeenCalled();
    expect(await f.access.start(target('a'), 'first')).toEqual({ ok: true, value: null }); f.push('a');
    expect(await read(f)).toMatchObject({ ok: true, value: { values: { status: { kind: 'known', freshness: 'fresh' } } } });
    await f.access.start(target('b'), 'second'); f.push('a');
    expect(await read(f, 'b')).toMatchObject({ ok: true, value: { values: { status: { kind: 'unknown' } } } });
    await f.access.stop('first'); expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('b');
    expect(await read(f)).toMatchObject({ ok: true, value: { values: { status: { freshness: 'stale' } } } });
    f.push('b'); await f.access.stop('second'); expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('');
  } finally { await f.access.close(); }
});
it('merges same-printer Cloud and LAN reports and only loses freshness when both paths fail', async () => {
  const f = fixture(); try {
    await f.access.start(target('a'), 'view'); f.push('a');
    f.access.onEvent({ type: 'local-connect', args: [0, 'a', ''] });
    expect(await read(f)).toMatchObject({ value: { values: { status: { freshness: 'fresh' } } } });
    f.push('a', { msg: 1, gcode_state: 'RUNNING', mc_percent: 70 }, true);
    f.access.onEvent({ type: 'server-error', args: ['private error', -1] });
    expect(await read(f)).toMatchObject({ value: { target: target('a'), values: { status: { freshness: 'fresh', value: { printStatus: { progressFraction: { value: 0.7 } } } } } } });
    expect(f.native.connectPrinter).not.toHaveBeenCalled();
    expect(JSON.stringify(await read(f))).not.toContain('private error');
    f.push('b', { msg: 0, gcode_state: 'IDLE', mc_percent: 0 }, true);
    expect(await read(f)).toMatchObject({ value: { values: { status: { value: { printStatus: { phase: { value: 'printing' } } } } } } });
    f.access.onEvent({ type: 'local-connect', args: [1, 'a', 'lost'] });
    expect(await read(f)).toMatchObject({ value: { values: { status: { freshness: 'stale' } } } });
    f.push('a', { msg: 1, gcode_state: 'RUNNING', mc_percent: 80 });
    expect(await read(f)).toMatchObject({ value: { values: { status: { freshness: 'stale' } } } });
    f.push('a'); expect(await read(f)).toMatchObject({ value: { values: { status: { freshness: 'fresh' } } } });
    f.access.onEvent({ type: 'local-connect', args: [1, 'a', 'lost'] });
    expect(await read(f)).toMatchObject({ value: { values: { status: { freshness: 'fresh' } } } });
    f.advance(16_000); expect(await read(f)).toMatchObject({ value: { values: { status: { freshness: 'stale' } } } });
  } finally { await f.access.close(); }
});
it('retains the logical target after logout, reconnects authorized LAN, and ignores late Cloud reports', async () => {
  const f = fixture(); try {
    await f.access.start(target('a'), 'view'); f.push('a');
    f.setDevices([{ deviceId: 'a', name: 'a', model: null, routes: [{ channel: 'lan', revision: 'l1', address: '192.0.2.1' }] }]);
    await f.access.reconcile();
    expect(f.native.connectPrinter).toHaveBeenCalledWith('a', '192.0.2.1', 'bblp', 'SECRET', true);
    f.push('a'); expect(await read(f)).toMatchObject({ value: { values: { status: { kind: 'unknown' } } } });
    f.access.onEvent({ type: 'local-connect', args: [0, 'a', ''] }); f.push('a', undefined, true);
    const result = await read(f); expect(result).toMatchObject({ value: { target: target('a'), values: { status: { freshness: 'fresh' } } } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    await f.access.stop('view'); expect(f.native.disconnectPrinter).toHaveBeenCalledTimes(2);
  } finally { await f.access.close(); }
});
it('device read has no watch prerequisite and releases its temporary connection with a fresh result', async () => {
  const f = fixture(); try {
    vi.mocked(f.native.sendMessage).mockImplementation(async (_id, payload) => {
      if (JSON.parse(payload).pushing) setImmediate(() => f.push('a'));
      return 0;
    });
    const result = await f.access.read({ target: target('a'), topics: ['status', 'materials'], source: 'device' });
    expect(result).toMatchObject({ ok: true, value: { values: { status: { freshness: 'fresh' }, materials: { freshness: 'fresh' } } } });
    expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('');
    expect(await read(f)).toMatchObject({ ok: true, value: { values: { status: { freshness: 'stale' } } } });
  } finally { await f.access.close(); }
});
it('device read times out without leaving accessing and does not steal another selected device', async () => {
  const f = fixture(); try {
    expect(await f.access.read({ target: target('a'), topics: ['status'], source: 'device' })).toMatchObject({ ok: false, error: { code: 'offline' } });
    expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('');
    await f.access.start(target('b'), 'selected');
    expect(await f.access.read({ target: target('a'), topics: ['status'], source: 'device' })).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('b');
  } finally { await f.access.close(); }
});
it('serializes LAN authorization with dispatch and rechecks freshness after reconnecting a live lease', async () => {
  const f = fixture(); try {
    await f.access.start(target('a'), 'view'); f.push('a');
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const authorize = vi.fn(async () => { await gate; return 'authorized'; });
    const suspended = f.access.suspend(authorize);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalled());
    const work = vi.fn(async () => ({ ok: true as const, value: null }));
    const dispatched = f.access.dispatch(target('a'), work);
    expect(work).not.toHaveBeenCalled();
    resume(); expect(await suspended).toBe('authorized');
    expect(await dispatched).toMatchObject({ ok: false, error: { code: 'offline' } });
    expect(work).not.toHaveBeenCalled();
    f.push('a');
    expect(await f.access.dispatch(target('a'), work)).toEqual({ ok: true, value: null });
    await f.access.stop('view'); expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('');
  } finally { await f.access.close(); }
});
