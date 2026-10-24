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
    nozzle: { info: [{ id: 0, type: '0S01', diameter: 0.4 }, { id: 1, type: '0H01', diameter: 0.6 }] }, bed_temp: (65 << 16) | 60 },
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
    expect(result.values.thermal.map(item => [item.heaterId, item.targetC.kind === 'known' && item.targetC.value])).toEqual([['nozzle:1', 230], ['nozzle:0', 220], ['bed', 65]]);
    expect(result.values.status.activeToolIds).toMatchObject({ value: ['tool:1'] });
    expect(result.values.materials.topology.paths).toEqual([
      { id: 'path:0:2:0', slotId: 'slot:0:2', toolId: 'tool:0', loading: 'automatic' },
      { id: 'path:1:3:1', slotId: 'slot:1:3', toolId: 'tool:1', loading: 'automatic' },
    ]);
    expect(result.values.materials.state.tools[1].loadedPathId).toMatchObject({ value: 'path:1:3:1' });
    expect(result.values.descriptor.topology.nozzles.find(n => n.id === 'nozzle:1')).toMatchObject({ diameterMm: 0.6, constructionMaterial: 'hardened steel', flowType: 'high flow' });
  });
  it('maps external unit IDs independently of report order and keeps requested and loaded paths separate', () => {
    const { telemetry } = model();
    telemetry.accept(push({ msg: 0, vir_slot: [{ id: '254', tray_type: 'PETG' }, { id: '255', tray_type: 'PLA' }, { id: '0', tray_type: 'PC' }],
      device: { extruder: { info: [{ id: 0, snow: 0xff00, star: 0xffff, stat: 0 }, { id: 1, snow: 0xfeff, star: 0xfe00, stat: 0 }] } } }));
    const inventory = () => telemetry.project(target, identity).values.materials;
    expect(inventory().topology.units.map(unit => unit.id)).toEqual(['unit:255', 'unit:254']);
    expect(inventory().topology.paths).toEqual([
      { id: 'path:255:0:0', slotId: 'slot:255:0', toolId: 'tool:0', loading: 'automatic' },
      { id: 'path:254:0:1', slotId: 'slot:254:0', toolId: 'tool:1', loading: 'automatic' },
    ]);
    expect(inventory().state.slots).toMatchObject([
      { slotId: 'slot:255:0', material: { value: { materialType: 'PLA' } }, presence: { kind: 'unknown' }, remaining: { kind: 'unknown' } },
      { slotId: 'slot:254:0', material: { value: { materialType: 'PETG' } }, presence: { kind: 'unknown' } },
    ]);
    expect(inventory().state.tools).toMatchObject([
      { toolId: 'tool:0', loadedPathId: { value: 'path:255:0:0' }, selectedPathId: { value: null } },
      { toolId: 'tool:1', loadedPathId: { value: null }, selectedPathId: { value: 'path:254:0:1' } },
    ]);
    telemetry.accept(push({ msg: 1, device: { extruder: { info: [{ id: 0, snow: 0xfe00 }] } } }));
    expect(inventory().topology.paths.map(path => path.id)).toEqual(['path:255:0:0']);
    expect(inventory().state.tools[0].loadedPathId.kind).toBe('unknown');
    telemetry.accept(push({ msg: 1, vir_slot: [] }));
    expect(inventory().topology.units).toEqual([]);
  });
  it('normalizes legacy vt_tray to the main external holder and distinguishes loaded 254 from empty 255', () => {
    const { telemetry } = model();
    telemetry.accept(push({ msg: 0, nozzle_temper: 25, vt_tray: { id: '254', tray_type: 'PLA' }, ams: { tray_now: 254, tray_tar: 255 } }));
    const inventory = () => telemetry.project(target, identity).values.materials;
    expect(inventory().topology.paths.map(path => path.id)).toEqual(['path:255:0:0']);
    expect(inventory().state.tools[0]).toMatchObject({ loadedPathId: { value: 'path:255:0:0' }, selectedPathId: { value: null } });
    telemetry.accept(push({ msg: 1, ams: { tray_now: 255 } }));
    expect(inventory().state.tools[0].loadedPathId).toMatchObject({ value: null });
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
it('uses real H2D toolhead IDs, AMS types and unknown remaining estimates', () => {
  const { telemetry } = model();
  telemetry.accept(push({ msg: 0, gcode_state: 'IDLE', stg_cur: -1,
    device: { extruder: { state: 2, info: [{ id: 0, hnow: 0, temp: 26 }, { id: 1, hnow: 1, temp: 27 }] },
      nozzle: { exist: 3, info: [{ id: 0, type: 'HS01', diameter: 0.4 }, { id: 1, type: 'HS01', diameter: 0.4 }, { id: 0x10, type: 'HH05', diameter: 0.8 }] } },
    ams: { ams: [{ id: '0', info: '11001101', dry_time: 0, tray: [{ id: '0', tray_type: 'PETG-CF', remain: 0 }] },
      { id: '1', info: '10002003', dry_time: 0, tray: [{ id: '0', tray_type: 'PETG', remain: 0 }] }] },
    lights_report: [{ node: 'chamber_light2', mode: 'on' }] }));
  const value = telemetry.project(target, identity).values;
  expect(value.descriptor.topology.nozzles.map(n => [n.diameterMm, n.constructionMaterial, n.flowType])).toEqual([
    [0.4, 'hardened steel', 'standard flow'], [0.4, 'hardened steel', 'standard flow'],
  ]);
  expect(value.status.printStatus.stage).toMatchObject({ kind: 'known', value: null });
  expect(value.materials.topology.units.map(u => u.name)).toEqual(['AMS 0', 'AMS 2 Pro 1']);
  expect(value.materials.topology.dryers.map(d => d.id)).toEqual(['dryer:1']);
  expect(value.materials.state.slots.map(s => s.remaining.kind)).toEqual(['unknown', 'unknown']);
  expect(value.actuators.lights[0].on).toMatchObject({ value: true });
  expect(value.descriptor.topology.lights[0].name).toBe('Chamber light 2');
});
it('reports remaining filament only for enabled RFID estimates, including a real zero', () => {
  const { telemetry } = model();
  const slots = [{ id: 0, tag_uid: 'test-tag', remain: 0 }, { id: 1, tag_uid: '0000', remain: 0 }, { id: 2, tag_uid: 'test-tag', remain: 40 }];
  telemetry.accept(push({ msg: 0, ams: { calibrate_remain_flag: true, ams: [{ id: 0, info: '1', tray: slots }] } }));
  const remaining = () => telemetry.project(target, identity).values.materials.state.slots.map(s => s.remaining);
  expect(remaining()).toMatchObject([{ value: { value: 0 } }, { kind: 'unknown' }, { value: { value: 0.4 } }]);
  telemetry.accept(push({ msg: 1, ams: { calibrate_remain_flag: false } }));
  expect(remaining().map(r => r.kind)).toEqual(['unknown', 'unknown', 'unknown']);
});
it('labels known stages, clears prior layers on idle and handles mixed AMS Lite presence bits', () => {
  const { telemetry } = model();
  telemetry.accept(push({ ...report(), stg_cur: 7, ams: { tray_exist_bits: '4000000', ams: [{ id: 4, info: '5', tray: [{ id: 2, tray_type: 'PLA' }] }] } }));
  const values = telemetry.project(target, identity).values;
  expect(values.status.printStatus.stage).toMatchObject({ value: { code: '7', label: 'Heating nozzle' } });
  expect(values.materials.state.slots[0].presence).toMatchObject({ value: 'present' });
  telemetry.accept(push({ msg: 1, gcode_state: 'IDLE' }));
  expect(telemetry.project(target, identity).values.status.printStatus.currentLayer.kind).toBe('unknown');
});

it('names only reported airduct fans using Orca functions and retains their command identities', () => {
  const { telemetry } = model();
  telemetry.accept(push({ msg: 0, device: { airduct: { parts: [0, 1, 2, 3, 4, 5, 6, 42].map(index => ({ id: index << 4, state: 30 })), modeCur: 0 } } }));
  const value = telemetry.project(target, identity).values;
  expect(value.descriptor.topology.fans.map(f => [f.id, f.name])).toEqual([
    ['fan:0', 'Hotend cooling 0'], ['fan:1', 'Part cooling'], ['fan:2', 'Auxiliary cooling'],
    ['fan:3', 'Chamber exhaust'], ['fan:4', 'Hotend cooling 1'], ['fan:5', 'Mainboard cooling'],
    ['fan:6', 'Chamber heat circulation'], ['fan:42', 'Unknown fan (ID 42)'],
  ]);
  expect(value.actuators.fans.map(f => f.fanId)).toEqual(value.descriptor.topology.fans.map(f => f.id));
  telemetry.accept(push({ msg: 1, device: { airduct: { parts: [{ id: 6 << 4, state: 0 }, { id: (6 << 4) | 1, state: 0 }] } } }));
  expect(telemetry.project(target, identity).values.descriptor.topology.fans.map(f => f.id)).toEqual(['fan:6']);
});

it('follows pinned Orca model/mode/submode fan text and updates topology when labels change', () => {
  const { telemetry } = model();
  const n6identity = { ...identity, model: 'N6' };
  telemetry.accept(push({ msg: 0, device: { airduct: { modeCur: 0, parts: [2, 10].map(index => ({ id: index << 4, state: 0 })) } } }));
  const topology = () => telemetry.project(target, n6identity).values.descriptor.topology;
  expect(topology().fans.map(f => f.name)).toEqual(['Left(Aux)', 'Right(Aux)']);
  const revision = topology().revision;
  telemetry.accept(push({ msg: 1, device: { airduct: { subMode: 1 } } }));
  expect(topology().fans.map(f => f.name)).toEqual(['Left(Aux)', 'Right(Filter)']);
  expect(topology().revision).not.toBe(revision);
  telemetry.accept(push({ msg: 1, device: { airduct: { modeCur: 1 } } }));
  expect(topology().fans.map(f => f.name)).toEqual(['Left(Heating)', 'Right(Filter)']);
  expect(telemetry.project(target, { ...identity, model: 'N7' }).values.descriptor.topology.fans.map(f => f.name)).toEqual(['Right(Filter)', 'Left(Aux)']);
  expect(telemetry.project(target, { ...identity, model: 'unknown-model' }).values.descriptor.topology.fans.map(f => f.name)).toEqual(['Auxiliary cooling', 'Unknown fan (ID 10)']);
  telemetry.accept(push({ msg: 1, device: { airduct: { parts: [] } } }));
  expect(topology().fans).toEqual([]);
});

it.each([false, true])('shows left before right regardless of dual report order (reversed=%s), without retargeting heaters or paths', reversed => {
  const { telemetry } = model(); const raw = report(); if (reversed) raw.device.extruder.info.reverse();
  telemetry.accept(push(raw)); const value = telemetry.project(target, identity).values;
  expect(value.descriptor.topology.tools.map(t => [t.id, t.name, t.nozzleId, t.extruderId])).toEqual([
    ['tool:1', 'Left extruder', 'nozzle:1', 'extruder:1'], ['tool:0', 'Right extruder', 'nozzle:0', 'extruder:0'],
  ]);
  expect(value.descriptor.topology.heaters.filter(h => h.role === 'nozzle').map(h => [h.id, h.name])).toEqual([
    ['nozzle:1', 'Left nozzle'], ['nozzle:0', 'Right nozzle'],
  ]);
  expect(value.sensors.definitions.filter(s => s.location?.startsWith('nozzle:')).map(s => s.name)).toEqual(['Left nozzle', 'Right nozzle']);
  expect(value.materials.topology.paths.map(p => p.toolId)).toEqual(['tool:0', 'tool:1']);
  telemetry.accept(push({ msg: 1, device: { extruder: { info: [{ id: 0, temp: 25 }] } } }));
  expect(telemetry.project(target, identity).values.descriptor.topology.tools.map(t => t.name)).toEqual(['Tool 0']);
  telemetry.accept(push({ msg: 1, device: { extruder: { info: [{ id: 5 }, { id: 9 }] } } }));
  expect(telemetry.project(target, identity).values.descriptor.topology.tools.map(t => t.name)).toEqual(['Tool 5', 'Tool 9']);
});
