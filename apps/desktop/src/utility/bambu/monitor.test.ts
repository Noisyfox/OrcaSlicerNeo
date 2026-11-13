import { expect, it, vi } from 'vitest';
import type { BambuNative } from '@orca/bambu-native';
import type * as D from '@orca/platform-contract';
import { BambuDeviceAccess } from './deviceAccess';
import { BambuMonitor } from './monitor';
import type { BambuObjectSkipping } from './objectSkipping';
import { prepareCommand } from './commands';
const target = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:agent' as D.Id<'route'> };
function fixture() {
  const native = Object.fromEntries(['setSelectedMachine', 'startSubscribe', 'stopSubscribe', 'sendMessage', 'disconnectPrinter'].map(method => [method, vi.fn(async () => 0)])) as unknown as BambuNative;
  const access = new BambuDeviceAccess(native, { list: async () => [{ deviceId: 'a', name: 'Printer', model: 'H2D', modelId: 'O1D', routes: [{ channel: 'cloud', revision: 'r1' }] }] },
    { read: async () => ({ version: 1, region: 'Others', clientId: 'fixture', lan: [] }) }, async () => {}, () => {}, Date.now, 100);
  const skipping = { projectContext: vi.fn<BambuObjectSkipping['projectContext']>(() => undefined), snapshotContext: vi.fn<BambuObjectSkipping['snapshotContext']>(() => undefined), readCatalogue: vi.fn<BambuObjectSkipping['readCatalogue']>() };
  const monitor = new BambuMonitor(access, skipping);
  const push = (printError = 0x03008010) => monitor.onEvent({ type: 'message', args: ['a', JSON.stringify({ print: { command: 'push_status', msg: 0, gcode_state: 'PAUSE', subtask_id: 'task', print_error: printError, access_code: 'PRIVATE' } })] });
  return { native, access, skipping, monitor, push };
}
it('assembles recovery alerts above base device state and keeps private context out of observations', async () => {
  const f = fixture(); try {
    expect(await f.monitor.describe(target)).toMatchObject({ ok: true, value: { descriptor: { kind: 'unknown' } } });
    expect(f.native.setSelectedMachine).not.toHaveBeenCalled();
    await f.monitor.start(target, 'view'); f.push();
    const base = await f.access.context(target);
    expect(base.ok && Object.hasOwn(base.value, 'recovery')).toBe(false);
    expect(base.ok && Object.hasOwn(base.value, 'objectSkipping')).toBe(false);
    const result = await f.monitor.context(target);
    expect(result).toMatchObject({ ok: true, value: { recovery: expect.any(Array), values: { alerts: expect.arrayContaining([expect.objectContaining({ dialog: expect.any(Object) })]) } } });
    const projectedBase = f.skipping.snapshotContext.mock.calls.at(-1)![0];
    expect(Object.hasOwn(projectedBase, 'recovery')).toBe(false);
    const snapshot = await f.monitor.read({ target, topics: ['status', 'alerts'], source: 'cache' });
    expect(snapshot).toMatchObject({ ok: true, value: { values: { alerts: { value: expect.arrayContaining([expect.objectContaining({ dialog: expect.any(Object) })]) } } } });
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|access_code|"context"|"report"/);
  } finally { await f.access.close(); }
});
it('keeps newer recovery actions valid when an older device read waits for lease cleanup', async () => {
  const f = fixture();
  let unlock!: () => void, captured!: () => void;
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const ready = new Promise<void>(resolve => { captured = resolve; });
  let blocked: Promise<D.Result<null>> | undefined;
  try {
    await f.monitor.start(target, 'view'); f.push();
    vi.mocked(f.native.sendMessage).mockImplementation(async (_id, payload) => {
      if (JSON.parse(payload).pushing) setImmediate(() => {
        f.push();
        blocked = f.access.dispatch(target, async () => {
          f.push(0x07018004); captured(); await gate;
          return { ok: true, value: null };
        });
      });
      return 0;
    });
    const pending = f.monitor.read({ target, topics: ['alerts'], source: 'device' });
    await ready;
    const before = await f.monitor.context(target);
    if (!before.ok) throw new Error('Missing current error');
    const command = { type: 'actions.invoke', params: { actionRef: before.value.values.alerts[0].actions[0].actionRef } } as const;
    expect(prepareCommand(before.value, command)).toMatchObject({ ok: true });
    unlock(); await blocked;
    const historical = await pending;
    expect(historical).toMatchObject({ ok: true, value: { values: { alerts: { freshness: 'fresh', value: [expect.objectContaining({ code: '3008010', actions: [] })] } } } });
    if (!historical.ok || historical.value.values.alerts.kind !== 'known') throw new Error('Missing captured alerts');
    expect(historical.value.values.alerts.value[0].dialog).toBeUndefined();
    const after = await f.monitor.context(target);
    if (!after.ok) throw new Error('Missing current error');
    expect(prepareCommand(after.value, command)).toMatchObject({ ok: true });
    expect(after.value.values.alerts).toEqual(before.value.values.alerts);
  } finally { unlock(); await blocked; await f.access.close(); }
});
it('preserves the fresh captured observation when temporary read cleanup invalidates the connection', async () => {
  const f = fixture(); try {
    vi.mocked(f.native.sendMessage).mockImplementation(async (_id, payload) => {
      if (JSON.parse(payload).pushing) setImmediate(f.push);
      return 0;
    });
    expect(await f.monitor.read({ target, topics: ['status', 'alerts'], source: 'device' })).toMatchObject({ ok: true, value: { values: { status: { freshness: 'fresh' }, alerts: { freshness: 'fresh' } } } });
    expect(await f.access.context(target)).toMatchObject({ ok: true, value: { fresh: false } });
    expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('');
    expect(f.skipping.readCatalogue).not.toHaveBeenCalled();
  } finally { await f.access.close(); }
});
it('does not update recovery episodes when an asynchronous context read is overtaken by a new report', async () => {
  const f = fixture();
  let unlock!: () => void, captured!: () => void;
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  const ready = new Promise<void>(resolve => { captured = resolve; });
  try {
    await f.monitor.start(target, 'view'); f.push();
    const context = f.access.context.bind(f.access);
    vi.spyOn(f.access, 'context').mockImplementationOnce(async request => {
      const result = await context(request); captured(); await gate; return result;
    });
    const pending = f.monitor.context(target);
    await ready; f.push(0x07018004);
    const before = await f.monitor.context(target);
    unlock(); await pending;
    const after = await f.monitor.context(target);
    expect(after).toEqual(before);
  } finally { unlock(); await f.access.close(); }
});
