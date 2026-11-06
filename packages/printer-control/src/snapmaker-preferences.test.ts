import { it, expect } from 'vitest';
import { u1Preferences, u1PreferenceScripts, verifyU1Preferences } from './snapmaker-preferences';
import type { U1DeviceSnapshot } from './snapmaker-device';
import type * as D from './domain';
const snapshot: U1DeviceSnapshot = { objects: ['defect_detection', 'print_task_config'], commands: ['DEFECT_DETECTION_CONFIG', 'SET_PRINT_PREFERENCES'], receivedAtMs: 100, status: {
  defect_detection: { main_enable: true, noodle: { enable: false, sensitivity: 'low' }, clean_bed: { enable: true, sensitivity: 'high' } },
  print_task_config: { auto_replenish_filament: false, replenish_ignore_color: false, filament_entangle_detect: true, filament_entangle_sen: 'medium', end_led_turn_off: true },
} };
it('writes only changed fields and preserves independent detection and print-option fields', () => {
  expect(u1PreferenceScripts(snapshot, [{ key: 'autoRefill', value: true }, { key: 'lightsOffAfterPrint', value: true }, { key: 'spaghettiSensitivity', value: 'high' }])).toEqual([
    'SET_PRINT_PREFERENCES AUTO_REPLENISH_FILAMENT=1', 'DEFECT_DETECTION_CONFIG NOODLE_SENSITIVITY=high',
  ]);
  expect(() => u1PreferenceScripts(snapshot, [{ key: 'spaghettiSensitivity', value: 'medium' }])).toThrow();
  expect(() => u1PreferenceScripts(snapshot, [{ key: 'autoRefill', value: 'high' }])).toThrow();
  expect(() => u1PreferenceScripts(snapshot, [{ key: 'autoRefill', value: true }, { key: 'autoRefill', value: false }])).toThrow();
});
it('verifies explicit values and treats unavailable fields as a verification failure', () => {
  expect(() => verifyU1Preferences(snapshot, [{ key: 'autoRefill', value: true }])).toThrow(/verified/);
  verifyU1Preferences(snapshot, [{ key: 'autoRefill', value: false }]);
  expect(() => verifyU1Preferences({ ...snapshot, status: {} }, [{ key: 'autoRefill', value: false }])).toThrow(/verified/);
  const fields = u1Preferences(snapshot, { printerId: 'p' as D.Id<'printer'>, routeId: 'r' as D.Id<'route'> }).fields;
  expect(fields.find(f => f.key === 'airPrintingSensitivity')?.choices).toEqual(['low', 'medium', 'high']);
  expect(fields.find(f => f.key === 'spaghettiSensitivity')?.choices).toEqual(['low', 'high']);
});
