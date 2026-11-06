import { expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';
import { normalizeDeviceMaterialCatalogue, type DeviceMaterialCatalogueRequest } from './deviceMaterials';

const request: DeviceMaterialCatalogueRequest = { identity: { manufacturer: 'Bambu Lab', model: 'H2D', externalRefs: [] },
  mainNozzleDiameterMm: .4, toolIndex: 0, nozzleFlowType: 'Standard', supportsUserPresets: false };
it('reads a device catalogue without changing the selected project, rack or history', async () => {
  const client = createClient(async () => createMockModule());
  const before = [await client.getProfileSnapshot(), await client.getFilamentSessionSnapshot(), await client.getHistoryStatus()];
  expect(await client.getDeviceMaterialCatalogue(request)).toMatchObject({ ok: true, presets: [{ label: 'Generic PLA', nozzleTemperatureRangeC: { min: 190, max: 240 } }] });
  expect([await client.getProfileSnapshot(), await client.getFilamentSessionSnapshot(), await client.getHistoryStatus()]).toEqual(before);
});
it('rejects incomplete, duplicate or invalid temperature results instead of constructing writable settings', () => {
  const preset = { key: 'Generic PLA', label: 'Generic PLA', materialType: 'PLA', manufacturer: 'Generic',
    catalogRefs: [{ namespace: 'orca-filament', value: 'material' }], presetRef: null, nozzleTemperatureRangeC: { min: 190, max: 240 } };
  for (const presets of [[preset, preset], [{ ...preset, catalogRefs: [] }], [{ ...preset, nozzleTemperatureRangeC: { min: 240, max: 190 } }],
    [{ ...preset, nozzleTemperatureRangeC: { min: NaN, max: 240 } }], [{ ...preset, presetRef: {} }]])
    expect(normalizeDeviceMaterialCatalogue({ ok: true, presets })).toMatchObject({ ok: false });
  expect(normalizeDeviceMaterialCatalogue({ ok: false, error: 'No matching printer' })).toEqual({ ok: false, error: 'No matching printer' });
});
it('routes pure vendor/type/RGB matching through the native client', async () => {
  const client = createClient(async () => createMockModule());
  const before = await client.getHistoryStatus();
  expect(await client.matchFilamentPresets([{ manufacturer: 'Snapmaker', materialType: 'PLA HIGH SPEED', colorRgba: '#FF000080' }]))
    .toEqual(['OFZGmLwF']);
  expect(await client.getHistoryStatus()).toEqual(before);
});
