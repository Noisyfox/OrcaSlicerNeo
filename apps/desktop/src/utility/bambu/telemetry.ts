/** Host-private normalization of Orca DeviceManager / DeviceCore push reports. */
import { stageLabel } from './stages';
import n6 from '../../../../../packages/slicer-wasm/cpp/resources/printers/N6.json';
import n7 from '../../../../../packages/slicer-wasm/cpp/resources/printers/N7.json';
import type * as D from '@orca/printer-control/domain';

export type Report = Record<string, unknown>;
export const record = (value: unknown): Report => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Report : {};
export const records = (value: unknown): Report[] => Array.isArray(value) ? value.map(record) : [];
export const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : undefined;
export const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
export const identifier = (value: unknown): string | undefined => typeof value === 'string' && /^\d+$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
export const id = <K extends string>(value: string) => value as D.Id<K>;
export const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
export function bits(value: unknown, offset: number, width = 1): number | undefined {
  try {
    const raw = typeof value === 'string' && /^[a-fA-F0-9]+$/.test(value) ? BigInt(`0x${value}`)
      : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
    return raw === undefined ? undefined : Number((raw >> BigInt(offset)) & ((1n << BigInt(width)) - 1n));
  } catch { return undefined; }
}
export type ReadValue = <T>(value: T | undefined) => D.Reading<T>;
function merge(base: Report, patch: Report): Report {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = value !== null && typeof value === 'object' && !Array.isArray(value) ? merge(record(base[key]), record(value)) : value;
  }
  return result;
}
const nonNegative = (value: unknown) => { const n = number(value); return n !== undefined && n >= 0 ? n : undefined; };
const fraction = (value: unknown, scale: number) => { const n = number(value); return n !== undefined && n >= 0 && n <= scale ? n / scale : undefined; };
const phases: Record<string, D.PrintPhase> = { IDLE: 'idle', READY: 'idle', PREPARE: 'preparing', RUNNING: 'printing', PAUSE: 'paused', FINISH: 'completed', FAILED: 'failed' };

/** Orca FanControlPopupNew::get_fan_func_name: model/mode text first, AIR_FUN fallback.
 * Only names reported parts; resource data never creates hardware or command targets.
 */
function airductFanName(model: string | null, index: number, airduct: Report): string {
  const profile = model === 'N6' ? n6 : model === 'N7' ? n7 : undefined;
  const fanText = record(record(record(profile)['00.00.00.00']).fan);
  const mode = number(airduct.modeCur), submode = number(airduct.subMode) ?? -1;
  const override = mode === undefined ? undefined : record(fanText[String(mode)])[String(index)];
  const label = text(override) ?? text(record(override)[String(submode)]);
  if (label) return label;
  // DevFan.h AIR_FUN and FanControl.cpp default labels, expanded for clarity.
  const names: Record<number, string> = {
    0: 'Hotend cooling 0', 1: 'Part cooling', 2: 'Auxiliary cooling',
    3: 'Chamber exhaust', 4: 'Hotend cooling 1', 5: 'Mainboard cooling',
    6: 'Chamber heat circulation',
  };
  return names[index] ?? `Unknown fan (ID ${index})`;
}

