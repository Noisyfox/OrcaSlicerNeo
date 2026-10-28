import { expect, it } from 'vitest';
import { normalizePrinterConfigurationDocument as normalize } from './configuration';
it('retains physical printer preferences without inventing manual connection records', () => {
  const value = { version: 1, printers: [], printPreferences: { 'bambu:serial': { bedLeveling: 'auto', timelapse: true, timelapseStorage: 'external', sharedPressureAdvance: false } }, allowAbnormalStorage: true };
  expect(normalize(JSON.parse(JSON.stringify(value)))).toEqual(value);
  expect(normalize({ version: 1, printers: [] }).allowAbnormalStorage ?? false).toBe(false);
});
it.each([{ externalChangeAssist: true }, { flowCalibration: 'yes' }, { timelapse: 1 }, { timelapseStorage: 'usb' }])('rejects invalid or dialog-only preferences %o', preferences => {
  expect(() => normalize({ version: 1, printers: [], printPreferences: { physical: preferences } })).toThrow();
});
