import type { PrintPreferences } from './domain/print-options';
const modes = ['auto', 'on', 'off'];
export const printPreferenceKeys = ['bedLeveling', 'flowCalibration', 'nozzleOffsetCalibration', 'timelapse', 'timelapseStorage', 'sharedPressureAdvance'] as const;
export function normalizePrintPreferences(value: unknown): PrintPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Print preferences must be an object');
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const valid = ['bedLeveling', 'flowCalibration', 'nozzleOffsetCalibration'].includes(key) ? modes.includes(String(field))
      : key === 'timelapseStorage' ? field === 'internal' || field === 'external'
      : ['timelapse', 'sharedPressureAdvance'].includes(key) && typeof field === 'boolean';
    if (!valid) throw new Error('Invalid print preference');
    result[key] = field;
  }
  return result;
}