export interface TelemetryProjection {
  values: D.PrinterObservationMap;
  /** Private normalized source needed by the command adapter; never sent over IPC. */
  report: Report;
  fresh: boolean;
  generation: number;
}
export class BambuTelemetry {
  private print: Report = {};
  generation = 0;
  private info: Report = {};
  private baseline = false;
  private receivedAt: number | null = null;
  private disconnected = true;
  private topologyKey = '';
  private topologyRevision = 0;
  private inventoryKey = '';
  private inventoryRevision = 0;
  constructor(private readonly now = () => Date.now(), readonly staleAfterMs = 15_000) {}
  invalidate() { this.disconnected = true; this.baseline = false; }
  accept(payload: string): 'updated' | 'ignored' | 'resync' {
    if (payload.length > 4 * 1024 * 1024) return 'ignored';
    let root: Report;
    try { root = record(JSON.parse(payload)); } catch { return 'ignored'; }
    const info = record(root.info);
    if (info.command === 'get_version' || info.command === 'get_capabilities') this.info = merge(this.info, info);
    const update = record(root.print);
    if (update.command !== 'push_status') return Object.keys(info).length ? 'updated' : 'ignored';
    if (update.msg !== undefined && update.msg !== 0 && update.msg !== 1) return 'resync';
    if (update.msg === 1 && !this.baseline) { this.disconnected = true; return 'resync'; }
    // A new task cannot inherit progress/layers from the previous print when its first push omits them.
    if (update.subtask_id !== undefined && update.subtask_id !== this.print.subtask_id || update.gcode_state === 'IDLE' || update.gcode_state === 'READY') {
      for (const key of ['mc_percent', 'mc_remaining_time', 'layer_num', 'total_layer_num', 'stg_cur', 'subtask_name', 'gcode_file', 'thumbnail_url']) delete this.print[key];
    }
    this.print = update.msg === 0 ? merge({}, update) : merge(this.print, update);
    ++this.generation;
    this.baseline = true; this.disconnected = false; this.receivedAt = this.now();
    return 'updated';
  }
  project(target: D.PrinterTarget, identity: D.PrinterIdentity): TelemetryProjection {
    const p = this.print, device = record(p.device), ext = record(device.extruder);
    const fresh = !this.disconnected && this.receivedAt !== null && this.now() - this.receivedAt < this.staleAfterMs;
    const read: ReadValue = value => value === undefined || this.receivedAt === null ? unknown : {
      kind: 'known', value, freshness: fresh ? 'fresh' : 'stale', sourceRouteId: target.routeId,
      observedAtMs: null, receivedAtMs: this.receivedAt,
    };
    const topology: D.PrinterTopology = { revision: '', completeness: 'partial', motionGroups: [], extruders: [], nozzles: [], tools: [], heaters: [], fans: [], lights: [], cameras: [], sensors: [], materials: { units: [], slots: [], paths: [], dryers: [] } };
    const heaters: D.Heater[] = [], thermal: D.PrinterState['heaters'][number][] = [];
    const definitions: D.SensorDefinition[] = [], readings: D.SensorState[] = [];
    const temperature = (key: string, name: string, role: D.Heater['role'], current: unknown, requested: unknown, controllable = true) => {
      if (current === undefined && requested === undefined) return;
      const sensorId = id<'sensor'>(`${key}:temperature`);
      definitions.push({ id: sensorId, name, location: key, kind: 'temperature', unit: 'celsius' });
      readings.push({ sensorId, kind: 'temperature', reading: read(nonNegative(current)) });
      if (controllable) { heaters.push({ id: id(key), name, role, temperatureSensorId: sensorId }); thermal.push({ heaterId: id(key), targetC: read(nonNegative(requested)) }); }
    };
    const extruders = records(ext.info).filter(item => identifier(item.id) !== undefined);
    if (!extruders.length && (p.nozzle_temper !== undefined || p.nozzle_target_temper !== undefined)) extruders.push({ id: 0, legacy: true });
    const nozzles: D.Nozzle[] = [], tools: D.Tool[] = [];
    for (const item of extruders) {
      const key = identifier(item.id)!;
      // High nibble 1 identifies the nozzle rack; installed toolhead nozzles use 0.
      const nozzle = records(record(device.nozzle).info).find(nozzle => bits(nozzle.id, 0, 4) === number(item.hnow) && bits(nozzle.id, 4, 4) === 0);
      const type = text(nozzle?.type ?? (item.legacy ? p.nozzle_type : undefined));
      const nozzleId = id<'nozzle'>(`nozzle:${key}`);
      nozzles.push({ id: nozzleId, heaterId: id(`nozzle:${key}`), diameterMm: nonNegative(nozzle?.diameter ?? (item.legacy ? p.nozzle_diameter : undefined)) ?? null,
        type: type ?? null, constructionMaterial: type === 'hardened_steel' ? 'hardened steel' : type === 'stainless_steel' ? 'stainless steel' : ({ '00': 'stainless steel', '01': 'hardened steel', '05': 'tungsten carbide' } as Record<string, string>)[type?.slice(2, 4) ?? ''] ?? null,
        flowType: ({ S: 'standard flow', A: 'standard flow', X: 'standard flow', H: 'high flow', E: 'high flow', U: 'TPU high flow', B: 'E3D high flow' } as Record<string, string>)[type?.[1] ?? ''] ?? null });
      tools.push({ id: id(`tool:${key}`), name: `Tool ${key}`, extruderId: id(`extruder:${key}`), nozzleId, motionGroupId: id('gantry') });
      temperature(`nozzle:${key}`, `Nozzle ${key}`, 'nozzle', item.legacy ? p.nozzle_temper : bits(item.temp, 0, 16), item.legacy ? p.nozzle_target_temper : bits(item.temp, 16, 16));
    }
    temperature('bed', 'Bed', 'bed', device.bed_temp !== undefined ? bits(device.bed_temp, 0, 16) : p.bed_temper, device.bed_temp !== undefined ? bits(device.bed_temp, 16, 16) : p.bed_target_temper);
    const chamber = record(record(device.ctc).info).temp;
    temperature('chamber', 'Chamber', 'chamber', chamber !== undefined ? bits(chamber, 0, 16) : p.chamber_temper,
      chamber !== undefined ? bits(chamber, 16, 16) : p.chamber_target_temper, chamber !== undefined || p.chamber_target_temper !== undefined);
    const fans: D.Fan[] = [], fanState: D.PrinterState['fans'][number][] = [];
    const airduct = record(device.airduct), airParts = records(airduct.parts);
    if (airParts.length) {
      for (const part of airParts) {
        if (bits(part.id, 0, 4) !== 0) continue;
        const key = bits(part.id, 4, 8); if (key === undefined) continue;
        fans.push({ id: id(`fan:${key}`), name: airductFanName(identity.model, key, airduct), role: 'other' });
        fanState.push({ fanId: id(`fan:${key}`), speedFraction: read(fraction(bits(part.state, 0, 8), 100)) });
      }
    } else {
      for (const [field, index, role, name] of [['cooling_fan_speed', 1, 'part', 'Part cooling'], ['big_fan1_speed', 2, 'auxiliary', 'Auxiliary'], ['big_fan2_speed', 3, 'chamber', 'Chamber']] as const) {
        if (p[field] === undefined && p.fan_gear === undefined) continue;
        fans.push({ id: id(`fan:${index}`), name, role });
        fanState.push({ fanId: id(`fan:${index}`), speedFraction: read(p.fan_gear !== undefined ? fraction(bits(p.fan_gear, (index - 1) * 8, 8), 255) : fraction(p[field], 15)) });
      }
    }
    const lights: D.Light[] = [], lightState: D.PrinterState['lights'][number][] = [];
    for (const light of records(p.lights_report)) {
      if (typeof light.node !== 'string' || !['chamber_light', 'chamber_light2', 'work_light'].includes(light.node)) continue;
      lights.push({ id: id(light.node), name: light.node === 'chamber_light' ? 'Chamber light' : light.node === 'chamber_light2' ? 'Chamber light 2' : 'Work light' });
      lightState.push({ lightId: id(light.node), on: read(light.mode === 'on' ? true : light.mode === 'off' ? false : undefined) });
    }
    const material = materialInventory(p, extruders, tools.map(tool => tool.id), read, definitions, readings);
    Object.assign(topology, { motionGroups: tools.length ? [{ id: id('gantry'), name: 'Gantry', axes: ['x', 'y', 'z'] }] : [],
      tools, nozzles, extruders: tools.map(tool => ({ id: tool.extruderId, name: tool.name, filamentDiametersMm: null })),
      heaters, fans, lights, sensors: definitions, materials: material.topology });
    const topologyKey = JSON.stringify(topology);
    if (topologyKey !== this.topologyKey) { this.topologyKey = topologyKey; ++this.topologyRevision; }
    topology.revision = `topology-${this.topologyRevision}`;
    const inventoryKey = JSON.stringify(material.state.slots.map(slot => ({ ...slot, material: slot.material.kind === 'known' ? slot.material.value : null,
      presence: slot.presence.kind === 'known' ? slot.presence.value : null, spoolIdentity: slot.spoolIdentity.kind === 'known' ? slot.spoolIdentity.value : null, remaining: undefined })));
    if (inventoryKey !== this.inventoryKey) { this.inventoryKey = inventoryKey; ++this.inventoryRevision; }
    material.topologyRevision = topology.revision; material.state.inventoryRevision = `inventory-${this.inventoryRevision}`;
    const phase = phases[String(p.gcode_state)];
    const task = text(p.subtask_id), name = text(p.subtask_name) || text(p.gcode_file);
    const firmware = records(this.info.module).flatMap(item => typeof item.name === 'string' && typeof item.sw_ver === 'string' ? [{ name: item.name, version: item.sw_ver }] : []);
    const active = bits(ext.state, 4, 4);
    const activeId = active === undefined ? extruders.length === 1 ? identifier(extruders[0].id) : undefined : String(active);
    const stage = number(p.stg_cur);
    const state: D.PrinterObservationMap['status'] = { operationalState: read(phase === 'failed' ? 'error' : phase === 'preparing' || phase === 'printing' || phase === 'paused' ? 'busy' : phase ? 'ready' : undefined),
      activeToolIds: read(activeId !== undefined && tools.some(tool => tool.id === `tool:${activeId}`) ? [id<'tool'>(`tool:${activeId}`)] : undefined), actions: read([]),
      printStatus: { phase: read(phase), taskId: read(phase === 'idle' ? null : task && task !== '0' ? id<'device-task'>(task) : undefined), name: read(phase === 'idle' ? null : name),
        progressFraction: read(phase === 'idle' ? undefined : fraction(p.mc_percent, 100)), remainingSeconds: read(phase === 'idle' ? undefined : nonNegative(p.mc_remaining_time) === undefined ? undefined : number(p.mc_remaining_time)! * 60),
        stage: read(stage === undefined ? undefined : stage === -1 || stage === 255 ? null : { code: String(stage), label: stageLabel(stage) }),
        currentLayer: read(nonNegative(p.layer_num)), totalLayers: read(nonNegative(p.total_layer_num)), speedModeId: read(identifier(p.spd_lvl)) } };
    const home = number(p.home_flag);
    const motion: D.PrinterState['motion'] = tools.length ? [{ motionGroupId: id('gantry'), positionMm: unknown,
      homedAxes: read(home === undefined ? undefined : (['x', 'y', 'z'] as const).filter((_, bit) => (home & (1 << bit)) !== 0)) }] : [];
    const error = nonNegative(p.print_error);
    const alerts: D.PrinterObservationMap['alerts'] = error ? [{ id: id(`print:${error}`), code: error.toString(16).toUpperCase(), severity: 'error', message: `Printer error ${error.toString(16).toUpperCase()}`, actions: [] }] : [];
    return { fresh, generation: this.generation, report: merge(p, { capabilities: record(this.info.capabilities) }), values: {
      descriptor: { revision: topology.revision, identity, technology: 'fdm', buildVolume: null, firmware: firmware.length ? read(firmware) : unknown, topology },
      status: state, thermal, motion, actuators: { fans: fanState, lights: lightState }, sensors: { definitionRevision: topology.revision, definitions, readings },
      materials: material, firmware, cameras: [], alerts,
    } };
  }
  snapshot<K extends D.StateTopic>(target: D.PrinterTarget, identity: D.PrinterIdentity, revision: string, topics: readonly [K, ...K[]]): D.PrinterSnapshot<K> {
    const projection = this.project(target, identity);
    const values = Object.fromEntries(topics.map(topic => [topic, this.receivedAt === null ? unknown : {
      kind: 'known', value: projection.values[topic], freshness: projection.fresh ? 'fresh' : 'stale', sourceRouteId: target.routeId, receivedAtMs: this.receivedAt, observedAtMs: null,
    }])) as D.ObservationValues<K>;
    return { target, configurationRevision: revision, values };
  }
}

