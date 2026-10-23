import { expect, it, vi } from 'vitest';
import type { BambuNative, NativeEvent } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import { BambuMonitor } from './monitor';
import { BambuOperations } from './operations';
const target = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:cloud' as D.Id<'route'> };
const request = (extra: Partial<D.CommandRequest> = {}): D.CommandRequest => ({ target, requestId: 'request' as D.Id<'request'>, command: { type: 'jobs.pause', params: {} }, ...extra } as D.CommandRequest);
function fixture(timeout = 1000) {
  const methods = ['setSelectedMachine', 'startSubscribe', 'stopSubscribe', 'sendMessage', 'sendMessageToPrinter', 'disconnectPrinter', 'connectPrinter'];
  const native = Object.fromEntries(methods.map(method => [method, vi.fn(async () => 0)])) as unknown as BambuNative;
  const monitor = new BambuMonitor(native, { list: async () => ['a', 'b'].map(deviceId => ({ deviceId, name: deviceId, model: 'H2D', routes: [{ channel: 'cloud' as const, revision: 'r1' }] })) },
    { read: async () => ({ version: 1, region: 'Others', clientId: 'test', lan: [] }) }, async () => {}, () => {}, Date.now, 300);
  const operations = new BambuOperations(monitor, () => {}, timeout);
  const emit = async (event: NativeEvent) => { monitor.onEvent(event); await operations.onEvent(event); };
  const push = async (phase = 'RUNNING', device = 'a', task = 'task') => emit({ type: 'message', args: [device, JSON.stringify({ print: { command: 'push_status', msg: 0, gcode_state: phase, subtask_id: task } })] });
  vi.mocked(native.sendMessage).mockImplementation(async (device, payload) => { if (JSON.parse(payload).pushing) setImmediate(() => { void push('RUNNING', device); }); return 0; });
  const commands = () => vi.mocked(native.sendMessage).mock.calls.map(call => JSON.parse(call[1])).filter(payload => payload.print).map(payload => payload.print);
  return { monitor, operations, native, emit, push, commands, close: async () => { operations.close(); await monitor.close(); } };
}
it('submits without observe/evaluate, deduplicates request IDs, and treats ACK separately from completion', async () => {
  const f = fixture(); try {
    const [first, second] = await Promise.all([f.operations.submit(request()), f.operations.submit(request())]);
    expect(first).toEqual(second); if (first.kind !== 'recorded') throw new Error('Not recorded');
    expect(f.commands()).toHaveLength(1); expect(f.operations.get(first.operation)).toMatchObject({ ok: true, value: { operation: { phase: { kind: 'sent' } } } });
    const sent = f.commands()[0];
    await f.emit({ type: 'message', args: ['a', JSON.stringify({ print: { command: sent.command, sequence_id: sent.sequence_id, result: 'success' } })] });
    expect(f.operations.get(first.operation)).toMatchObject({ value: { operation: { phase: { kind: 'acknowledged' } } } });
    await f.push('PAUSE');
    expect(f.operations.get(first.operation)).toMatchObject({ value: { operation: { phase: { kind: 'completed', confirmation: 'observed-state' } } } });
    expect(await f.operations.submit(request({ command: { type: 'jobs.cancel', params: {} } }))).toMatchObject({ kind: 'rejected', error: { code: 'invalid-request' } });
    expect(f.operations.find({ ...target, requestId: 'request' as never })).toMatchObject({ value: { kind: 'found' } });
    expect(f.operations.get({ ...first.operation, printerId: 'bambu:b' as never })).toMatchObject({ value: { kind: 'unknown' } });
  } finally { await f.close(); }
});
it('checks task/configuration guards at dispatch and never queues an action on stale status', async () => {
  const f = fixture(); try {
    expect(await f.operations.submit(request({ guard: { expectedTaskId: 'different-task' as never } }))).toMatchObject({ kind: 'rejected', error: { code: 'stale-context' } });
    expect(f.commands()).toHaveLength(0);
    await f.monitor.start(target, 'view'); await f.push();
    await f.emit({ type: 'server-error', args: ['lost', -1] });
    expect(await f.operations.submit(request({ requestId: 'offline' as never }))).toMatchObject({ kind: 'rejected', error: { code: 'offline' } });
    await f.push(); expect(f.commands()).toHaveLength(0);
  } finally { await f.close(); }
});
it('pins old operations across printer switches and reports unknown without retrying', async () => {
  const f = fixture(30); try {
    await f.monitor.start(target, 'old'); await f.push();
    const result = await f.operations.submit(request()); if (result.kind !== 'recorded') throw new Error('Not recorded');
    await f.monitor.start({ printerId: 'bambu:b' as never, routeId: 'bambu:b:cloud' as never }, 'new'); await f.push('PAUSE', 'b');
    expect(f.operations.get(result.operation)).toMatchObject({ value: { operation: { ref: target, phase: { kind: 'sent' } } } });
    await new Promise(resolve => setTimeout(resolve, 45));
    expect(f.operations.get(result.operation)).toMatchObject({ value: { operation: { phase: { kind: 'outcome-unknown' } } } });
    expect(f.native.setSelectedMachine).toHaveBeenLastCalledWith('b'); expect(f.commands()).toHaveLength(1);
    expect(await f.operations.submit(request())).toEqual(result); expect(f.commands()).toHaveLength(1);
  } finally { await f.close(); }
});
it('sanitizes device rejection and never exposes raw error bodies', async () => {
  const f = fixture(); try {
    const result = await f.operations.submit(request()); if (result.kind !== 'recorded') throw new Error('Not recorded');
    const sent = f.commands()[0];
    await f.emit({ type: 'message', args: ['a', JSON.stringify({ print: { command: sent.command, sequence_id: sent.sequence_id, result: 'fail', reason: 'PRIVATE_TOKEN' } })] });
    expect(f.operations.get(result.operation)).toMatchObject({ value: { operation: { phase: { kind: 'failed', error: { code: 'device-rejected' } } } } });
    expect(JSON.stringify(f.operations.get(result.operation))).not.toContain('PRIVATE_TOKEN');
  } finally { await f.close(); }
});
it('does not mistake an ignored report for fresh completion evidence', async () => {
  const f = fixture(); try {
    await f.monitor.start(target, 'view'); await f.push();
    await f.emit({ type: 'message', args: ['a', JSON.stringify({ print: { command: 'push_status', msg: 1, lights_report: [{ node: 'chamber_light', mode: 'on' }] } })] });
    const result = await f.operations.submit(request({ command: { type: 'lights.set', params: { lightId: 'chamber_light' as never, on: true } } }));
    if (result.kind !== 'recorded') throw new Error('Not recorded');
    await f.emit({ type: 'message', args: ['a', JSON.stringify({ print: { command: 'push_status', msg: 7 } })] });
    expect(f.operations.get(result.operation)).toMatchObject({ value: { operation: { phase: { kind: 'sent' } } } });
  } finally { await f.close(); }
});
