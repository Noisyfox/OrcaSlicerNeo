import { describe, expect, it } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import { BambuTelemetry } from './telemetry';
const target: D.PrinterTarget = { printerId: 'printer' as D.Id<'printer'>, routeId: 'cloud' as D.Id<'route'> };
const identity: D.PrinterIdentity = { id: target.printerId, displayName: 'Printer', manufacturer: 'Bambu Lab', model: 'H2D', serialNumber: null, externalRefs: [] };
const push = (print: object) => JSON.stringify({ print: { command: 'push_status', ...print } });
const model = (time = 100) => { let now = time; return { telemetry: new BambuTelemetry(() => now), tick: (ms: number) => { now += ms; } }; };
const report = () => ({ msg: 0, gcode_state: 'RUNNING', subtask_id: 'external-task', subtask_name: 'Test', mc_percent: 30, mc_remaining_time: 12,
  layer_num: 10, total_layer_num: 100, spd_lvl: 2, home_flag: 7,
  device: { extruder: { state: 0x12, info: [{ id: 0, temp: (220 << 16) | 215, hnow: 0, snow: 2, star: 2, stat: 0 }, { id: 1, temp: (230 << 16) | 225, hnow: 1, snow: 0x0103, star: 0x0103, stat: 0 }] },
    nozzle: { info: [{ id: 0x10, type: '0S01', diameter: 0.4 }, { id: 0x11, type: '0H01', diameter: 0.6 }] }, bed_temp: (65 << 16) | 60 },
  ams: { tray_exist_bits: '84', ams: [{ id: '0', info: '1', tray: [{ id: '2', tray_type: 'PLA', tray_color: 'FF0000FF', remain: 40 }] },
    { id: '1', info: '103', temp: '40.2', humidity: '2', humidity_raw: '25', dry_time: 65, tray: [{ id: '3', tray_type: 'PETG' }] }] } });

