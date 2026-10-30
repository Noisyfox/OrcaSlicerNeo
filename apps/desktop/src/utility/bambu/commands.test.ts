import { expect, it } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import { BambuTelemetry } from './telemetry';
import { commandCapabilities, prepareCommand, type CommandContext } from './commands';
import { BambuRecovery } from './recovery';
import { printErrorResource } from './errorResources';
const target = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:agent' as D.Id<'route'> };
const identity: D.PrinterIdentity = { id: target.printerId, displayName: 'Printer', manufacturer: 'Bambu Lab', model: 'H2D', serialNumber: 'a', externalRefs: [] };
function fixture(patch = {}, model: string | null = 'H2D', serialNumber = 'a') {
  const telemetry = new BambuTelemetry(() => 100);
  telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 0, gcode_state: 'IDLE', home_flag: 7, fun: ((1n << 32n) | (1n << 38n) | (1n << 39n)).toString(16),
    lights_report: [{ node: 'chamber_light', mode: 'off' }], device: { bed_temp: 30, extruder: { state: 2, info: [{ id: 0, temp: 220, snow: 0, star: 0, stat: 0 }, { id: 1, temp: 25, snow: 255, star: 255, stat: 0 }] } },
    ams: { tray_exist_bits: '1', ams: [{ id: 0, info: '3', tray: [{ id: 0, tray_type: 'PLA', nozzle_temp_min: 190, nozzle_temp_max: 230 }] }] }, ...patch } }));
  const context = (): CommandContext => ({ ...telemetry.project(target, { ...identity, serialNumber }), target, configurationRevision: 'r1', model });
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
  expect(recovered.recovery?.map(item => item.command.fields.param)).toEqual(['resume', 'abort']);
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
it('confirms a speed command from a cfg delta overriding the old spd_lvl', () => {
  const f = fixture({ gcode_state: 'RUNNING', subtask_id: 'task-1', spd_lvl: 2 });
  const result = prepareCommand(f.context(), { type: 'jobs.setSpeed', params: { modeId: '3' } });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.confirmed!(f.context())).toBe(false);
  f.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1, cfg: '300' } }));
  expect(result.value.confirmed!(f.context())).toBe(true);
});

it('uses the pinned serial-prefix error catalog and distinct Orca ignore/resume/close commands', () => {
  const f = fixture({ print_error: 0x0500808f, gcode_state: 'PAUSE', job_id: '9876543210987654', subtask_id: '123' }, 'O1D', '239fixture');
  const recovery = new BambuRecovery();
  const context = recovery.decorate(f.context());
  const alert = context.values.alerts[0];
  expect(alert).toMatchObject({ code: '0500808F', severity: 'warning', message: expect.stringContaining('Nozzle camera lens is dirty'), dialog: { title: 'Warning', dismissible: true } });
  expect(alert.actions.map(a => a.label)).toEqual(['Problem Solved and Resume', 'Ignore this and Resume']);
  for (const [index, command] of [[0, 'resume'], [1, 'ignore']] as const) {
    expect(prepareCommand(context, { type: 'actions.invoke', params: { actionRef: alert.actions[index].actionRef } })).toMatchObject({ ok: true, value: { section: 'print', qos: 1, fields: { command, err: String(0x0500808f), param: 'reserve', job_id: '9876543210987654' } } });
  }
  expect(prepareCommand(context, { type: 'actions.invoke', params: { actionRef: alert.dialog!.dismissAction!.actionRef } })).toMatchObject({ ok: true, value: { section: 'system', qos: 0, fields: { command: 'uiop', name: 'print_error', action: 'close', source: 1, type: 'dialog', err: '0500808F' } } });
  expect(recovery.decorate(f.context()).values.alerts[0]).toEqual(alert);
  // A temperature-only delta must retain both the error episode and the error's job ID.
  f.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1, nozzle_temper: 140 } }));
  expect(recovery.decorate(f.context()).values.alerts[0]).toEqual(alert);
  f.telemetry.invalidate();
  const stale = recovery.decorate(f.context());
  expect(stale.values.alerts[0].actions.every(a => a.availability.kind === 'blocked')).toBe(true);
  expect(prepareCommand(stale, { type: 'actions.invoke', params: { actionRef: alert.actions[0].actionRef } })).toMatchObject({ ok: false, error: { code: 'offline' } });
});
it('invalidates error references when the error clears, recurs, or moves to another job', () => {
  const f = fixture({ print_error: 0x0500808f, gcode_state: 'PAUSE', job_id: '1', subtask_id: '10' }, 'O1D', '239fixture');
  const recovery = new BambuRecovery();
  const first = recovery.decorate(f.context()).values.alerts[0];
  const invoke: D.PrinterCommand = { type: 'actions.invoke', params: { actionRef: first.actions[0].actionRef } };
  const update = (patch: object) => { f.telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 1, ...patch } })); return recovery.decorate(f.context()); };
  expect(prepareCommand(update({ job_id: '2' }), invoke)).toMatchObject({ ok: false, error: { code: 'stale-context' } });
  expect(update({ print_error: 0 }).values.alerts).toEqual([]);
  const again = update({ print_error: 0x0500808f });
  expect(again.values.alerts[0].id).not.toBe(first.id);
  expect(prepareCommand(again, invoke)).toMatchObject({ ok: false, error: { code: 'stale-context' } });
  expect(prepareCommand(again, { type: 'actions.invoke', params: { actionRef: { ...again.values.alerts[0].actions[0].actionRef, routeId: 'other' as D.Id<'route'> } } })).toMatchObject({ ok: false, error: { code: 'stale-context' } });
});
it('never borrows another printer family catalog and preserves cancellation as an informational outcome', () => {
  expect(printErrorResource('31Bfixture', 0x0500808c)?.message).toBe('Detected build plate offset or debris. Please align the build plate with the heatbed and remove all debris from the plate surface before continuing.');
  const context = new BambuRecovery().decorate(fixture({ print_error: 0x0500808f }, 'O1D', 'unknown').context());
  expect(context.values.alerts[0]).toMatchObject({ code: '0500808F', message: 'Unknown error.', actions: [], dialog: { dismissible: true } });
  const cancelled = new BambuRecovery().decorate(fixture({ print_error: 0x0300400c, gcode_state: 'FAILED' }, 'O1D', '239fixture').context());
  expect(cancelled.values.alerts[0]).toMatchObject({ severity: 'info', message: 'The task was canceled.' });
  expect(cancelled.values.alerts[0].dialog).toBeUndefined();
});

