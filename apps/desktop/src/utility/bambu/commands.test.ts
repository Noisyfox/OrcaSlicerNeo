import { expect, it } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import { BambuTelemetry } from './telemetry';
import { commandCapabilities, prepareCommand, type CommandContext } from './commands';
import { BambuRecovery } from './recovery';
const target = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:agent' as D.Id<'route'> };
const identity: D.PrinterIdentity = { id: target.printerId, displayName: 'Printer', manufacturer: 'Bambu Lab', model: 'H2D', serialNumber: 'a', externalRefs: [] };
function fixture(patch = {}, model: string | null = 'H2D') {
  const telemetry = new BambuTelemetry(() => 100);
  telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 0, gcode_state: 'IDLE', home_flag: 7, fun: ((1n << 32n) | (1n << 38n) | (1n << 39n)).toString(16),
    lights_report: [{ node: 'chamber_light', mode: 'off' }], device: { bed_temp: 30, extruder: { state: 2, info: [{ id: 0, temp: 220, snow: 0, star: 0, stat: 0 }, { id: 1, temp: 25, snow: 255, star: 255, stat: 0 }] } },
    ams: { tray_exist_bits: '1', ams: [{ id: 0, info: '3', tray: [{ id: 0, tray_type: 'PLA', nozzle_temp_min: 190, nozzle_temp_max: 230 }] }] }, ...patch } }));
  const context = (): CommandContext => ({ ...telemetry.project(target, identity), target, configurationRevision: 'r1', model });
  return { telemetry, context };
}
it('derives targets from reports and only defaults H2D protocol limits, not attached hardware', () => {
  const f = fixture(); const c = commandCapabilities(f.context());
  expect(c.commands['thermal.setTarget']).toMatchObject({ kind: 'supported', constraints: [{ heaterId: 'nozzle:1', targetC: { max: 350 } }, { heaterId: 'nozzle:0', targetC: { max: 350 } }, { heaterId: 'bed', targetC: { max: 120 } }] });
  expect(c.commands['motion.jog']).toMatchObject({ kind: 'supported', constraints: [{ kind: 'step', axis: 'x' }, { kind: 'step', axis: 'y' }, { kind: 'step', axis: 'z' }] });
  expect(c.commands['materials.load']).toMatchObject({ kind: 'supported', constraints: { pathIds: ['path:0:0:0'] } });
  f.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1, nozzle_temp_range: [0, 300], support_refresh_nozzle: false } }));
  expect(commandCapabilities(f.context()).commands['thermal.setTarget']).toMatchObject({ constraints: [{ targetC: { max: 300 } }, { targetC: { max: 300 } }, {}] });
  expect(commandCapabilities(f.context()).commands['hardware.refreshNozzles'].kind).toBe('unsupported');
  const unknown = fixture({}, 'unknown').context(); expect(prepareCommand(unknown, { type: 'thermal.setTarget', params: { heaterId: 'nozzle:0' as never, targetC: 200 } })).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
});
it('maps independent tool, bed, light and firmware-step commands without discarding request parameters', () => {
  const context = fixture().context();
  expect(prepareCommand(context, { type: 'thermal.setTarget', params: { heaterId: 'nozzle:1' as never, targetC: 240 } })).toMatchObject({ ok: true, value: { fields: { command: 'set_nozzle_temp', extruder_index: 1, target_temp: 240 } } });
  expect(prepareCommand(context, { type: 'thermal.setTarget', params: { heaterId: 'bed' as never, targetC: 60 } })).toMatchObject({ ok: true, value: { fields: { command: 'set_bed_temp', temp: 60 } } });
  expect(prepareCommand(context, { type: 'lights.set', params: { lightId: 'chamber_light' as never, on: true } })).toMatchObject({ ok: true, value: { section: 'system', fields: { led_node: 'chamber_light', led_mode: 'on' } } });
  expect(prepareCommand(context, { type: 'motion.jog', params: { motionGroupId: 'gantry' as never, axis: 'z', kind: 'step', stepId: 'large', direction: 'negative' } })).toMatchObject({ ok: true, value: { fields: { command: 'xyz_ctrl', axis: 'Z', dir: -1, mode: 1 } } });
  expect(prepareCommand(context, { type: 'motion.jog', params: { motionGroupId: 'gantry' as never, axis: 'z', kind: 'distance', distanceMm: 3, speedMmPerSecond: 5 } })).toMatchObject({ ok: false });
});
it('blocks motion before dispatch when unhomed, busy, cold, stale, or in a non-FDM processing task', () => {
  const jog: D.PrinterCommand = { type: 'motion.jog', params: { motionGroupId: 'gantry' as never, axis: 'z', kind: 'step', stepId: 'small', direction: 'positive' } };
  expect(prepareCommand(fixture({ home_flag: 3 }).context(), jog)).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
  expect(prepareCommand(fixture({ gcode_state: 'RUNNING' }).context(), jog)).toMatchObject({ ok: false, error: { code: 'busy' } });
  expect(prepareCommand(fixture({ job_attr: 32 }).context(), jog)).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
  const f = fixture(); f.telemetry.invalidate(); expect(prepareCommand(f.context(), jog)).toMatchObject({ ok: false, error: { code: 'offline' } });
  const extrusion: D.PrinterCommand = { type: 'extrusion.move', params: { extruderId: 'extruder:0' as never, distanceMm: 10, speed: { kind: 'device-controlled' } } };
  expect(prepareCommand(fixture().context(), extrusion)).toMatchObject({ ok: true, value: { fields: { command: 'set_extrusion_length', extruder_index: 0, length: 10 } } });
  const cold = fixture(); cold.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1, device: { extruder: { info: [{ id: 0, temp: 100, snow: 0, stat: 0 }] } } } }));
  expect(prepareCommand(cold.context(), extrusion)).toMatchObject({ ok: false, error: { message: expect.stringContaining('190') } });
});
it('constructs material temperature mapping privately and rejects absent/empty paths', () => {
  const command: D.PrinterCommand = { type: 'materials.load', params: { pathId: 'path:0:0:0' as never } };
  expect(prepareCommand(fixture().context(), command)).toMatchObject({ ok: true, value: { fields: { command: 'ams_change_filament', curr_temp: 210, tar_temp: 210, ams_id: 0, slot_id: 0, target: 0 } } });
  expect(prepareCommand(fixture({ ams: { tray_exist_bits: '0', ams: [{ id: 0, info: '3', tray: [{ id: 0 }] }] } }).context(), command)).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
  expect(prepareCommand(fixture().context(), { type: 'materials.load', params: { pathId: 'path:99:0:0' as never } })).toMatchObject({ ok: false, error: { code: 'invalid-target' } });
});
it.each([[255, 0, 210], [254, 1, 250]])('encodes external holder %i like Orca without confusing its logical path', (unit, tool, temperature) => {
  const f = fixture({ vir_slot: [
    { id: '254', tray_type: 'PETG', nozzle_temp_min: 240, nozzle_temp_max: 260 },
    { id: '255', tray_type: 'PLA', nozzle_temp_min: 200, nozzle_temp_max: 220 },
  ] });
  const pathId = `path:${unit}:0:${tool}` as D.Id<'path'>;
  const result = prepareCommand(f.context(), { type: 'materials.load', params: { pathId } });
  expect(result).toMatchObject({ ok: true, value: { fields: { command: 'ams_change_filament', curr_temp: temperature, tar_temp: temperature, ams_id: 255, slot_id: 0, target: 255 } } });
  if (!result.ok) throw new Error('Expected external load');
  expect(result.value.fields).not.toHaveProperty('extruder_id');
  const reportLoaded = (reportedUnit: number) => f.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1,
    device: { extruder: { info: [{ id: tool, temp: 25, snow: reportedUnit << 8, star: reportedUnit << 8, stat: 0 }] } } } }));
  reportLoaded(unit === 255 ? 254 : 255);
  expect(result.value.confirmed!(f.context())).toBe(false);
  reportLoaded(unit);
  expect(result.value.confirmed!(f.context())).toBe(true);
  const unload = prepareCommand(f.context(), { type: 'materials.unload', params: { toolId: `tool:${tool}` as D.Id<'tool'> } });
  expect(unload).toMatchObject({ ok: true, value: { fields: { ams_id: 255, slot_id: 255, target: 255, curr_temp: 210, tar_temp: 210 } } });
  if (!unload.ok) throw new Error('Expected external unload');
  expect(unload.value.confirmed!(f.context())).toBe(false);
  f.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1, device: { extruder: { info: [{ id: tool, snow: (unit << 8) | 255, stat: 0 }] } } } }));
  expect(unload.value.confirmed!(f.context())).toBe(true);
});
it('uses external spool sentinels without borrowing another holder or legacy metadata', () => {
  const context = fixture({ vir_slot: [{ id: 254 }], vt_tray: { nozzle_temp_min: 200, nozzle_temp_max: 220 } }).context();
  expect(prepareCommand(context, { type: 'materials.load', params: { pathId: 'path:254:0:1' as D.Id<'path'> } })).toMatchObject({ ok: true, value: { fields: { curr_temp: -1, tar_temp: -1 } } });
  expect(prepareCommand(context, { type: 'materials.load', params: { pathId: 'path:255:0:0' as D.Id<'path'> } })).toMatchObject({ ok: false, error: { code: 'invalid-target' } });
  expect(prepareCommand(fixture({ vt_tray: { nozzle_temp_min: 200, nozzle_temp_max: 220 } }).context(),
    { type: 'materials.load', params: { pathId: 'path:255:0:0' as D.Id<'path'> } })).toMatchObject({ ok: true, value: { fields: { curr_temp: 210, tar_temp: 210 } } });
});
it('allows only current error-episode recovery references and suppresses abort during a print', () => {
  const f = fixture(); const recovery = new BambuRecovery();
  f.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1, device: { extruder: { state: 3 << 12 } } } }));
  const context = recovery.decorate(f.context()); const action = context.values.alerts.find(alert => alert.id === 'tool-switch')!.actions[0];
  expect(prepareCommand(context, { type: 'actions.invoke', params: { actionRef: action.actionRef } })).toMatchObject({ ok: true, value: { fields: { command: 'ams_control', param: 'resume' } } });
  f.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1, device: { extruder: { state: 0 } } } })); recovery.decorate(f.context());
  f.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1, gcode_state: 'PAUSE', device: { extruder: { state: 3 << 12 } } } }));
  const next = recovery.decorate(f.context()); expect(next.recovery).toHaveLength(1);
  expect(prepareCommand(next, { type: 'actions.invoke', params: { actionRef: action.actionRef } })).toMatchObject({ ok: false, error: { code: 'stale-context' } });
});
it('uses reported fan limits instead of assuming every fan allows the full range', () => {
  const context = fixture({ device: { airduct: { parts: [{ id: 16, state: 52, range: (80 << 16) | 20 }] } } }).context();
  expect(commandCapabilities(context).commands['fans.setSpeed']).toMatchObject({ constraints: [{ fanId: 'fan:1', speedFraction: { min: 0.2, max: 0.8 } }] });
  expect(prepareCommand(context, { type: 'fans.setSpeed', params: { fanId: 'fan:1' as never, speedFraction: 1 } })).toMatchObject({ ok: false, error: { code: 'out-of-range' } });
});

