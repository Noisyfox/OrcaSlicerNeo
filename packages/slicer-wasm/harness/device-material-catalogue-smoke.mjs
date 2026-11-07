import assert from 'node:assert/strict';
import { createNozzleMappingFixture } from './nozzle-mapping-fixtures.mjs';

const { Module, call, command, ok, observe, context } = await createNozzleMappingFixture(process.argv[2]);
const identity = { manufacturer: 'Bambu Lab', model: 'H2D', externalRefs: [{ namespace: 'orca-printer-model', value: 'O1D' }] };
const request = { identity, mainNozzleDiameterMm: .4, toolIndex: 0, nozzleFlowType: 'Standard', supportsUserPresets: false };
const query = extra => command('orc_get_device_material_catalogue', { ...request, ...extra });
const before = JSON.stringify(observe());
const first = ok(query());
assert.ok(first.presets.length > 10, 'uses the full device catalogue');
assert.equal(new Set(first.presets.flatMap(p => p.catalogRefs.map(ref => ref.value))).size, first.presets.length, 'deduplicates filament identities');
assert.ok(first.presets.every(p => p.label && p.materialType && p.catalogRefs.length));
assert.ok(first.presets.some(p => p.label.includes('Bambu PLA Basic') && p.nozzleTemperatureRangeC?.min > 0));
ok(query({ toolIndex: 1, nozzleFlowType: 'High Flow' }));
assert.equal(JSON.stringify(observe()), before, 'catalogue reads preserve every native project owner');
assert.equal(query({ toolIndex: 99 }).ok, false);
assert.equal(query({ toolIndex: .5 }).ok, false);
assert.equal(query({ identity: { ...identity, model: 'Unknown', externalRefs: [] } }).ok, false);
assert.equal(JSON.stringify(observe()), before, 'failed reads are also pure');

// A 0.4+0.6 U1 preset must not make a uniform 0.4 catalogue ambiguous.
const u1 = { manufacturer: 'Snapmaker', model: 'Snapmaker U1', externalRefs: [] };
const snapSpeedId = ok(command('orc_match_filament_presets', [{ presetName: 'Snapmaker PLA SnapSpeed', manufacturer: 'Snapmaker',
  materialType: 'PLA HIGH SPEED', colorRgba: '#080A0DFF' }])).filamentIds[0];
for (const toolIndex of [0, 1, 2, 3]) {
  const catalogue = ok(query({ identity: u1, mainNozzleDiameterMm: .4, toolIndex, supportsUserPresets: true }));
  assert.ok(catalogue.presets.some(preset => preset.label === 'Snapmaker PLA SnapSpeed' && preset.nozzleTemperatureRangeC?.min > 0));
  assert.ok(catalogue.presets.find(preset => preset.label === 'Snapmaker PLA SnapSpeed').catalogRefs.some(ref => ref.value === snapSpeedId),
    'a reported U1 material matches the device catalogue even while the project is Bambu');
}
ok(query({ identity: u1, mainNozzleDiameterMm: .6, toolIndex: 2 }));
assert.equal(JSON.stringify(observe()), before, 'U1 catalogue reads preserve an unrelated Bambu project');

// Saved derived user material and its unsaved/history variants are not independent device identities.
const base = first.presets.find(p => p.label.includes('Bambu PLA Basic')).key;
let saved = ok(command('orc_prepare_user_preset', { history_context: context, action: 'save-as', kind: 'filament',
  canonical_name: base, expected_revision: call('orc_history_status').revision, name: 'Device catalogue user material' }));
ok(command('orc_finish_user_preset', { token: saved.token, commit: true }));
ok(command('orc_mutate_preset_draft', { history_context: context, action: 'set', kind: 'filament', canonical_name: 'Device catalogue user material',
  key: 'nozzle_temperature_range_low', value: '123', expected_revision: call('orc_history_status').revision }));
const edited = JSON.stringify(observe());
const withUsers = ok(query({ supportsUserPresets: true }));
assert.ok(!withUsers.presets.some(p => p.key === 'Device catalogue user material' || /\[snapshot /.test(p.key)), 'Orca root filter excludes derived and retained user presets');
assert.equal(JSON.stringify(observe()), edited, 'query does not commit an unsaved temperature override');

ok(call('orc_select_preset', ['string', 'string'], ['printer', 'Bambu Lab X1 Carbon 0.4 nozzle']));
const otherProject = JSON.stringify(observe());
const independent = ok(query());
assert.deepEqual(independent.presets.map(p => p.key).sort(), first.presets.map(p => p.key).sort(), 'connected-device catalogue is independent of the selected project printer');
assert.equal(JSON.stringify(observe()), otherProject);
console.log('Device material catalogue: native identity, nozzle variants, saved roots and read-only ownership passed.');
await Module.PThread?.terminateAllThreads();
