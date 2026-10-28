import type * as D from '@orca/printer-control/domain';
import { bits, number, record, type Report } from './telemetry';
import { printerFilamentId } from './printResources';
export function sdcardState(p: Report): number | undefined {
  return bits(p.aux, 12, 2) ?? bits(p.home_flag, 8, 2) ?? (typeof p.sdcard === 'boolean' ? p.sdcard ? 1 : 0 : undefined);
}
export function printOptions(request: D.PrintPreparationRequest, p: Report, profile: Report, multipleExternal: boolean) {
  const options: D.PrintOptions = {}, descriptors: D.PrintOptionDescriptor[] = [], issues: D.PrintIssue[] = [];
  const flags = { ...record(profile.print), ...p, ...record(record(p.capabilities).flags) };
  const mode = (key: 'bedLeveling' | 'flowCalibration' | 'nozzleOffsetCalibration', label: string, supported: boolean, auto: boolean) => {
    if (!supported) return;
    const choices = auto ? ['auto', 'on', 'off'] as const : ['on', 'off'] as const;
    const saved = request.options[key]; options[key] = saved && choices.some(v => v === saved) ? saved : choices[0];
    descriptors.push({ key, label, choices: choices.map(value => ({ value, label: value === 'auto' ? 'Auto' : value === 'on' ? 'On' : 'Off' })), enabled: true });
  };
  const flow = profile.printer_series !== 'series_p' && (bits(p.fun, 7) ?? bits(p.home_flag, 16) ?? (flags.support_flow_calibration === true ? 1 : 0)) === 1;
  mode('bedLeveling', 'Bed leveling', Number(flags.support_bed_leveling) > 0, flags.support_bed_leveling === 2);
  mode('flowCalibration', 'Flow dynamics calibration', flow, flags.support_auto_flow_calibration === true);
  mode('nozzleOffsetCalibration', 'Nozzle offset calibration', flags.support_nozzle_offset_calibration === true, true);
  const excluded = Array.isArray(profile.auto_cali_not_support_filaments) ? profile.auto_cali_not_support_filaments : [];
  if (flow && request.requirements.materials.some(m => excluded.includes(printerFilamentId(m.presetId))) && options.flowCalibration !== 'off') {
    issues.push({ id: 'unsupported-flow-calibration', severity: options.flowCalibration === 'auto' ? 'block' : 'warning', message: options.flowCalibration === 'auto' ? 'Auto flow calibration is unavailable for these materials.' : 'The printer will skip flow calibration and use its previous value for these materials.' });
  }
  const booleanOption = (key: 'timelapse' | 'sharedPressureAdvance' | 'externalChangeAssist', label: string, value: boolean, enabled = true) => {
    options[key] = value; descriptors.push({ key, label, choices: [{ value: true, label: 'On' }, { value: false, label: 'Off' }], enabled });
  };
  if (bits(p.fun2, 3) === 1 && flow && options.flowCalibration === 'off') booleanOption('sharedPressureAdvance', 'Shared PA profile', request.options.sharedPressureAdvance ?? true);
  const internal = bits(p.fun, 28) === 1;
  const external = sdcardState(p) === 1;
  const warning = request.requirements.warnings.some(w => ['10014001', '10014002'].includes(w.code));
  const timelapse = flags.support_timelapse === true && (internal || external) && !warning;
  booleanOption('timelapse', 'Timelapse', timelapse && (request.options.timelapse ?? true), timelapse);
  let storage = request.options.timelapseStorage ?? (internal ? 'internal' : 'external');
  if (storage === 'external' && !external && internal) {
    storage = 'internal'; issues.push({ id: 'timelapse-storage-fallback', severity: 'notice', message: 'External recording storage is unavailable. This print uses internal storage; your saved preference is retained.' });
  } else if (storage === 'internal' && !internal) storage = 'external';
  options.timelapseStorage = storage;
  if (internal) descriptors.push({ key: 'timelapseStorage', label: 'Timelapse storage', choices: [{ value: 'internal', label: 'Internal' }, { value: 'external', label: 'External' }], enabled: timelapse });
  if (!timelapse && (request.options.timelapse ?? true)) issues.push({ id: 'timelapse-disabled', severity: 'notice', message: 'Timelapse is unavailable for this print. Your saved preference is retained.' });
  if (bits(p.fun, 48) === 1 || bits(p.flag3, 16) === 1) booleanOption('externalChangeAssist', 'Multi-color with external', multipleExternal && (request.options.externalChangeAssist ?? false), multipleExternal);
  return { options, descriptors, issues, flags, internal };
}
