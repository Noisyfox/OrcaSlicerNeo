/** U1 persistent preference translation and verification; never used by job preparation. */
import type * as D from './domain';
import type { U1DeviceSnapshot } from './snapmaker-device';
import { fail, record } from './moonraker-http';
interface Field { key: D.DevicePreferenceKey; label: string; object: string; path: string[]; command: string; parameter: string; choices: readonly D.DevicePreferenceValue[] }
const bool = [false, true] as const;
const fields: readonly Field[] = [
  { key: 'detectionEnabled', label: 'Visual detection', object: 'defect_detection', path: ['main_enable'], command: 'DEFECT_DETECTION_CONFIG', parameter: 'MAIN_ENABLE', choices: bool },
  { key: 'spaghettiDetection', label: 'Spaghetti detection', object: 'defect_detection', path: ['noodle', 'enable'], command: 'DEFECT_DETECTION_CONFIG', parameter: 'NOODLE_ENABLE', choices: bool },
  { key: 'spaghettiSensitivity', label: 'Spaghetti sensitivity', object: 'defect_detection', path: ['noodle', 'sensitivity'], command: 'DEFECT_DETECTION_CONFIG', parameter: 'NOODLE_SENSITIVITY', choices: ['low', 'high'] },
  { key: 'foreignObjectDetection', label: 'Bed foreign-object detection', object: 'defect_detection', path: ['clean_bed', 'enable'], command: 'DEFECT_DETECTION_CONFIG', parameter: 'CLEAN_BED_ENABLE', choices: bool },
  { key: 'foreignObjectSensitivity', label: 'Bed foreign-object sensitivity', object: 'defect_detection', path: ['clean_bed', 'sensitivity'], command: 'DEFECT_DETECTION_CONFIG', parameter: 'CLEAN_BED_SENSITIVITY', choices: ['low', 'high'] },
  { key: 'airPrintingDetection', label: 'Air-printing / filament motion detection', object: 'print_task_config', path: ['filament_entangle_detect'], command: 'SET_PRINT_PREFERENCES', parameter: 'FILAMENT_ENTANGLE_DETECT', choices: bool },
  { key: 'airPrintingSensitivity', label: 'Filament motion sensitivity', object: 'print_task_config', path: ['filament_entangle_sen'], command: 'SET_PRINT_PREFERENCES', parameter: 'FILAMENT_ENTANGLE_SEN', choices: ['low', 'medium', 'high'] },
  { key: 'autoRefill', label: 'Auto-refill', object: 'print_task_config', path: ['auto_replenish_filament'], command: 'SET_PRINT_PREFERENCES', parameter: 'AUTO_REPLENISH_FILAMENT', choices: bool },
  { key: 'allowDifferentColors', label: 'Allow different refill colors', object: 'print_task_config', path: ['replenish_ignore_color'], command: 'SET_PRINT_PREFERENCES', parameter: 'REPLENISH_IGNORE_COLOR', choices: bool },
  { key: 'lightsOffAfterPrint', label: 'Turn lights off after printing', object: 'print_task_config', path: ['end_led_turn_off'], command: 'SET_PRINT_PREFERENCES', parameter: 'END_LED_TURN_OFF', choices: bool },
];
function value(snapshot: U1DeviceSnapshot, field: Field): unknown { return field.path.reduce<unknown>((node, key) => record(node)[key], snapshot.status[field.object]); }
function available(snapshot: U1DeviceSnapshot) { return fields.filter(f => snapshot.objects.includes(f.object) && snapshot.commands.includes(f.command) && value(snapshot, f) !== undefined); }
export function u1Preferences(snapshot: U1DeviceSnapshot, target: D.PrinterTarget): D.DevicePreferences {
  return { fields: available(snapshot).map(f => ({ key: f.key, label: f.label, choices: f.choices,
    value: f.choices.includes(value(snapshot, f) as D.DevicePreferenceValue) ? { kind: 'known', value: value(snapshot, f) as D.DevicePreferenceValue, freshness: 'fresh', sourceRouteId: target.routeId, observedAtMs: null, receivedAtMs: snapshot.receivedAtMs } : { kind: 'unknown', reason: 'not-reported' } })) };
}
export function u1PreferenceCapability(snapshot?: U1DeviceSnapshot): D.CommandCapabilities['preferences.set'] {
  if (!snapshot) return { kind: 'unknown', reason: 'Device preferences have not been read' };
  const supported = available(snapshot);
  return supported.length ? { kind: 'supported', constraints: { fields: supported.map(f => f.key) } } : { kind: 'unsupported', layer: 'device', reason: 'No supported device preference fields were reported' };
}
export function u1PreferenceScripts(snapshot: U1DeviceSnapshot, changes: D.CommandOf<'preferences.set'>['params']['changes']): string[] {
  if (!Array.isArray(changes) || !changes.length || new Set(changes.map(c => c.key)).size !== changes.length) fail('invalid-request', 'Select distinct device preference fields');
  const groups = new Map<string, string[]>();
  for (const change of changes) {
    const field = available(snapshot).find(f => f.key === change.key);
    if (!field) fail('unsupported', 'Device preference is unavailable');
    if (!field.choices.includes(change.value)) fail('invalid-request', 'Invalid device preference value');
    if (value(snapshot, field) === change.value) continue;
    const params = groups.get(field.command) ?? []; groups.set(field.command, params);
    params.push(`${field.parameter}=${typeof change.value === 'boolean' ? Number(change.value) : change.value}`);
  }
  return [...groups].map(([command, params]) => `${command} ${params.join(' ')}`);
}
export function verifyU1Preferences(snapshot: U1DeviceSnapshot, changes: D.CommandOf<'preferences.set'>['params']['changes']): void {
  for (const change of changes) {
    const field = available(snapshot).find(f => f.key === change.key);
    if (!field || value(snapshot, field) !== change.value) fail('device-failed', 'Printer preferences could not be verified. Applied changes may remain.');
  }
}
