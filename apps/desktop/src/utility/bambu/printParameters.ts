import type * as D from '@orca/printer-control/domain';
import type { NativePrintParameters } from '@orca/bambu-native';
import { printerFilamentId } from './printResources';
import { bits, record, records, type Report } from './telemetry';
import { physicalTool } from './printMapping';
export function printParameters(request: D.PrintSubmissionRequest, prepared: D.PrintPreparation, name: string, report: Report = {}): Partial<NativePrintParameters> {
  const r = request.requirements, o = prepared.options;
  const packed: number[] = r.filamentMap.map(() => -1), detailed = r.filamentMap.map(() => ({ ams_id: 255, slot_id: 255 }));
  const info: Record<string, unknown>[] = r.filamentMap.map(() => ({ ams: -1, targetColor: '', filamentId: '', filamentType: '' }));
  let useAms = false;
  const rgba = (color: string | null) => color ? color.replace('#', '').padEnd(8, 'F') : '';
  for (const m of r.materials) {
    const path = prepared.bindings.find(b => b.materialKey === m.key)?.pathId;
    const match = /^path:(\d+):(\d+):(\d+)$/.exec(path ?? '');
    if (!match) throw new Error('Invalid material path');
    const unit = Number(match[1]), slot = Number(match[2]);
    const external = unit === 254 || unit === 255;
    const unitType = bits(records(record(report.ams).ams).find(a => String(a.id) === String(unit))?.info, 0, 4);
    const tray = external ? unit : unitType === 5 ? 24 + slot : unit >= 128 ? unit + slot : unit * 4 + slot;
    packed[m.index] = external ? -1 : tray;
    detailed[m.index] = { ams_id: unit, slot_id: slot };
    const target = prepared.candidates.find(c => c.materialKey === m.key && c.pathId === path);
    info[m.index] = { ams: tray, targetColor: rgba(target?.color ?? null), sourceColor: rgba(m.color), filamentId: printerFilamentId(m.presetId), filamentType: m.type, nozzleId: physicalTool(m.toolIndex, r.nozzleDiameters.length) };
    useAms ||= !external;
  }
  const flow = (index: number) => ({ Standard: 'standard_flow', 'High Flow': 'high_flow', 'TPU High Flow': 'tpu_high_flow', 'E3D High Flow': 'e3d_high_flow' }[r.nozzleFlowTypes[index]] ?? 'standard_flow');
  const mode = (value: D.PrintCalibrationMode | undefined) => value === 'auto' ? 2 : value === 'on' ? 1 : 0;
  return { task_name: name, project_name: name, preset_name: r.printerModel, plate_index: 1, ftp_file: `${name}.gcode.3mf`,
    ams_mapping: JSON.stringify(packed), ams_mapping2: JSON.stringify(detailed), ams_mapping_info: JSON.stringify(info),
    nozzles_info: JSON.stringify(r.nozzleDiameters.length === 2 ? r.nozzleDiameters.map((diameter, index) => ({ id: physicalTool(index, 2), type: null, flowSize: flow(index), diameter })) : []),
    task_use_ams: useAms, task_bed_leveling: o.bedLeveling === 'on', task_flow_cali: o.flowCalibration === 'on',
    task_record_timelapse: o.timelapse ?? false, task_timelapse_use_internal: o.timelapseStorage === 'internal',
    auto_bed_leveling: mode(o.bedLeveling), auto_flow_cali: mode(o.flowCalibration), auto_offset_cali: mode(o.nozzleOffsetCalibration),
    extruder_cali_manual_mode: o.sharedPressureAdvance === undefined ? -1 : o.sharedPressureAdvance ? 0 : 1,
    task_ext_change_assist: o.externalChangeAssist ?? false, try_emmc_print: false, print_type: 'from_normal',
    task_bed_type: 'auto' };
}