it('allows motion on Orca explicit-zero home flag but blocks missing and unset axis bits', () => {
  const jog: D.PrinterCommand = { type: 'motion.jog', params: { motionGroupId: 'gantry' as never, axis: 'x', direction: 'positive', kind: 'step', stepId: 'small' } };
  expect(prepareCommand(fixture({ home_flag: 0 }).context(), jog)).toMatchObject({ ok: true });
  expect(prepareCommand(fixture({ home_flag: 6 }).context(), jog)).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
  expect(prepareCommand(fixture({ home_flag: undefined }).context(), jog)).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
});

it('confirms same-task cancellation and treats the cancelled task as inactive', () => {
  const f = fixture({ gcode_state: 'RUNNING', subtask_id: 'cube' });
  const cancel = prepareCommand(f.context(), { type: 'jobs.cancel', params: {} });
  if (!cancel.ok) throw new Error('Expected cancel command');
  f.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1, gcode_state: 'FAILED', print_error: 0x0300400c, subtask_id: 'other' } }));
  expect(cancel.value.confirmed!(f.context())).toBe(false);
  f.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1, subtask_id: 'cube' } }));
  expect(cancel.value.confirmed!(f.context())).toBe(true);
  expect(prepareCommand(f.context(), { type: 'jobs.cancel', params: {} })).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
  expect(prepareCommand(f.context(), { type: 'motion.home', params: { motionGroupId: 'gantry' as D.Id<'motion'>, axes: ['x', 'y', 'z'] } })).toMatchObject({ ok: true });
  f.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1, device: { extruder: { state: 3 << 12 } } } }));
  const recovered = new BambuRecovery().decorate(f.context());
  expect(recovered.recovery?.map(item => item.kind)).toEqual(['resume', 'abort']);
});