function materialInventory(p: Report, extruders: Report[], toolIds: D.Id<'tool'>[], read: ReadValue,
  sensors: D.SensorDefinition[], readings: D.SensorState[]): D.MaterialInventory {
  const units: D.MaterialUnit[] = [], slots: D.MaterialSlot[] = [], paths: D.MaterialPath[] = [], dryers: D.Dryer[] = [];
  const slotState: D.MaterialState['slots'][number][] = [], dryerState: D.MaterialState['dryers'][number][] = [];
  const ams = record(p.ams);
  const switchInstalled = bits(p.aux, 29) === 1;
  const entries = records(ams.ams);
  const switchReady = switchInstalled && entries.every(unit => [0, 1].includes(bits(unit.info, 24, 4) ?? -1));
  const slotKey = (unit: string, slot: string) => id<'slot'>(`slot:${unit}:${slot}`);
  const pathKey = (unit: string, slot: string, tool: string) => id<'path'>(`path:${unit}:${slot}:${tool}`);
  const addSlot = (unit: string, tray: Report, bindings: string[], external = false) => {
    const slot = identifier(tray.id); if (slot === undefined) return;
    const slotId = slotKey(unit, slot);
    slots.push({ id: slotId, unitId: id(`unit:${unit}`), name: external ? 'External spool' : `Slot ${slot}` });
    for (const tool of bindings) if (toolIds.includes(id(`tool:${tool}`))) paths.push({ id: pathKey(unit, slot, tool), slotId, toolId: id(`tool:${tool}`), loading: 'automatic' });
    const rawColor = text(tray.tray_color), rgba = rawColor && /^[\da-fA-F]{8}$/.test(rawColor) ? `#${rawColor}` : null;
    const colors = Array.isArray(tray.cols) ? tray.cols.filter((color): color is string => typeof color === 'string' && /^[\da-fA-F]{8}$/.test(color)).map(color => `#${color}`) : [];
    const material: D.MaterialMetadata = { materialType: text(tray.tray_type) ?? null, manufacturer: text(tray.tray_sub_brands) ?? null,
      color: colors.length > 1 ? { kind: 'multiple', rgba: colors, appearance: 'unknown' } : rgba ? { kind: 'solid', rgba } : null,
      diameterMm: number(tray.tray_diameter) ?? null, catalogRef: typeof tray.tray_info_idx === 'string' && tray.tray_info_idx ? { namespace: 'bambu-filament', value: tray.tray_info_idx } : null };
    const tag = text(tray.tray_uuid) || text(tray.tag_uid);
    // Presence is a hardware bitmap, never inferred from metadata (which may be stale).
    const type = bits(entries.find(entry => String(entry.id) === unit)?.info, 0, 4);
    const index = external ? undefined : type === 5 ? 24 + Number(slot) : Number(unit) >= 128 ? 16 + Number(unit) - 128 : Number(unit) * 4 + Number(slot);
    const exists = index === undefined || index > 63 ? undefined : bits(ams.tray_exist_bits, index);
    slotState.push({ slotId, presence: read(exists === undefined ? undefined : exists ? 'present' : 'empty'),
      material: read(Object.values(material).some(value => value !== null) ? material : undefined),
      spoolIdentity: read(tag && !/^0+$/.test(tag) ? { namespace: 'bambu-spool', value: tag } : undefined),
      remaining: read(!external && ams.calibrate_remain_flag === true && typeof tray.tag_uid === 'string' && /[^0]/.test(tray.tag_uid)
        && fraction(tray.remain, 100) !== undefined ? { unit: 'fraction', value: fraction(tray.remain, 100)!, basis: 'estimated' } : undefined) });
  };
  for (const unit of entries) {
    const key = identifier(unit.id); if (key === undefined) continue;
    const sensorIds: D.Id<'sensor'>[] = [];
    for (const [field, label] of [['temp', 'Temperature'], ['humidity_raw', 'Humidity'], ['humidity', 'Humidity level']] as const) {
      if (unit[field] === undefined) continue;
      const sensorId = id<'sensor'>(`ams:${key}:${field}`); sensorIds.push(sensorId);
      const common = { id: sensorId, name: `AMS ${key} ${label}`, location: `unit:${key}` };
      if (field === 'temp') { sensors.push({ ...common, kind: 'temperature', unit: 'celsius' }); readings.push({ sensorId, kind: 'temperature', reading: read(number(unit[field])) }); }
      else if (field === 'humidity_raw') { sensors.push({ ...common, kind: 'relativeHumidity', unit: 'percent' }); readings.push({ sensorId, kind: 'relativeHumidity', reading: read(fraction(unit[field], 100) === undefined ? undefined : number(unit[field])) }); }
      else { sensors.push({ ...common, kind: 'numeric', unit: null, semanticType: 'bambu:humidity-level' }); readings.push({ sensorId, kind: 'numeric', reading: read(number(unit[field])) }); }
    }
    const unitType = bits(unit.info, 0, 4);
    const unitName = ({ 1: 'AMS', 2: 'AMS Lite', 3: 'AMS 2 Pro', 4: 'AMS HT', 5: 'AMS Lite' } as Record<number, string>)[unitType ?? -1] ?? 'AMS';
    units.push({ id: id(`unit:${key}`), name: `${unitName} ${key}`, kind: 'automatic-feeder', sensorIds });
    const binding = bits(unit.info, 8, 4);
    const bindings = binding === 14 ? switchReady ? extruders.map(item => identifier(item.id)!) : []
      : binding !== undefined ? [String(binding)] : extruders.length === 1 ? [identifier(extruders[0].id)!] : [];
    for (const tray of records(unit.tray)) addSlot(key, tray, bindings);
    if ((unitType === 3 || unitType === 4) && (unit.dry_time !== undefined || unit.dry_setting !== undefined)) {
      const dryerId = id<'dryer'>(`dryer:${key}`);
      dryers.push({ id: dryerId, name: `AMS ${key} dryer`, unitIds: [id(`unit:${key}`)], sensorIds });
      const status = bits(unit.info, 4, 4);
      const phase = status === 0 ? 'off' : status === 2 ? bits(unit.info, 22, 2) === 1 ? 'heating' : 'drying' : status === 3 ? 'cooling' : status === 5 || status === 6 ? 'error' : undefined;
      dryerState.push({ dryerId, phase: read(phase), remainingSeconds: read(nonNegative(unit.dry_time) === undefined ? undefined : number(unit.dry_time)! * 60) });
    }
  }
  const virtual = Array.isArray(p.vir_slot) ? records(p.vir_slot) : Object.keys(record(p.vt_tray)).length ? [{ ...record(p.vt_tray), id: 255 }] : [];
  // Orca DevFilaSystem: virtual IDs identify units, each with slot 0, not tool IDs.
  for (const [unit, tool] of [['255', '0'], ['254', '1']]) {
    const tray = virtual.find(tray => identifier(tray.id) === unit);
    if (!tray) continue;
    units.push({ id: id(`unit:${unit}`), name: `External holder ${unit}`, kind: 'manual-holder', sensorIds: [] });
    addSlot(unit, { ...tray, id: 0 }, [tool], true);
  }
  const resolvePath = (value: unknown, tool: string, legacy: boolean): D.Reading<D.Id<'path'> | null> => {
    let unit: string, slot: string;
    if (legacy) {
      const packed = number(value); if (packed === undefined) return unknown;
      if (packed === 255) return read(null);
      unit = packed === 254 ? '255' : String(packed >= 128 ? packed : packed >> 2); slot = packed === 254 ? '0' : String(packed & 3);
    } else {
      const a = bits(value, 8, 8), b = bits(value, 0, 8); if (a === undefined || b === undefined) return unknown;
      if (b === 255) return read(null);
      unit = String(a); slot = String(b);
    }
    const key = pathKey(unit, slot, tool);
    return paths.some(path => path.id === key) ? read(key) : unknown;
  };
  const tools: D.MaterialState['tools'] = extruders.map(ext => {
    const key = identifier(ext.id)!;
    const status = ext.legacy ? number(p.ams_status) : bits(ext.stat, 0, 16);
    const selected = resolvePath(ext.legacy ? ams.tray_tar : ext.star, key, !!ext.legacy);
    const loaded = resolvePath(ext.legacy ? ams.tray_now : ext.snow, key, !!ext.legacy);
    return { toolId: id(`tool:${key}`), selectedPathId: selected, loadedPathId: loaded,
      activity: read(status === undefined ? undefined : status === 0 ? 'idle' : (status >> 8) === 1 ? selected.kind === 'known' && selected.value === null ? 'unloading' : 'loading' : undefined) };
  });
  return { topologyRevision: '', topology: { units, slots, paths, dryers }, toolIds, state: { inventoryRevision: '', slots: slotState, tools, dryers: dryerState } };
}
