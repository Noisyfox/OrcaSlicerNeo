/** Observed U1 hardware and physical Device commands. Job mappings never enter this module. */
import type * as D from './domain';
import type { PrinterConfiguration } from './configuration';
import { MoonrakerHttp, record, fail } from './moonraker-http';
import { u1MaterialInventory, u1PathId, u1ToolId } from './snapmaker-observation';

const id = <K extends string>(value: string) => value as D.Id<K>;
const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const heads = [0, 1, 2, 3];
const extruder = (i: number) => i ? `extruder${i}` : 'extruder';
const heaterId = (name: string) => id<'heater'>(`snapmaker-heater:${name}`);
const fanId = (name: string) => id<'fan'>(`snapmaker-fan:${name}`);
const slotId = (i: number) => id<'slot'>(`snapmaker-slot:${i}`);
export interface U1DeviceSnapshot {
  objects: readonly string[];
  commands: readonly string[];
  status: Record<string, unknown>;
  receivedAtMs: number;
}
export async function readU1Device(http: MoonrakerHttp, printer: PrinterConfiguration, signal?: AbortSignal): Promise<U1DeviceSnapshot> {
  const list = await http.get(printer, '/printer/objects/list', signal);
  if (!Array.isArray(list.objects) || !list.objects.every(x => typeof x === 'string')) fail('device-failed', 'Invalid device object list');
  const objects: string[] = list.objects;
  const names = ['print_task_config', 'configfile', 'purifier', 'heater_bed', 'fan', 'led cavity_led', 'filament_feed left', 'filament_feed right',
    ...heads.flatMap(i => [extruder(i), `fan_generic e${i}_fan`, `filament_motion_sensor e${i}_filament`]), 'fan_generic cavity_fan'];
  const query = names.filter(name => objects.includes(name));
  const help = await http.get(printer, '/printer/gcode/help', signal);
  const result = query.length ? await http.get(printer, `/printer/objects/query?${query.map(encodeURIComponent).join('&')}`, signal) : { status: {} };
  return { objects, commands: Object.keys(help), status: record(result.status), receivedAtMs: Date.now() };
}
function fans(snapshot: U1DeviceSnapshot) {
  return [
    { object: 'fan', name: 'Toolhead 1 part fan', role: 'part' as const, command: 'M106', script: (n: number) => `M106 S${Math.round(n * 255)}` },
    ...[1, 2, 3].map(i => ({ object: `fan_generic e${i}_fan`, name: `Toolhead ${i + 1} part fan`, role: 'part' as const, command: 'SET_FAN_SPEED', script: (n: number) => `SET_FAN_SPEED FAN=e${i}_fan SPEED=${n}` })),
    { object: 'fan_generic cavity_fan', name: 'Chamber fan', role: 'chamber' as const, command: 'SET_FAN_SPEED', script: (n: number) => `SET_FAN_SPEED FAN=cavity_fan SPEED=${n}` },
    ...['inner', 'exhaust'].map(name => ({ object: `purifier:${name}`, name: `Top cover ${name} fan`, role: 'chamber' as const, command: 'SET_PURIFIER', script: (n: number) => `SET_PURIFIER FAN=${name} SPEED=${n}` })),
  ].filter(f => f.object.startsWith('purifier:') ? snapshot.objects.includes('purifier') : snapshot.objects.includes(f.object));
}
export function u1DeviceValues(snapshot: U1DeviceSnapshot, target: D.PrinterTarget, revision: string, descriptor: D.PrinterDescriptor) {
  const known = <T>(value: T): D.Reading<T> => ({ kind: 'known', value, freshness: 'fresh', sourceRouteId: target.routeId, observedAtMs: null, receivedAtMs: snapshot.receivedAtMs });
  const number = (value: unknown) => finite(value) === null ? unknown : known(value as number);
  const status = snapshot.status;
  const topology = descriptor.topology;
  const installed = heads.filter(i => snapshot.objects.includes(extruder(i)));
  const heaters = [...installed.map(extruder), ...(snapshot.objects.includes('heater_bed') ? ['heater_bed'] : [])];
  topology.motionGroups = [{ id: id('snapmaker-motion'), name: 'Printer', axes: ['x', 'y', 'z'] }];
  topology.extruders = installed.map(i => ({ id: id(`snapmaker-extruder:${i}`), name: `Toolhead ${i + 1}`, filamentDiametersMm: null }));
  topology.nozzles = installed.map(i => ({ id: id(`snapmaker-nozzle:${i}`), diameterMm: finite(record(status[extruder(i)]).nozzle_diameter), constructionMaterial: null, type: null,
    flowType: typeof record(status[extruder(i)]).nozzle_volume_type === 'string' ? record(status[extruder(i)]).nozzle_volume_type as string : null,
    flowReporting: typeof record(status[extruder(i)]).nozzle_volume_type === 'string' ? 'supported' : 'unknown', heaterId: heaterId(extruder(i)) }));
  topology.tools = installed.map(i => ({ id: u1ToolId(i), name: `Toolhead ${i + 1}`, extruderId: id(`snapmaker-extruder:${i}`), nozzleId: id(`snapmaker-nozzle:${i}`), motionGroupId: id('snapmaker-motion') }));
  topology.heaters = heaters.map(name => ({ id: heaterId(name), name: name === 'heater_bed' ? 'Bed' : `Toolhead ${installed.find(i => extruder(i) === name)! + 1}`, role: name === 'heater_bed' ? 'bed' : 'nozzle', temperatureSensorId: id(`snapmaker-temperature:${name}`) }));
  topology.fans = fans(snapshot).map(f => ({ id: fanId(f.object), name: f.name, role: f.role }));
  topology.lights = snapshot.objects.includes('led cavity_led') ? [{ id: id('snapmaker-light'), name: 'Chamber light' }] : [];
  const sensors: D.SensorSnapshot = { definitionRevision: revision, definitions: topology.heaters.map(h => ({ id: h.temperatureSensorId!, name: h.name, location: null, kind: 'temperature', unit: 'celsius' })),
    readings: heaters.map(name => ({ sensorId: id(`snapmaker-temperature:${name}`), kind: 'temperature', reading: number(record(status[name]).temperature) })) };
  if (snapshot.objects.includes('purifier')) {
    const cover = record(status.purifier);
    sensors.definitions = [...sensors.definitions, { id: id('snapmaker-cover-present'), name: 'Top cover connected', location: 'Top cover', kind: 'binary', unit: null, semanticType: 'snapmaker.top-cover.present' },
      { id: id('snapmaker-cover-mode'), name: 'Top cover mode (0 idle, 1 cooling, 2 preheat, 3 hot chamber)', location: 'Top cover', kind: 'numeric', unit: null, semanticType: 'snapmaker.top-cover.mode' }];
    sensors.readings = [...sensors.readings, { sensorId: id('snapmaker-cover-present'), kind: 'binary', reading: typeof cover.power_detected === 'boolean' ? known(cover.power_detected) : unknown },
      { sensorId: id('snapmaker-cover-mode'), kind: 'numeric', reading: number(cover.mode) }];
  }
  topology.sensors = sensors.definitions;
  const light = record(status['led cavity_led']).color_data;
  const white = Array.isArray(light) && Array.isArray(light[0]) ? finite(light[0][3]) : null;
  const values: Partial<D.PrinterObservationMap> = { descriptor, sensors, thermal: heaters.map(name => ({ heaterId: heaterId(name), targetC: number(record(status[name]).target) })),
    actuators: { fans: fans(snapshot).map(f => ({ fanId: fanId(f.object), speedFraction: number(f.object.startsWith('purifier:') ? record(record(status.purifier)[`${f.object.split(':')[1]}_fan`]).speed : record(status[f.object]).speed) })),
      lights: topology.lights.map(l => ({ lightId: l.id, on: white === null ? unknown : known(white > 0) })) } };
  if (snapshot.objects.includes('print_task_config')) { values.materials = u1MaterialInventory(status, target, revision); topology.materials = values.materials.topology; }
  return values;
}
/** Capability support is independent of idle/printing/paused and the top cover's presence. */
export function u1DeviceCapabilities(snapshot?: U1DeviceSnapshot): Partial<D.CommandCapabilities> {
  const result: Partial<D.CommandCapabilities> = {};
  const names: D.CommandName[] = ['thermal.setTarget', 'fans.setSpeed', 'lights.set', 'materials.load', 'materials.unload', 'materials.configure'];
  for (const name of names) Object.assign(result, { [name]: snapshot ? { kind: 'unsupported', layer: 'device', reason: 'Required firmware command or object is not reported' } : { kind: 'unknown', reason: 'Device capabilities have not been read' } });
  if (!snapshot) return result;
  const has = (command: string) => snapshot.commands.includes(command);
  const supported = <T extends object>(constraints: T) => ({ kind: 'supported' as const, constraints });
  const heaters = [...heads.map(extruder), 'heater_bed'].filter(name => snapshot.objects.includes(name));
  if (has('SET_HEATER_TEMPERATURE') && heaters.length) result['thermal.setTarget'] = supported(heaters.map(name => {
    const config = record(record(record(snapshot.status.configfile).settings)[name]);
    return { heaterId: heaterId(name), targetC: { min: 0, max: finite(config.max_temp), step: null } };
  }) as unknown as D.NonEmptyReadonlyArray<{ heaterId: D.Id<'heater'>; targetC: D.Range }>);
  const availableFans = fans(snapshot).filter(f => has(f.command));
  if (availableFans.length) result['fans.setSpeed'] = supported(availableFans.map(f => ({ fanId: fanId(f.object), speedFraction: { min: 0, max: 1, step: null } })) as unknown as D.NonEmptyReadonlyArray<{ fanId: D.Id<'fan'>; speedFraction: D.Range }>);
  if (has('SET_LED') && snapshot.objects.includes('led cavity_led')) result['lights.set'] = supported({ lightIds: [id<'light'>('snapmaker-light')] });
  if (has('FEED_AUTO') && ['left', 'right'].every(side => snapshot.objects.includes(`filament_feed ${side}`))) {
    result['materials.load'] = supported({ pathIds: heads.map(u1PathId) as unknown as D.NonEmptyReadonlyArray<D.Id<'path'>>, admission: 'device' as const });
    result['materials.unload'] = supported({ toolIds: heads.map(u1ToolId) as unknown as D.NonEmptyReadonlyArray<D.Id<'tool'>> });
  }
  if (has('SET_PRINT_FILAMENT_CONFIG') && snapshot.objects.includes('print_task_config')) result['materials.configure'] = supported(heads.map(i => ({ slotId: slotId(i), informationWritable: true, maxGradientColors: null, actions: ['confirm'], restriction: null,
    catalogue: { mainNozzleDiameterMm: finite(record(snapshot.status[extruder(i)]).nozzle_diameter), toolIndex: i, nozzleFlowType: typeof record(snapshot.status[extruder(i)]).nozzle_volume_type === 'string' ? record(snapshot.status[extruder(i)]).nozzle_volume_type as string : null, supportsUserPresets: true } })) as unknown as D.NonEmptyReadonlyArray<D.MaterialConfigurationTarget>);
  return result;
}
function head(value: string, prefix: string): number {
  const match = new RegExp(`^snapmaker-${prefix}:([0-3])$`).exec(value);
  if (!match) fail('invalid-target', 'Unknown physical toolhead');
  return Number(match[1]);
}
function text(value: string): string {
  if (!value.trim() || value.length > 128 || /[\x00-\x1f"\\;#]/.test(value)) fail('invalid-request', 'Unsupported material text');
  return `"${value}"`;
}
export function u1DeviceCommand(snapshot: U1DeviceSnapshot, command: D.PrinterCommand): string {
  const cap = u1DeviceCapabilities(snapshot)[command.type];
  if (!cap || cap.kind !== 'supported') fail('unsupported', 'Device command is unavailable');
  switch (command.type) {
    case 'materials.load': case 'materials.unload': {
      const i = command.type === 'materials.load' ? head(command.params.pathId, 'path') : head(command.params.toolId, 'tool');
      return `FEED_AUTO MODULE=${i < 2 ? 'left' : 'right'} CHANNEL=${[1, 0, 0, 1][i]} ${command.type === 'materials.load' ? 'LOAD' : 'UNLOAD'}=1`;
    }
    case 'thermal.setTarget': {
      const limits = u1DeviceCapabilities(snapshot)['thermal.setTarget'];
      const limit = limits?.kind === 'supported' ? limits.constraints.find(x => x.heaterId === command.params.heaterId) : undefined;
      if (!limit) fail('invalid-target', 'Unknown heater');
      const n = command.params.targetC;
      if (!Number.isFinite(n) || n < 0 || limit.targetC.max !== null && n > limit.targetC.max) fail('out-of-range', 'Invalid target temperature');
      return `SET_HEATER_TEMPERATURE HEATER=${command.params.heaterId.slice('snapmaker-heater:'.length)} TARGET=${n}`;
    }
    case 'fans.setSpeed': {
      const fan = fans(snapshot).find(f => fanId(f.object) === command.params.fanId && snapshot.commands.includes(f.command));
      if (!fan) fail('invalid-target', 'Unknown fan');
      const n = command.params.speedFraction;
      if (!Number.isFinite(n) || n < 0 || n > 1) fail('out-of-range', 'Invalid fan speed');
      return fan.script(n);
    }
    case 'lights.set':
      if (command.params.lightId !== 'snapmaker-light' || typeof command.params.on !== 'boolean') fail('invalid-request', 'Invalid light');
      return `SET_LED LED=cavity_led WHITE=${command.params.on ? 1 : 0}`;
    case 'materials.configure': {
      const p = command.params, i = head(p.slotId, 'slot');
      if (p.intent !== 'confirm' || !p.preset && !p.color) fail('invalid-request', 'Select a material or color');
      let script = `SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=${i}`;
      if (p.preset) {
        const [family, ...variant] = p.preset.materialType.split('-');
        script += ` VENDOR=${text(p.preset.manufacturer || 'Generic')} FILAMENT_TYPE=${text(family)} FILAMENT_SUBTYPE=${text(variant.join('-') || 'Basic')}`;
      }
      if (p.color) {
        if (p.color.kind !== 'solid' || !/^#[0-9a-f]{8}$/i.test(p.color.rgba)) fail('invalid-request', 'Select a solid RGBA color');
        script += ` FILAMENT_COLOR_RGBA=${p.color.rgba.slice(1)}`;
      }
      return script;
    }
    default: fail('unsupported', 'Device command is unavailable');
  }
}
