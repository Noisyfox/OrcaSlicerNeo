import { u1Preferences, u1PreferenceCapability, u1PreferenceScripts } from './preferences';
/** Observed U1 hardware and physical Device commands. Job mappings never enter this module. */
import type * as D from '../domain';
import type { PrinterConfiguration } from '../configuration';
import { MoonrakerHttp, record, fail } from '../moonraker-http';
import { u1MaterialInventory, u1PathId, u1ToolId, u1FilamentType } from './observation';

const id = <K extends string>(value: string) => value as D.Id<K>;
const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const heads = [0, 1, 2, 3];
const axes = ['x', 'y', 'z'] as const;
const jogSteps = [{ id: '10', label: '10 mm', distanceMm: 10 }, { id: '1', label: '1 mm', distanceMm: 1 }, { id: '0.1', label: '0.1 mm', distanceMm: 0.1 }] as const;
const extruder = (i: number) => i ? `extruder${i}` : 'extruder';
const heaterId = (name: string) => id<'heater'>(`snapmaker-heater:${name}`);
const fanId = (name: string) => id<'fan'>(`snapmaker-fan:${name}`);
const slotId = (i: number) => id<'slot'>(`snapmaker-slot:${i}`);
export interface U1DeviceSnapshot {
  printerModel?: PrinterConfiguration['printerModel'];
  objects: readonly string[];
  commands: readonly string[];
  status: Record<string, unknown>;
  remainingSeconds?: number;
  taskId?: D.Id<'device-task'>;
  receivedAtMs: number;
}
export async function readU1Device(http: MoonrakerHttp, printer: PrinterConfiguration, signal?: AbortSignal): Promise<U1DeviceSnapshot> {
  const list = await http.get(printer, '/printer/objects/list', signal);
  if (!Array.isArray(list.objects) || !list.objects.every(x => typeof x === 'string')) fail('device-failed', 'Invalid device object list');
  const objects: string[] = list.objects;
  // gcode/help omits registered commands without descriptions (including U1 commands).
  const names = ['gcode', 'toolhead', 'print_task_config', 'print_stats', 'virtual_sdcard', 'machine_state_manager', 'defect_detection', 'configfile', 'purifier', 'heater_bed', 'fan', 'led cavity_led', 'filament_feed left', 'filament_feed right',
    ...heads.flatMap(i => [extruder(i), `fan_generic e${i}_fan`, `filament_motion_sensor e${i}_filament`]), 'fan_generic cavity_fan'];
  const query = names.filter(name => objects.includes(name));
  const result = query.length ? await http.get(printer, `/printer/objects/query?${query.map(encodeURIComponent).join('&')}`, signal) : { status: {} };
  return { printerModel: printer.printerModel, objects, commands: Object.keys(record(record(record(result.status).gcode).commands)), status: record(result.status), receivedAtMs: Date.now() };
}

/** Firmware codes are physical sensor evidence. A logical active extruder can remain set when all heads are parked. */
export function u1ActiveToolIds(snapshot: U1DeviceSnapshot): readonly D.Id<'tool'>[] | undefined {
  const installed = heads.filter(i => snapshot.objects.includes(extruder(i)));
  const readings = installed.map(i => record(snapshot.status[extruder(i)]).real_extruder_stats);
  if (!readings.length || readings.some(value => !Array.isArray(value) || value.length !== 2)) return undefined;
  const first = readings[0] as unknown[];
  if (readings.some(value => JSON.stringify(value) !== JSON.stringify(first))) return undefined;
  if (installed.some(i => record(snapshot.status[extruder(i)]).activating_move !== false)) return undefined;
  if (first[1] === 1) return [];
  if (first[1] !== 0) return undefined;
  const index = installed.find(i => extruder(i) === first[0]);
  return index === undefined ? undefined : [u1ToolId(index)];
}

