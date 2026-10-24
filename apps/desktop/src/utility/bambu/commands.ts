import { createHash } from 'node:crypto';
import type * as D from '@orca/printer-control/domain';
import { bambuCapabilities } from '../../shared/bambuPrinters';
import { cameraProtocol, bits, id, number, record, records, type Report, type TelemetryProjection } from './telemetry';
import { protocolReport } from './protocol';
const known = <T>(value: D.Reading<T>): T | undefined => value.kind === 'known' && value.freshness === 'fresh' ? value.value : undefined;
const fail = (code: D.ErrorCode, message: string): D.PrinterError => ({ code, message });
const supported = <T extends object>(constraints: T): D.Capability<T> => ({ kind: 'supported', constraints });
const nonempty = <T>(values: T[]) => values.length ? values as [T, ...T[]] : null;
function range(value: unknown): D.Range {
  const values = Array.isArray(value) ? value.map(number) : [];
  return { min: values[0] ?? null, max: values[1] ?? null, step: 1 };
}
export interface CommandContext extends TelemetryProjection { target: D.PrinterTarget; configurationRevision: string; model: string | null; recovery?: { action: D.PrinterAction; kind: 'resume' | 'abort' }[] }
export interface PreparedCommand {
  section: 'print' | 'system'; fields: Report; qos: number;
  /** Only explicit report predicates confirm completion; without one, ACK ends tracking as accepted. */
  confirmed?: (next: TelemetryProjection) => boolean;
}
export function commandCapabilities(context: CommandContext): D.PrinterCapabilities {
  const result = bambuCapabilities(); result.currentPrintPreview = supported({ mimeTypes: ['image/jpeg', 'image/png'] as const }); const c = result.commands;
  c['actions.invoke'] = supported({ sources: ['alerts'] });
  const p = protocolReport(context.model, context.report), topology = context.values.descriptor.topology;
  const protocol = cameraProtocol(context.report);
  result.cameras = [{ cameraId: id('chamber'), snapshot: { kind: 'unsupported', layer: 'adapter', reason: 'Snapshots are not supported.' },
    liveView: protocol === 'local' || protocol === 'rtsps' ? supported({ transports: [protocol === 'local' ? 'jpeg-frames' : 'mse-fmp4'] as const, profiles: [], maxConcurrentViews: 1, requestIdRetentionMs: 300_000 })
      : protocol === 'unknown' ? { kind: 'unknown', reason: 'LAN camera information has not been reported.' }
      : { kind: 'unsupported', layer: protocol === 'rtsp' ? 'adapter' : 'device', reason: protocol === 'disabled' ? 'LAN live view is disabled on the printer.' : protocol === 'unavailable' ? 'The printer reports its camera unavailable.' : 'This LAN camera protocol is not supported.' } }];
  for (const name of ['jobs.pause', 'jobs.resume', 'jobs.cancel'] as const) c[name] = supported({});
  c['jobs.setSpeed'] = supported({ modes: [{ id: '1', label: 'Silent' }, { id: '2', label: 'Standard' }, { id: '3', label: 'Sport' }, { id: '4', label: 'Ludicrous' }] });
  if (p.support_refresh_nozzle === true) c['hardware.refreshNozzles'] = supported({});
  const heaters = nonempty(topology.heaters.filter(heater => heater.role !== 'chamber' || p.support_chamber_temp_edit === true).map(heater => ({ heaterId: heater.id,
    targetC: range(heater.role === 'nozzle' ? p.nozzle_temp_range : heater.role === 'bed' ? p.bed_temp_range : p.support_chamber_temp_edit_range) })));
  if (heaters) c['thermal.setTarget'] = supported(heaters);
  const fans = nonempty(topology.fans.map(fan => {
    const part = records(record(record(p.device).airduct).parts).find(part => bits(part.id, 0, 4) === 0 && `fan:${bits(part.id, 4, 8)}` === fan.id);
    const min = bits(part?.range, 0, 16), max = bits(part?.range, 16, 16);
    const reported = min !== undefined && max !== undefined && min <= max && max > 0 && max <= 100;
    return { fanId: fan.id, speedFraction: { min: reported ? min / 100 : 0, max: reported ? max / 100 : 1, step: null } };
  }));
  if (fans) c['fans.setSpeed'] = supported(fans);
  const lights = nonempty(topology.lights.filter(light => ['chamber_light', 'chamber_light2'].includes(light.id)).map(light => light.id));
  if (lights) c['lights.set'] = supported({ lightIds: lights });
  const motion = topology.motionGroups[0];
  if (motion && bits(p.fun, 32) === 1) c['motion.home'] = supported([{ motionGroupId: motion.id, axes: ['x', 'y', 'z'] }]);
  if (motion && bits(p.fun, 38) === 1) c['motion.jog'] = supported(nonempty(['x', 'y', 'z'].map(axis => ({ motionGroupId: motion.id, axis: axis as D.Axis, kind: 'step' as const,
    steps: [{ id: 'small', label: 'Small step' }, { id: 'large', label: 'Large step' }] as const })))!);
  const extruders = nonempty(topology.extruders.filter(ext => records(record(record(p.device).extruder).info).some(item => `extruder:${item.id}` === ext.id)).map(ext => ({ extruderId: ext.id,
    distanceMm: { min: -10, max: 10, step: 10 }, speed: { kind: 'device-controlled' as const } })));
  if (extruders) c['extrusion.move'] = supported(extruders);
  const tools = nonempty(topology.tools.map(tool => tool.id));
  if (tools && tools.length > 1 && records(record(record(p.device).extruder).info).length) c['tools.select'] = supported({ toolIds: tools });
  const paths = nonempty(context.values.materials.topology.paths.map(path => path.id));
  if (paths && p.support_command_ams_switch === true) { c['materials.load'] = supported({ pathIds: paths }); c['materials.switch'] = supported({ pathIds: paths }); }
  if (tools && p.support_command_ams_switch === true) c['materials.unload'] = supported({ toolIds: tools });
  result.revision = createHash('sha256').update(JSON.stringify({ commands: c, cameras: result.cameras })).digest('hex'); return result;
}
function within(value: number, limit: D.Range) { return Number.isFinite(value) && (limit.min === null || value >= limit.min) && (limit.max === null || value <= limit.max); }
function trayFor(p: Report, pathId: string | null | undefined): Report {
  if (!pathId) return {};
  const [, unit, slot] = pathId.split(':');
  if (unit === '255' || unit === '254') return Array.isArray(p.vir_slot)
    ? records(p.vir_slot).find(tray => String(tray.id) === unit) ?? {}
    : unit === '255' ? record(p.vt_tray) : {};
  return records(records(record(p.ams).ams).find(ams => String(ams.id) === unit)?.tray).find(tray => String(tray.id) === slot) ?? {};
}
function materialTemperature(tray: Report): number | undefined {
  const low = number(tray.nozzle_temp_min), high = number(tray.nozzle_temp_max);
  return low !== undefined && high !== undefined && low > 0 && high >= low ? Math.round((low + high) / 2) : undefined;
}
export function prepareCommand(context: CommandContext, command: D.PrinterCommand): D.Result<PreparedCommand> {
  const capabilities = commandCapabilities(context), capability = capabilities.commands[command.type];
  const reject = (code: D.ErrorCode, message: string): D.Result<never> => ({ ok: false, error: fail(code, message) });
  if (capability.kind !== 'supported') return reject('unsupported', capability.kind === 'unsupported' ? capability.reason : capability.reason);
  if (!context.fresh) return reject('offline', 'Wait for fresh printer status.');
  const p = protocolReport(context.model, context.report), state = context.values, topology = state.descriptor.topology;
  const phase = known(state.status.printStatus.phase);
  const idle = phase === 'idle' || phase === 'completed' || phase === 'cancelled' || phase === 'failed';
  const task = known(state.status.printStatus.taskId);
  const sameTask = (next: TelemetryProjection) => task === undefined || known(next.values.status.printStatus.taskId) === task;
  const prepared = (fields: Report, confirmed?: PreparedCommand['confirmed'], section: 'print' | 'system' = 'print', qos = 1): D.Result<PreparedCommand> => ({ ok: true, value: { section, fields, qos, confirmed } });
  const busyMaterial = state.materials.state.tools.some(tool => { const activity = known(tool.activity); return activity !== undefined && activity !== 'idle'; });
  if (['motion.home', 'motion.jog', 'extrusion.move', 'tools.select', 'materials.load', 'materials.unload', 'materials.switch', 'hardware.refreshNozzles'].includes(command.type)
    && (!idle && phase !== 'paused' || busyMaterial)) return reject('busy', 'The printer is busy. Wait until movement or material changing is available.');
  if (bits(p.job_attr, 4, 4) !== undefined && bits(p.job_attr, 4, 4)! > 1 && command.type !== 'jobs.cancel' && command.type !== 'lights.set') return reject('precondition-failed', 'This processing task must be controlled on the printer.');
  switch (command.type) {
    case 'jobs.pause':
      if (phase !== 'printing') return reject('precondition-failed', 'Only a running print can be paused.');
      return prepared({ command: 'pause', param: '' }, next => sameTask(next) && known(next.values.status.printStatus.phase) === 'paused');
    case 'jobs.resume':
      if (phase !== 'paused') return reject('precondition-failed', 'Only a paused print can be resumed.');
      return prepared({ command: 'resume', param: '' }, next => sameTask(next) && known(next.values.status.printStatus.phase) === 'printing');
    case 'jobs.cancel':
      if (!['printing', 'paused', 'preparing'].includes(phase ?? '')) return reject('precondition-failed', 'There is no active print to cancel.');
      return prepared({ command: 'stop', param: '' }, next => ['idle', 'cancelled', 'failed'].includes(known(next.values.status.printStatus.phase) ?? '') && (known(next.values.status.printStatus.taskId) === null || sameTask(next)));
    case 'jobs.setSpeed':
      if (!['printing', 'paused'].includes(phase ?? '')) return reject('precondition-failed', 'Print speed is available during a print.');
      if (!['1', '2', '3', '4'].includes(command.params.modeId)) return reject('out-of-range', 'Select a supported speed mode.');
      return prepared({ command: 'print_speed', param: command.params.modeId }, next => sameTask(next) && known(next.values.status.printStatus.speedModeId) === command.params.modeId, 'print', 0);
    case 'actions.invoke': {
      const ref = command.params.actionRef;
      const recovery = context.recovery?.find(item => item.action.actionRef.token === ref.token);
      if (!recovery || ref.printerId !== context.target.printerId || ref.routeId !== context.target.routeId || ref.configurationRevision !== context.configurationRevision) return reject('stale-context', 'This recovery action is no longer applicable.');
      return prepared({ command: 'ams_control', param: recovery.kind }, undefined, 'print', 0);
    }
    case 'hardware.refreshNozzles': return prepared({ command: 'refresh_nozzle' });
    case 'thermal.setTarget': {
      const { heaterId, targetC } = command.params;
      const limits = capabilities.commands['thermal.setTarget'];
      const limit = limits.kind === 'supported' ? limits.constraints.find(item => item.heaterId === heaterId)?.targetC : undefined;
      if (!limit) return reject('invalid-target', 'The heater is no longer available.');
      if (!Number.isInteger(targetC) || targetC < 0 || !within(targetC, limit)) return reject('out-of-range', 'Enter a temperature within the reported heater limits.');
      if (targetC !== 0 && limit.max === null) return reject('precondition-failed', 'The maximum heater temperature is unknown.');
      if (heaterId === 'chamber' && !idle && number(record(record(p.device).airduct).modeCur) === 0) return reject('precondition-failed', 'Chamber temperature cannot be changed while printing in cooling mode.');
      const fields = heaterId.startsWith('nozzle:') ? records(record(record(p.device).extruder).info).length ? { command: 'set_nozzle_temp', extruder_index: Number(heaterId.split(':')[1]), target_temp: targetC } : { command: 'gcode_line', param: `M104 S${targetC}\n` }
        : heaterId === 'bed' ? bits(p.fun, 39) === 1 ? { command: 'set_bed_temp', temp: targetC } : { command: 'gcode_line', param: `M140 S${targetC}\n` }
        : { command: 'set_ctt', ctt_val: targetC };
      return prepared(fields, next => known(next.values.thermal.find(heater => heater.heaterId === heaterId)?.targetC ?? { kind: 'unknown', reason: 'not-reported' }) === targetC);
    }
    case 'fans.setSpeed': {
      const { fanId, speedFraction } = command.params;
      if (!topology.fans.some(fan => fan.id === fanId)) return reject('invalid-target', 'The fan is no longer available.');
      const supported = capabilities.commands['fans.setSpeed'];
      const limit = supported.kind === 'supported' ? supported.constraints.find(item => item.fanId === fanId)?.speedFraction : undefined;
      if (!limit || !within(speedFraction, limit)) return reject('out-of-range', 'Choose a speed within the reported fan limits.');
      const index = Number(fanId.split(':')[1]); const modern = records(record(record(p.device).airduct).parts).length > 0;
      return prepared(modern ? { command: 'set_fan', fan_index: index, speed: Math.round(speedFraction * 100) } : { command: 'gcode_line', param: `M106 P${index} S${Math.round(speedFraction * 255)}\n` }, next => {
        const current = known(next.values.actuators.fans.find(fan => fan.fanId === fanId)?.speedFraction ?? { kind: 'unknown', reason: 'not-reported' }); return current !== undefined && Math.abs(current - speedFraction) < 0.04;
      }, 'print', 0);
    }
    case 'lights.set': {
      const c = capabilities.commands['lights.set'];
      if (c.kind !== 'supported' || !c.constraints.lightIds.includes(command.params.lightId)) return reject('invalid-target', 'The light is no longer available.');
      return prepared({ command: 'ledctrl', led_node: command.params.lightId, led_mode: command.params.on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 }, next => known(next.values.actuators.lights.find(light => light.lightId === command.params.lightId)?.on ?? { kind: 'unknown', reason: 'not-reported' }) === command.params.on, 'system', 0);
    }
    case 'motion.home':
      if (command.params.motionGroupId !== 'gantry' || new Set(command.params.axes).size !== 3 || !['x', 'y', 'z'].every(axis => command.params.axes.includes(axis as D.Axis))) return reject('invalid-request', 'This printer supports only the complete home action.');
      if (!idle) return reject('busy', 'Homing is available only while idle.');
      return prepared({ command: 'back_to_center' });
    case 'motion.jog': {
      const v = command.params;
      if (v.motionGroupId !== 'gantry' || v.kind !== 'step' || !['x', 'y', 'z'].includes(v.axis) || !['small', 'large'].includes(v.stepId)) return reject('invalid-request', 'Select a reported firmware step.');
      const homed = known(state.motion.find(group => group.motionGroupId === v.motionGroupId)?.homedAxes ?? { kind: 'unknown', reason: 'not-reported' });
      if (!homed?.includes(v.axis)) return reject('precondition-failed', 'Home the requested axis before moving.');
      return prepared({ command: 'xyz_ctrl', axis: v.axis.toUpperCase(), dir: v.direction === 'positive' ? 1 : -1, mode: v.stepId === 'large' ? 1 : 0 }, undefined, 'print', 0);
    }
    case 'extrusion.move': {
      const v = command.params, tool = topology.tools.find(tool => tool.extruderId === v.extruderId);
      if (!tool) return reject('invalid-target', 'The extruder is no longer available.');
      if (v.speed.kind !== 'device-controlled' || ![-10, 10].includes(v.distanceMm)) return reject('out-of-range', 'Use a 10 mm extrusion or retraction at the device-controlled speed.');
      const material = state.materials.state.tools.find(value => value.toolId === tool.id);
      const tray = trayFor(p, material ? known(material.loadedPathId) ?? known(material.selectedPathId) : undefined);
      const minimum = number(tray.nozzle_temp_min);
      const sensor = state.sensors.readings.find(sensor => sensor.sensorId === `${tool.nozzleId}:temperature` && sensor.kind === 'temperature');
      const current = sensor?.kind === 'temperature' ? known(sensor.reading) : undefined;
      if (minimum === undefined || minimum <= 0 || current === undefined || current < minimum) return reject('precondition-failed', minimum && minimum > 0 ? `Heat the selected nozzle to at least ${minimum} °C before extrusion.` : 'The loaded material temperature requirement is unknown.');
      return prepared({ command: 'set_extrusion_length', extruder_index: Number(v.extruderId.split(':')[1]), length: v.distanceMm }, undefined, 'print', 0);
    }
    case 'tools.select':
      if (!topology.tools.some(tool => tool.id === command.params.toolId)) return reject('invalid-target', 'The tool is no longer available.');
      return prepared({ command: 'select_extruder', extruder_index: Number(command.params.toolId.split(':')[1]) }, next => known(next.values.status.activeToolIds)?.includes(command.params.toolId) === true);
    case 'materials.load': case 'materials.switch': case 'materials.unload': {
      const path = command.type === 'materials.unload' ? undefined : state.materials.topology.paths.find(path => path.id === command.params.pathId);
      const toolId = command.type === 'materials.unload' ? command.params.toolId : path?.toolId;
      if (!toolId || !topology.tools.some(tool => tool.id === toolId)) return reject('invalid-target', 'The material path or tool is no longer available.');
      const tool = state.materials.state.tools.find(tool => tool.toolId === toolId);
      const loaded = tool ? known(tool.loadedPathId) : undefined;
      const slot = state.materials.state.slots.find(slot => slot.slotId === path?.slotId);
      if (slot && known(slot.presence) === 'empty') return reject('precondition-failed', 'The selected material slot is empty.');
      const [, unit, tray] = (path?.id ?? loaded ?? '').split(':');
      if (unit === undefined) return reject('precondition-failed', 'The loaded material path is unknown.');
      const loading = command.type !== 'materials.unload';
      const next = materialTemperature(trayFor(p, path?.id));
      const previous = materialTemperature(trayFor(p, loaded));
      // Orca's external-load handler uses the selected spool's range for both temperatures.
      // Its command encoder aliases 254 to 255; retain the original path for confirmation.
      const external = unit === '254' || unit === '255', wireUnit = unit === '254' ? 255 : Number(unit);
      const fields: Report = { command: 'ams_change_filament', curr_temp: loading ? (external ? next : previous) ?? -1 : 210, tar_temp: loading ? next ?? -1 : 210,
        ams_id: wireUnit, slot_id: loading ? Number(tray) : 255, target: loading ? wireUnit < 16 ? wireUnit * 4 + Number(tray) : wireUnit : 255 };
      if (bits(p.aux, 29) === 1) fields.extruder_id = Number(toolId.split(':')[1]);
      return prepared(fields, next => {
        const current = next.values.materials.state.tools.find(tool => tool.toolId === toolId);
        return !!current && known(current.activity) === 'idle' && known(current.loadedPathId) === (loading ? path!.id : null);
      }, 'print', 0);
    }
    default: return reject('unsupported', 'This operation is not included in Bambu control.');
  }
}
export function commandBasis(context: CommandContext): D.CommandEvaluation['basis'] {
  const task = known(context.values.status.printStatus.taskId);
  return { capabilityRevision: commandCapabilities(context).revision, topologyRevision: context.values.descriptor.topology.revision,
    inventoryRevision: context.values.materials.state.inventoryRevision, ...(task ? { expectedTaskId: task } : {}) };
}
