import { expect, it, vi } from 'vitest';
import type { BambuNative, NativeEvent } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import { BambuMonitor } from './monitor';
import { BambuOperations } from './operations';
const target = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:agent' as D.Id<'route'> };
const request = (extra: Omit<Partial<D.CommandRequest>, 'command'> & { command?: D.PrinterCommand } = {}): D.CommandRequest => ({ target, requestId: 'request' as D.Id<'request'>, command: { type: 'jobs.pause', params: {} }, ...extra } as D.CommandRequest);
function fixture(timeout: number | 'default' = 1000) {
  const methods = ['setSelectedMachine', 'startSubscribe', 'stopSubscribe', 'sendMessage', 'sendMessageToPrinter', 'disconnectPrinter', 'connectPrinter'];
  const native = Object.fromEntries(methods.map(method => [method, vi.fn(async () => 0)])) as unknown as BambuNative;
  const monitor = new BambuMonitor(native, { list: async () => ['a', 'b'].map(deviceId => ({ deviceId, name: deviceId, model: 'H2D', routes: [{ channel: 'cloud' as const, revision: 'r1' }] })) },
    { read: async () => ({ version: 1, region: 'Others', clientId: 'test', lan: [] }) }, async () => {}, () => {}, Date.now, 300);
  const operations = new BambuOperations(monitor, () => {}, timeout === 'default' ? undefined : timeout);
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
    await f.emit({ type: 'local-message', args: ['b', JSON.stringify({ print: { command: sent.command, sequence_id: sent.sequence_id, result: 'success' } })] });
    expect(f.operations.get(first.operation)).toMatchObject({ value: { operation: { phase: { kind: 'sent' } } } });
    await f.emit({ type: 'local-message', args: ['a', JSON.stringify({ print: { command: sent.command, sequence_id: sent.sequence_id, result: 'success' } })] });
    expect(f.operations.get(first.operation)).toMatchObject({ value: { operation: { phase: { kind: 'acknowledged' } } } });
    await f.emit({ type: 'local-message', args: ['a', JSON.stringify({ print: { command: 'push_status', msg: 1, gcode_state: 'PAUSE' } })] });
    expect(f.operations.get(first.operation)).toMatchObject({ value: { operation: { phase: { kind: 'completed', confirmation: 'observed-state' } } } });
    expect(f.commands()).toHaveLength(1);
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
    await f.monitor.start({ printerId: 'bambu:b' as never, routeId: 'bambu:b:agent' as never }, 'new'); await f.push('PAUSE', 'b');
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
it.each(['materials.load', 'materials.switch', 'materials.unload'] as const)('keeps %s pending through warm-up and completes only on idle path evidence', async type => {
  const f = fixture('default');
  try {
    await f.monitor.start(target, 'view');
    await new Promise<void>(resolve => setImmediate(resolve));
    await f.emit({ type: 'message', args: ['a', JSON.stringify({ print: { command: 'push_status', msg: 0, gcode_state: 'IDLE',
      device: { extruder: { state: 1, info: [{ id: 0, snow: 0, star: type === 'materials.unload' ? 255 : 0, stat: 0x20 }] } },
      ams: { tray_exist_bits: '1', ams: [{ id: 0, info: '3', tray: [{ id: 0, tray_type: 'PLA', nozzle_temp_min: 190, nozzle_temp_max: 230 }] }] } } })] });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const requestId = 'material' as D.Id<'request'>;
    const materialRequest: D.CommandRequest = type === 'materials.unload'
      ? { target, requestId, command: { type, params: { toolId: 'tool:0' as D.Id<'tool'> } } }
      : type === 'materials.load'
        ? { target, requestId, command: { type, params: { pathId: 'path:0:0:0' as D.Id<'path'> } } }
        : { target, requestId, command: { type, params: { pathId: 'path:0:0:0' as D.Id<'path'> } } };
    const result = await f.operations.submit(materialRequest);
    if (result.kind !== 'recorded') throw new Error(JSON.stringify(result));
    const sent = f.commands()[0];
    await f.emit({ type: 'message', args: ['a', JSON.stringify({ print: { command: sent.command, sequence_id: sent.sequence_id, result: 'success' } })] });
    await f.emit({ type: 'message', args: ['a', JSON.stringify({ print: { command: 'push_status', msg: 1,
      device: { extruder: { state: (1 << 19) | 1, info: [{ id: 0, snow: 0, star: type === 'materials.unload' ? 255 : 0, stat: 0x100 }] } } } })] });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.operations.get(result.operation)).toMatchObject({ value: { operation: { phase: { kind: 'acknowledged' } } } });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await f.emit({ type: 'message', args: ['a', JSON.stringify({ print: { command: 'push_status', msg: 1,
      device: { extruder: { state: 1, info: [{ id: 0, snow: type === 'materials.unload' ? 255 : 0, stat: 0x20 }] } } } })] });
    expect(f.operations.get(result.operation)).toMatchObject({ value: { operation: { phase: { kind: 'completed', confirmation: 'observed-state' } } } });
    expect(f.commands()).toHaveLength(1);
  } finally { await f.close(); vi.useRealTimers(); }
});
it('retains the thirty-second completion bound for ordinary commands', async () => {
  const f = fixture('default');
  try {
    await f.monitor.start(target, 'view'); await f.push();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const result = await f.operations.submit(request());
    if (result.kind !== 'recorded') throw new Error('Not recorded');
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.operations.get(result.operation)).toMatchObject({ value: { operation: { phase: { kind: 'outcome-unknown' } } } });
    expect(f.commands()).toHaveLength(1);
  } finally { await f.close(); vi.useRealTimers(); }
});
const acceptanceCommands: D.PrinterCommand[] = [
  ...(['x', 'y', 'z'] as const).map(axis => ({ type: 'motion.jog' as const, params: { motionGroupId: 'gantry' as D.Id<'motion'>, axis, kind: 'step' as const, stepId: 'small', direction: 'positive' as const } })),
  { type: 'motion.home', params: { motionGroupId: 'gantry' as D.Id<'motion'>, axes: ['x', 'y', 'z'] } },
  { type: 'extrusion.move', params: { extruderId: 'extruder:0' as D.Id<'extruder'>, distanceMm: 10, speed: { kind: 'device-controlled' } } },
  { type: 'hardware.refreshNozzles', params: {} },
];
async function prepareIdle(f: ReturnType<typeof fixture>) {
  await f.monitor.start(target, 'view');
  await new Promise<void>(resolve => setImmediate(resolve));
  await f.emit({ type: 'message', args: ['a', JSON.stringify({ print: { command: 'push_status', msg: 0, gcode_state: 'IDLE', home_flag: 7,
    fun: ((1n << 32n) | (1n << 38n)).toString(16),
    device: { extruder: { state: 1, info: [{ id: 0, temp: 220, snow: 0, star: 0, stat: 0 }] } },
    ams: { tray_exist_bits: '1', ams: [{ id: 0, info: '3', tray: [{ id: 0, tray_type: 'PLA', nozzle_temp_min: 190, nozzle_temp_max: 230 }] }] } } })] });
}
it.each(acceptanceCommands)('ends $type tracking on matching ACK without claiming physical completion', async command => {
  const f = fixture('default');
  try {
    await prepareIdle(f);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const stop = vi.spyOn(f.monitor, 'stop');
    const submitted = request({ command });
    const result = await f.operations.submit(submitted);
    if (result.kind !== 'recorded') throw new Error(JSON.stringify(result));
    const sent = f.commands()[0];
    const ack = (device: string, sequence = sent.sequence_id, name = sent.command) => f.emit({ type: 'message', args: [device,
      JSON.stringify({ print: { command: name, sequence_id: sequence, result: 'success' } })] });
    await ack('b'); await ack('a', 'wrong-sequence'); await ack('a', sent.sequence_id, 'wrong-command');
    expect(f.operations.get(result.operation)).toMatchObject({ value: { operation: { phase: { kind: 'sent' } } } });
    expect(stop).not.toHaveBeenCalled();
    await ack('a');
    const accepted = f.operations.get(result.operation);
    expect(accepted).toMatchObject({ value: { operation: { phase: { kind: 'accepted' } } } });
    expect(stop).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalledWith('view');
    await vi.advanceTimersByTimeAsync(30_001);
    await ack('a'); f.operations.close();
    expect(f.operations.get(result.operation)).toEqual(accepted);
    expect(stop).toHaveBeenCalledOnce();
    expect(await f.operations.submit(submitted)).toEqual(result);
    expect(f.commands()).toHaveLength(1);
  } finally { await f.close(); vi.useRealTimers(); }
});
it.each(['missing', 'fail'] as const)('does not accept a jog with %s ACK', async response => {
  const f = fixture('default');
  try {
    await prepareIdle(f);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const result = await f.operations.submit(request({ command: acceptanceCommands[0] }));
    if (result.kind !== 'recorded') throw new Error(JSON.stringify(result));
    const sent = f.commands()[0];
    if (response === 'fail') await f.emit({ type: 'message', args: ['a', JSON.stringify({ print: { command: sent.command, sequence_id: sent.sequence_id, result: 'fail' } })] });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.operations.get(result.operation)).toMatchObject({ value: { operation: { phase: { kind: response === 'fail' ? 'failed' : 'outcome-unknown' } } } });
    expect(f.commands()).toHaveLength(1);
  } finally { await f.close(); vi.useRealTimers(); }
});