export function u1HomedAxes(snapshot: U1DeviceSnapshot): readonly D.Axis[] | undefined {
  const homed = record(snapshot.status.toolhead).homed_axes;
  return typeof homed === 'string' && /^[xyz]*$/.test(homed) ? axes.filter(axis => homed.includes(axis)) : undefined;
}
function coordinate(snapshot: U1DeviceSnapshot, field: string, axis: D.Axis): number | null {
  const value = record(snapshot.status.toolhead)[field];
  return Array.isArray(value) ? finite(value[axes.indexOf(axis)]) : null;
}
function jogLimits(snapshot: U1DeviceSnapshot, axis: D.Axis) {
  const minimum = coordinate(snapshot, 'axis_minimum', axis), maximum = coordinate(snapshot, 'axis_maximum', axis);
  const velocity = finite(record(snapshot.status.toolhead).max_velocity);
  const zVelocity = finite(record(record(record(snapshot.status.configfile).settings).printer).max_z_velocity);
  const limit = axis === 'z' ? zVelocity : velocity;
  if (minimum === null || maximum === null || minimum >= maximum || velocity === null || velocity <= 0 || limit === null || limit <= 0) return undefined;
  return { minimum, maximum, speed: Math.min(axis === 'z' ? 30 : 60, limit, velocity) };
}

// Snapmaker u1-klipper machine_state_manager.py main states and action codes.
const mainStates = ['Idle', 'Printing', 'XYZ offset calibration', 'Bed leveling', 'Flow calibration', 'Vibration calibration',
  'Firmware upgrade', 'Abnormal', 'Bed screw adjustment', 'Loading filament', 'Unloading filament', 'Manual filament loading',
  'Tool parking calibration', 'Homing origin calibration'];
const actionLabels = new Map<number, string>([
  [1, 'Homing'], [2, 'Detecting build plate'], [3, 'Preheating chamber'],
  [128, 'Restoring interrupted print'], [129, 'Paused'], [130, 'Resuming'], [131, 'Replenishing filament'],
  [132, 'Checking tool change'], [133, 'Loading filament'], [134, 'Priming filament'], [135, 'Unloading filament'], [136, 'Detecting print bed'],
  [192, 'Cleaning toolhead 1'], [193, 'Cleaning toolhead 2'], [194, 'Cleaning toolhead 3'], [195, 'Cleaning toolhead 4'],
  [196, 'Probing toolhead 1 offset'], [197, 'Probing toolhead 2 offset'], [198, 'Probing toolhead 3 offset'], [199, 'Probing toolhead 4 offset'],
  [200, 'Cleaning nozzle'], [201, 'Cooling nozzle'], [256, 'Bed leveling'], [257, 'Preheating bed'], [258, 'Prescanning bed'],
  [320, 'Calibrating toolhead 1 flow'], [321, 'Calibrating toolhead 2 flow'], [322, 'Calibrating toolhead 3 flow'], [323, 'Calibrating toolhead 4 flow'],
  [384, 'Vibration calibration'], [512, 'Resetting bed screws'], [513, 'Probing reference points'], [514, 'Adjusting bed screws'], [515, 'Verifying bed adjustment'],
  [576, 'Loading filament'], [640, 'Unloading filament'], [704, 'Manual filament loading'], [768, 'Tool parking calibration'],
  [769, 'Verifying tool pickup'], [770, 'Verifying tool parking'], [832, 'Homing origin calibration'],
]);

export function u1PrintStage(status: Record<string, unknown>): { code: string; label: string } | null | undefined {
  const state = record(status.machine_state_manager);
  const main = state.main_state, action = state.action_code;
  if (typeof main !== 'number' || !Number.isSafeInteger(main) || main < 0 ||
      typeof action !== 'number' || !Number.isSafeInteger(action) || action < 0) return undefined;
  if (main === 0 && action === 0) return null;
  const label = actionLabels.get(action) ?? mainStates[main];
  return label ? { code: `${main}:${action}`, label } : undefined;
}