describe('Bambu telemetry normalization', () => {
  it('rejects a delta without a full baseline and never converts absent values to zero', () => {
    const { telemetry } = model();
    expect(telemetry.accept(push({ msg: 1, mc_percent: 50 }))).toBe('resync');
    expect(telemetry.snapshot(target, identity, 'r', ['status']).values.status.kind).toBe('unknown');
    telemetry.accept(push({ msg: 0, gcode_state: 'PAUSE' }));
    const status = telemetry.project(target, identity).values.status;
    expect(status.printStatus.phase).toMatchObject({ value: 'paused' });
    expect(status.printStatus.progressFraction.kind).toBe('unknown');
    expect(status.printStatus.taskId.kind).toBe('unknown');
  });
  it('reconstructs nested object deltas, replaces arrays and discards the old full snapshot', () => {
    const { telemetry } = model(); telemetry.accept(push(report()));
    telemetry.accept(push({ msg: 1, device: { bed_temp: (70 << 16) | 61 } }));
    expect(telemetry.project(target, identity).values.thermal).toContainEqual(expect.objectContaining({ heaterId: 'bed', targetC: expect.objectContaining({ value: 70 }) }));
    expect(telemetry.project(target, identity).values.descriptor.topology.tools).toHaveLength(2);
    telemetry.accept(push({ msg: 1, ams: { ams: [] } }));
    expect(telemetry.project(target, identity).values.materials.topology.units).toEqual([]);
    telemetry.accept(push({ msg: 0, gcode_state: 'IDLE' }));
    expect(telemetry.project(target, identity).values.thermal).toEqual([]);
  });
  it('normalizes independently addressed nozzles, dynamic slots and paths to each tool', () => {
    const { telemetry } = model(); telemetry.accept(push(report())); const result = telemetry.project(target, identity);
    expect(result.values.thermal.map(item => [item.heaterId, item.targetC.kind === 'known' && item.targetC.value])).toEqual([['nozzle:0', 220], ['nozzle:1', 230], ['bed', 65]]);
    expect(result.values.status.activeToolIds).toMatchObject({ value: ['tool:1'] });
    expect(result.values.materials.topology.paths).toEqual([
      { id: 'path:0:2:0', slotId: 'slot:0:2', toolId: 'tool:0', loading: 'automatic' },
      { id: 'path:1:3:1', slotId: 'slot:1:3', toolId: 'tool:1', loading: 'automatic' },
    ]);
    expect(result.values.materials.state.tools[1].loadedPathId).toMatchObject({ value: 'path:1:3:1' });
    expect(result.values.descriptor.topology.nozzles[1]).toMatchObject({ diameterMm: 0.6, constructionMaterial: 'hardened steel', flowType: 'high flow' });
  });
  it('keeps humidity grades distinct from percentages and reports dryer minutes as seconds', () => {
    const { telemetry } = model(); telemetry.accept(push(report())); const result = telemetry.project(target, identity).values;
    expect(result.sensors.definitions).toContainEqual(expect.objectContaining({ id: 'ams:1:humidity', kind: 'numeric', unit: null }));
    expect(result.sensors.definitions).toContainEqual(expect.objectContaining({ id: 'ams:1:humidity_raw', kind: 'relativeHumidity', unit: 'percent' }));
    expect(result.materials.state.dryers[0].remainingSeconds).toMatchObject({ value: 3900 });
  });
  it('does not infer filament presence from remembered metadata or guess an unbound feed path', () => {
    const { telemetry } = model(); const raw = report(); delete (raw.ams as Partial<typeof raw.ams>).tray_exist_bits;
    raw.ams.ams[0].info = 'e01'; telemetry.accept(push(raw)); const result = telemetry.project(target, identity).values.materials;
    expect(result.state.slots[0].presence.kind).toBe('unknown');
    expect(result.state.slots[0].material).toMatchObject({ value: { materialType: 'PLA' } });
    expect(result.topology.paths.some(path => path.slotId === 'slot:0:2')).toBe(false);
  });
  it('allows multiple reported feed targets only for a ready transfer mechanism', () => {
    const { telemetry } = model(); const raw = { ...report(), aux: '20000000' }; raw.ams.ams[0].info = 'e01';
    telemetry.accept(push(raw));
    expect(telemetry.project(target, identity).values.materials.topology.paths.filter(path => path.slotId === 'slot:0:2')).toHaveLength(2);
    telemetry.accept(push({ msg: 1, aux: '0' }));
    expect(telemetry.project(target, identity).values.materials.topology.paths.filter(path => path.slotId === 'slot:0:2')).toHaveLength(0);
  });
  it('ages retained readings and requires a new baseline after disconnection', () => {
    const { telemetry, tick } = model(); telemetry.accept(push(report())); const rev = telemetry.project(target, identity).values.descriptor.topology.revision;
    tick(16_000); expect(telemetry.project(target, identity).fresh).toBe(false);
    expect(telemetry.project(target, identity).values.status.printStatus.phase).toMatchObject({ value: 'printing', freshness: 'stale' });
    expect(telemetry.project(target, identity).values.descriptor.topology.revision).toBe(rev);
    telemetry.invalidate(); expect(telemetry.accept(push({ msg: 1, mc_percent: 70 }))).toBe('resync');
    telemetry.accept(push(report())); expect(telemetry.project(target, identity).fresh).toBe(true);
  });
  it('does not reuse progress or layer data across task changes and ignores control replies', () => {
    const { telemetry } = model(); telemetry.accept(push(report()));
    expect(telemetry.accept(JSON.stringify({ print: { command: 'pause', result: 'success' } }))).toBe('ignored');
    telemetry.accept(push({ msg: 1, subtask_id: 'next-task' })); const status = telemetry.project(target, identity).values.status.printStatus;
    expect(status.taskId).toMatchObject({ value: 'next-task' }); expect(status.currentLayer.kind).toBe('unknown'); expect(status.progressFraction.kind).toBe('unknown');
    expect(telemetry.snapshot(target, identity, 'r', ['thermal']).values).not.toHaveProperty('status');
  });
  it('ignores malformed packets and prototype keys', () => {
    const { telemetry } = model(); expect(telemetry.accept('{')).toBe('ignored');
    telemetry.accept('{"print":{"command":"push_status","msg":0,"__proto__":{"polluted":true}}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(telemetry.project(target, identity).values.status.printStatus.phase.kind).toBe('unknown');
  });
});
