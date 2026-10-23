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
  expect(c.commands['thermal.setTarget']).toMatchObject({ kind: 'supported', constraints: [{ heaterId: 'nozzle:0', targetC: { max: 350 } }, { heaterId: 'nozzle:1', targetC: { max: 350 } }, { heaterId: 'bed', targetC: { max: 120 } }] });
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