it('advertises camera delivery only from reported protocols and includes it in capability revision', () => {
  const capabilities = (ipcam: object) => commandCapabilities(fixture({ ipcam }).context());
  expect(capabilities({}).cameras[0].liveView).toMatchObject({ kind: 'unknown' });
  expect(capabilities({ ipcam_dev: '0' }).cameras[0].liveView).toMatchObject({ kind: 'unsupported', layer: 'device' });
  expect(capabilities({ liveview: { local: 'disabled' } }).cameras[0].liveView).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining('disabled') });
  expect(capabilities({ liveview: { local: 'rtsp' } }).cameras[0].liveView).toMatchObject({ kind: 'unsupported', layer: 'adapter' });
  const jpeg = capabilities({ liveview: { local: 'local' } }), avc = capabilities({ rtsp_url: 'rtsps://private' });
  expect(jpeg.cameras[0].liveView).toMatchObject({ kind: 'supported', constraints: { transports: ['jpeg-frames'], maxConcurrentViews: 1, requestIdRetentionMs: 300000 } });
  expect(avc.cameras[0].liveView).toMatchObject({ kind: 'supported', constraints: { transports: ['mse-fmp4'] } });
  expect(avc.revision).not.toBe(jpeg.revision); expect(JSON.stringify(avc)).not.toContain('private');
});