it('sends the legacy error acknowledgement and UI close once, with independent sequences and request deduplication', async () => {
  const f = fixture(); try {
    await f.monitor.start(target, 'view');
    await f.push();
    await f.emit({ type: 'message', args: ['a', JSON.stringify({ print: { command: 'push_status', msg: 0, gcode_state: 'PAUSE', subtask_id: '88', job_id: '77', print_error: 0x07018004 } })] });
    const context = await f.monitor.context(target); if (!context.ok) throw new Error('No context');
    const confirm = context.value.values.alerts[0].actions.find(a => a.label === 'Confirm')!;
    const input = request({ command: { type: 'actions.invoke', params: { actionRef: confirm.actionRef } } });
    const result = await f.operations.submit(input); expect(result.kind).toBe('recorded');
    const sent = () => vi.mocked(f.native.sendMessage).mock.calls.map(call => JSON.parse(call[1])).filter(p => p.print?.command === 'clean_print_error' || p.system?.command === 'uiop');
    expect(sent()).toHaveLength(2);
    expect(sent()[0].print).toMatchObject({ command: 'clean_print_error', print_error: 0x07018004, subtask_id: '88' });
    expect(sent()[1].system).toMatchObject({ command: 'uiop', name: 'print_error', action: 'close', err: '07018004' });
    expect(sent()[0].print.sequence_id).not.toBe(sent()[1].system.sequence_id);
    expect(await f.operations.submit(input)).toEqual(result);
    expect(sent()).toHaveLength(2);
    await f.emit({ type: 'message', args: ['a', JSON.stringify({ print: { command: 'push_status', msg: 1, print_error: 0 } })] });
    expect(await f.operations.submit({ ...input, requestId: 'stale' as D.Id<'request'> })).toMatchObject({ kind: 'rejected', error: { code: 'stale-context' } });
    expect(sent()).toHaveLength(2);
  } finally { await f.close(); }
});