function fans(snapshot: U1DeviceSnapshot) {
  return [
    { object: 'fan', name: 'Toolhead 1 part fan', role: 'part' as const, command: 'M106', script: (n: number) => `M106 S${Math.round(n * 255)}` },
    ...[1, 2, 3].map(i => ({ object: `fan_generic e${i}_fan`, name: `Toolhead ${i + 1} part fan`, role: 'part' as const, command: 'SET_FAN_SPEED', script: (n: number) => `SET_FAN_SPEED FAN=e${i}_fan SPEED=${n}` })),
    { object: 'fan_generic cavity_fan', name: 'Chamber fan', role: 'chamber' as const, command: 'SET_FAN_SPEED', script: (n: number) => `SET_FAN_SPEED FAN=cavity_fan SPEED=${n}` },
    ...['inner', 'exhaust'].map(name => ({ object: `purifier:${name}`, name: `Top cover ${name} fan`, role: 'chamber' as const, command: 'SET_PURIFIER', script: (n: number) => `SET_PURIFIER FAN=${name} SPEED=${n}` })),
  ].filter(f => f.object.startsWith('purifier:') ? snapshot.objects.includes('purifier') : snapshot.objects.includes(f.object));
}
export function u1DeviceValues(snapshot: U1DeviceSnapshot, target: D.PrinterTarget, revision: string, descriptor: D.PrinterDescriptor,
  model: PrinterConfiguration['printerModel']) {
  const known = <T>(value: T): D.Reading<T> => ({ kind: 'known', value, freshness: 'fresh', sourceRouteId: target.routeId, observedAtMs: null, receivedAtMs: snapshot.receivedAtMs });
  const number = (value: unknown) => finite(value) === null ? unknown : known(value as number);
  const status = snapshot.status;
  const topology = descriptor.topology;
  const installed = heads.filter(i => snapshot.objects.includes(extruder(i)));
  // Device settings are authoritative; hardware objects do not identify a model.
  descriptor.identity = { ...descriptor.identity, manufacturer: model?.vendorId || null,
    model: model?.model ?? null, externalRefs: [] };
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
  const values: Partial<D.PrinterObservationMap> = { preferences: u1Preferences(snapshot, target), descriptor, sensors, thermal: heaters.map(name => ({ heaterId: heaterId(name), targetC: number(record(status[name]).target) })),
    actuators: { fans: fans(snapshot).map(f => ({ fanId: fanId(f.object), speedFraction: number(f.object.startsWith('purifier:') ? record(record(status.purifier)[`${f.object.split(':')[1]}_fan`]).speed : record(status[f.object]).speed) })),
      lights: topology.lights.map(l => ({ lightId: l.id, on: white === null ? unknown : known(white > 0) })) } };
  if (snapshot.objects.includes('toolhead')) {
    const position: Partial<Record<D.Axis, number>> = {};
    for (const axis of axes) {
      const value = coordinate(snapshot, 'position', axis);
      if (value !== null) position[axis] = value;
    }
    const homed = u1HomedAxes(snapshot);
    values.motion = [{ motionGroupId: id('snapmaker-motion'), positionMm: Object.keys(position).length ? known(position) : unknown,
      homedAxes: homed === undefined ? unknown : known(homed) }];
  }
  if (snapshot.objects.includes('print_task_config')) { values.materials = u1MaterialInventory(status, target, revision); topology.materials = values.materials.topology; }
  return values;
}
/** Capability support is independent of idle/printing/paused and the top cover's presence. */
export function u1DeviceCapabilities(snapshot?: U1DeviceSnapshot): Partial<D.CommandCapabilities> {
  const result: Partial<D.CommandCapabilities> = { 'preferences.set': u1PreferenceCapability(snapshot) };
  const names: D.CommandName[] = ['thermal.setTarget', 'fans.setSpeed', 'lights.set', 'materials.load', 'materials.unload', 'materials.writeMetadata', 'materials.configure', 'tools.select', 'tools.park', 'extrusion.move', 'motion.home', 'motion.jog'];
  for (const name of names) Object.assign(result, { [name]: snapshot ? { kind: 'unsupported', layer: 'device', reason: 'Required firmware command or object is not reported' } : { kind: 'unknown', reason: 'Device capabilities have not been read' } });
  if (!snapshot) return result;
  const has = (command: string) => snapshot.commands.includes(command);
  const supported = <T extends object>(constraints: T) => ({ kind: 'supported' as const, constraints });
  const heaters = [...heads.map(extruder), 'heater_bed'].filter(name => snapshot.objects.includes(name));
  const installed = heads.filter(i => snapshot.objects.includes(extruder(i)));
  if (snapshot.objects.includes('toolhead') && has('G28') && has('M400'))
    result['motion.home'] = supported([{ motionGroupId: id<'motion'>('snapmaker-motion'), axes }]);
  if (snapshot.objects.includes('toolhead') && ['SAVE_GCODE_STATE', 'RESTORE_GCODE_STATE', 'G91', 'M220', 'G1', 'M400'].every(has)) {
    const movable = axes.filter(axis => jogLimits(snapshot, axis));
    if (movable.length) result['motion.jog'] = supported(movable.map(axis => ({ motionGroupId: id<'motion'>('snapmaker-motion'), axis,
      kind: 'step' as const, steps: jogSteps.map(({ id, label }) => ({ id, label })) })) as unknown as D.PrinterCommandSpecs['motion.jog']['constraints']);
  }
  const selectable = installed.filter(i => has(`T${i}`)).map(u1ToolId);
  if (selectable.length) result['tools.select'] = supported({ toolIds: selectable as unknown as D.NonEmptyReadonlyArray<D.Id<'tool'>> });
  const parkable = installed.filter(i => has(`PARK_${extruder(i).toUpperCase()}`)).map(u1ToolId);
  if (parkable.length) result['tools.park'] = supported({ toolIds: parkable as unknown as D.NonEmptyReadonlyArray<D.Id<'tool'>> });
  if (['SAVE_GCODE_STATE', 'RESTORE_GCODE_STATE', 'M83', 'M220', 'M221', 'G1', 'M400'].every(has)) {
    const settings = record(record(snapshot.status.configfile).settings);
    const drives = installed.filter(i => (finite(record(settings[extruder(i)]).max_extrude_only_distance) ?? 0) >= 10);
    if (drives.length) result['extrusion.move'] = supported(drives.map(i => ({ extruderId: id<'extruder'>(`snapmaker-extruder:${i}`),
      distanceMm: { min: -10, max: 10, step: 10 }, speed: { kind: 'specified' as const, mmPerSecond: { min: 5, max: 5, step: 1 } } })) as unknown as D.PrinterCommandSpecs['extrusion.move']['constraints']);
  }
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
  if (has('SET_PRINT_FILAMENT_CONFIG') && snapshot.objects.includes('print_task_config')) result['materials.writeMetadata'] = supported(heads.map(i => ({ slotId: slotId(i), writableFields: ['manufacturer', 'materialType', 'color'] })) as unknown as D.NonEmptyReadonlyArray<{ slotId: D.Id<'slot'>; writableFields: D.NonEmptyReadonlyArray<keyof D.MaterialMetadata> }>);
  // A manually associated model supplies the existing native device catalogue.
  // The protocol writes metadata only; it has no Bambu calibration/reset action.
  if (result['materials.writeMetadata']?.kind === 'supported' && snapshot.printerModel) {
    const installed = heads.filter(i => snapshot.objects.includes(extruder(i)));
    if (installed.length) result['materials.configure'] = supported(installed.map(i => ({
      slotId: slotId(i), informationWritable: true, maxGradientColors: null, actions: ['confirm'] as const, restriction: null,
      catalogue: { mainNozzleDiameterMm: finite(record(snapshot.status[extruder(i)]).nozzle_diameter), toolIndex: i,
        nozzleFlowType: typeof record(snapshot.status[extruder(i)]).nozzle_volume_type === 'string' ? record(snapshot.status[extruder(i)]).nozzle_volume_type as string : null,
        supportsUserPresets: true },
    })) as unknown as D.NonEmptyReadonlyArray<D.MaterialConfigurationTarget>);
  }
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
    case 'tools.select': case 'tools.park': case 'extrusion.move': case 'motion.home': case 'motion.jog': {
      const state = record(snapshot.status.machine_state_manager);
      if (!['standby', 'complete', 'cancelled'].includes(String(record(snapshot.status.print_stats).state)) || state.main_state !== 0 || state.action_code !== 0)
        fail('busy', 'Wait until the printer is idle before moving or changing tools.');
      if (heads.some(i => record(snapshot.status[extruder(i)]).activating_move === true)) fail('busy', 'A tool change is already running.');
      if (command.type === 'motion.home') {
        const p = command.params;
        if (p.motionGroupId !== 'snapmaker-motion' || !Array.isArray(p.axes) || !p.axes.length || p.axes.some(axis => !axes.includes(axis)) || new Set(p.axes).size !== p.axes.length)
          fail('invalid-target', 'Select the reported motion group and axes.');
        if (p.axes.includes('z') && !p.axes.includes('x') && !p.axes.includes('y') && !['x', 'y'].every(axis => u1HomedAxes(snapshot)?.includes(axis as D.Axis)))
          fail('precondition-failed', 'Home X and Y before homing Z alone.');
        return `G28 ${axes.filter(axis => p.axes.includes(axis)).map(axis => axis.toUpperCase()).join(' ')}\nM400`;
      }
      if (command.type === 'motion.jog') {
        const p = command.params;
        if (p.motionGroupId !== 'snapmaker-motion' || !axes.includes(p.axis) || p.kind !== 'step' || !['positive', 'negative'].includes(p.direction))
          fail('invalid-request', 'Select a reported motion step and direction.');
        const step = jogSteps.find(step => step.id === p.stepId), limits = jogLimits(snapshot, p.axis);
        if (!step || !limits) fail('out-of-range', 'Select a supported motion step.');
        if (!u1HomedAxes(snapshot)?.includes(p.axis)) fail('precondition-failed', 'Home the requested axis before moving.');
        const position = coordinate(snapshot, 'position', p.axis);
        if (position === null) fail('precondition-failed', 'The current axis position is unknown.');
        const distance = step.distanceMm * (p.direction === 'positive' ? 1 : -1), target = position + distance;
        if (target < limits.minimum || target > limits.maximum) fail('out-of-range', 'The requested move exceeds the reported axis travel.');
        return `G91\nM220 S100\nG1 ${p.axis.toUpperCase()}${distance} F${limits.speed * 60}\nM400`;
      }
      if (command.type === 'tools.select' || command.type === 'tools.park') {
        const i = head(command.params.toolId, 'tool');
        if (!(cap.constraints as { toolIds: readonly D.Id<'tool'>[] }).toolIds.includes(command.params.toolId)) fail('invalid-target', 'Unknown physical toolhead');
        if (command.type === 'tools.park' && !u1ActiveToolIds(snapshot)?.includes(command.params.toolId)) fail('stale-context', 'Only the currently mounted tool can be parked.');
        return command.type === 'tools.select' ? `T${i} A0` : `PARK_${extruder(i).toUpperCase()}`;
      }
      const i = head(command.params.extruderId, 'extruder'), p = command.params;
      if (u1ActiveToolIds(snapshot)?.[0] !== u1ToolId(i) || record(snapshot.status.toolhead).extruder !== extruder(i))
        fail('stale-context', 'The active tool changed. Review the current tool before extruding.');
      if (record(snapshot.status[extruder(i)]).can_extrude !== true) fail('precondition-failed', 'Heat the mounted nozzle before extruding.');
      if (![-10, 10].includes(p.distanceMm) || p.speed.kind !== 'specified' || p.speed.mmPerSecond !== 5)
        fail('out-of-range', 'Use a 10 mm move at 5 mm/s.');
      if (!(cap.constraints as D.PrinterCommandSpecs['extrusion.move']['constraints']).some(item => item.extruderId === p.extruderId))
        fail('invalid-target', 'Unknown extruder');
      return `M83\nM220 S100\nM221 S100\nG1 E${p.distanceMm} F300\nM400`;
    }
    case 'preferences.set': return u1PreferenceScripts(snapshot, command.params.changes).join('\n');
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
      const p = command.params;
      if (p.intent !== 'confirm' || !p.preset) fail('unsupported', 'Select a material to configure this toolhead');
      const constraint = cap.constraints as readonly D.MaterialConfigurationTarget[];
      if (!constraint.some(item => item.slotId === p.slotId)) fail('invalid-target', 'Unknown physical toolhead');
      const preset = p.preset;
      if (!preset.manufacturer || !preset.materialType || !preset.key) fail('invalid-request', 'Select a material with a brand and type');
      // Native preset keys are canonical names. Snapmaker's separate series is
      // the suffix of vendor + type (e.g. Snapmaker PLA SnapSpeed @U1).
      const name = preset.key.split('@')[0].trim(), prefix = `${preset.manufacturer} ${preset.materialType}`;
      const series = name.toLowerCase().startsWith(`${prefix.toLowerCase()} `) ? name.slice(prefix.length).trim() : '';
      const materialType = series ? `${preset.materialType}-${series}` : preset.materialType.includes('-') ? preset.materialType : `${preset.materialType}-Basic`;
      if (p.color && p.color.kind !== 'solid') fail('unsupported', 'This toolhead supports a solid color only');
      return u1DeviceCommand(snapshot, { type: 'materials.writeMetadata', params: { slotId: p.slotId,
        patch: { manufacturer: preset.manufacturer, materialType, ...(p.color ? { color: p.color } : {}) } } });
    }
    case 'materials.writeMetadata': {
      const p = command.params, i = head(p.slotId, 'slot');
      if (!p.patch || !Object.keys(p.patch).length || Object.keys(p.patch).some(key => !['manufacturer', 'materialType', 'color'].includes(key))) fail('invalid-request', 'Unsupported material fields');
      let script = `SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=${i}`;
      if (p.patch.manufacturer !== undefined || p.patch.materialType !== undefined) {
        const config = record(snapshot.status.print_task_config);
        const vendor = p.patch.manufacturer !== undefined ? p.patch.manufacturer : Array.isArray(config.filament_vendor) ? config.filament_vendor[i] : null;
        const previousType = Array.isArray(config.filament_type) ? config.filament_type[i] : null;
        const previousSubtype = Array.isArray(config.filament_sub_type) ? config.filament_sub_type[i] : null;
        const type = p.patch.materialType !== undefined ? p.patch.materialType : previousType && previousSubtype ? `${previousType}-${previousSubtype}` : previousType;
        if (typeof vendor !== 'string' || typeof type !== 'string') fail('invalid-request', 'Specify the material brand and type');
        // The displayed sync type is normalized (e.g. PLA HIGH SPEED). Retain
        // the actual device type/series when that displayed value is unchanged.
        const original = typeof previousType === 'string' && typeof previousSubtype === 'string'
          && type === u1FilamentType(previousType, previousSubtype);
        const [family, ...variant] = original ? [previousType, previousSubtype] : type.split('-');
        script += ` VENDOR=${text(vendor)} FILAMENT_TYPE=${text(family)} FILAMENT_SUBTYPE=${text(variant.join('-') || 'Basic')}`;
      }
      if (p.patch.color !== undefined) {
        if (!p.patch.color || p.patch.color.kind !== 'solid' || !/^#[0-9a-f]{8}$/i.test(p.patch.color.rgba)) fail('invalid-request', 'Select a solid RGBA color');
        script += ` FILAMENT_COLOR_RGBA=${p.patch.color.rgba.slice(1)}`;
      }
      return script;
    }
    default: fail('unsupported', 'Device command is unavailable');
  }
}
