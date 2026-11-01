import { expect, it, vi } from 'vitest';
import type { BambuNative } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import { BambuDeviceAccess } from './deviceAccess';
import { BambuMonitor } from './monitor';
import type { BambuObjectSkipping } from './objectSkipping';
const target = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:agent' as D.Id<'route'> };
function fixture() {
  const native = Object.fromEntries(['setSelectedMachine', 'startSubscribe', 'stopSubscribe', 'sendMessage', 'disconnectPrinter'].map(method => [method, vi.fn(async () => 0)])) as unknown as BambuNative;
  const access = new BambuDeviceAccess(native, { list: async () => [{ deviceId: 'a', name: 'Printer', model: 'H2D', routes: [{ channel: 'cloud', revision: 'r1' }] }] },
    { read: async () => ({ version: 1, region: 'Others', clientId: 'fixture', lan: [] }) }, async () => {}, () => {}, Date.now, 100);
  const skipping = { projectContext: vi.fn<BambuObjectSkipping['projectContext']>(() => undefined), readCatalogue: vi.fn<BambuObjectSkipping['readCatalogue']>() };
  const monitor = new BambuMonitor(access, skipping);
  const push = () => monitor.onEvent({ type: 'message', args: ['a', JSON.stringify({ print: { command: 'push_status', msg: 0, gcode_state: 'PAUSE', subtask_id: 'task', print_error: 0x03008010, access_code: 'PRIVATE' } })] });
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
    const projectedBase = f.skipping.projectContext.mock.calls.at(-1)![0];
    expect(Object.hasOwn(projectedBase, 'recovery')).toBe(false);
    const snapshot = await f.monitor.read({ target, topics: ['status', 'alerts'], source: 'cache' });
    expect(snapshot).toMatchObject({ ok: true, value: { values: { alerts: { value: expect.arrayContaining([expect.objectContaining({ dialog: expect.any(Object) })]) } } } });
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|access_code|"context"|"report"/);
  } finally { await f.access.close(); }
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