it.each([
  [0x03008003, 'Stop Printing', { command: 'stop', err: String(0x03008003), job_id: '77', param: 'reserve' }, 1],
  [0x07fec00a, 'Filament Extruded, Continue', { command: 'ams_control', param: 'done' }, 0],
  [0x07fec00a, 'Not Extruded Yet, Retry', { command: 'ams_control', param: 'resume' }, 0],
  [0x18ff8004, 'Finished, Continue', { command: 'ams_control', param: 'resume' }, 0],
  [0x05024003, 'OK', { command: 'clean_print_error', subtask_id: '88', print_error: 0x05024003 }, 0],
  [0x05ff8081, 'No Reminder Next Time', { command: 'idle_ignore', err: String(0x05ff8081), type: 0 }, 1],
  [0x05ff8080, 'Recheck', { command: 'refresh_nozzle' }, 1],
  [0x03008044, 'Got it, Turn off the Fire Alarm.', { command: 'buzzer_ctrl', mode: 0 }, 1],
  [0x0502c010, 'Stop Drying', { command: 'auto_stop_ams_dry' }, 0],
] as const)('encodes catalog error %i action %s as Orca does', (print_error, label, fields, qos) => {
  const context = new BambuRecovery().decorate(fixture({ print_error, job_id: '77', subtask_id: '88', gcode_state: 'PAUSE' }, 'O1D', '239fixture').context());
  const action = context.values.alerts[0].actions.find(action => action.label === label)!;
  expect(action).toBeDefined();
  expect(prepareCommand(context, { type: 'actions.invoke', params: { actionRef: action.actionRef } })).toMatchObject({ ok: true, value: { fields, section: 'print', qos } });
  expect(action.keepDialogOpen === true).toBe(label === 'Not Extruded Yet, Retry');
});
it('hides internal errors and blocks local-only resumption without blocking stop or closing the dialog', () => {
  const recovery = new BambuRecovery();
  expect(recovery.decorate(fixture({ print_error: 0x0502400c }, 'O1D', '239fixture').context()).values.alerts).toEqual([]);
  const context = recovery.decorate(fixture({ print_error: 0x03008003, job_attr: 32 }, 'O1D', '239fixture').context());
  const alert = context.values.alerts[0];
  const stop = alert.actions.find(a => a.label === 'Stop Printing')!;
  const resume = alert.actions.find(a => a.label.includes('Resume'))!;
  expect(prepareCommand(context, { type: 'actions.invoke', params: { actionRef: stop.actionRef } }).ok).toBe(true);
  expect(prepareCommand(context, { type: 'actions.invoke', params: { actionRef: alert.dialog!.dismissAction!.actionRef } }).ok).toBe(true);
  expect(prepareCommand(context, { type: 'actions.invoke', params: { actionRef: resume.actionRef } })).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
});
