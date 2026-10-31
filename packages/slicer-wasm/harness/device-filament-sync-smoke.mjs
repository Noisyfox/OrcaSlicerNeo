import assert from 'node:assert/strict';
import { createNozzleMappingFixture } from './nozzle-mapping-fixtures.mjs';
const { Module, call, command, ok, context, observe } = await createNozzleMappingFixture(process.argv[2]);
const rack = () => ok(call('orc_get_filament_session_snapshot'));
const history = () => call('orc_history_status');
const identity = { manufacturer: 'Bambu Lab', model: 'H2D', externalRefs: [{ namespace: 'orca-printer-model', value: 'O1D' }] };
const source = (slotId, color, type = 'PLA', refs = [{ namespace: 'orca-filament', value: 'OFoiVqVM' }]) =>
  ({ slotId, catalogRefs: refs, materialType: type, colour: { kind: 'solid', color }, toolIndices: [0, 1] });
const sources = [source('opaque:left/tray', '#123456'), source('opaque:empty/tray', '#ABCDEF'), source('opaque:duplicate/tray', '#ABCDEF')];
const request = extra => ({ version: 1, revision: history().revision, identity, sources, ...extra });
const prepare = extra => command('orc_prepare_material_import', request(extra));
const apply = extra => command('orc_apply_material_import', request({ mode: 'mapping', colourOnly: false, appendUnused: true,
  mapping: rack().slots.map(() => sources[0].slotId), replacements: rack().slots.map(() => null), ...extra }));
command('orc_history_reset', context);
const before = rack();
const pickerRequest = request({ sources: [...sources,
  source('no-id', '#222222', 'PLA', []), source('wrong-type', '#333333', 'Unobtainium', [{ namespace: 'vendor', value: 'unknown' }]),
  source('external', '#765432', 'PETG', [{ namespace: 'vendor', value: 'unknown' }])] });
const pickerBefore = JSON.stringify(observe());
const menu = ok(command('orc_get_device_filament_options', pickerRequest));
assert.equal(JSON.stringify(observe()), pickerBefore, 'menu projection does not mutate native owners');
assert.deepEqual(menu.options.map(o => o.slotId), [...sources.map(s => s.slotId), 'external']);
assert.match(menu.options.at(-1).preset, /Generic PETG/);
assert.equal(command('orc_get_device_filament_options', { ...pickerRequest, identity: { ...identity, externalRefs: [], model: 'Different' } }).error_code, 'printer_model_mismatch');
const selected = ok(command('orc_select_filament_slot_preset', { version: 1, revision: history().revision, slot: 1,
  preset: menu.options[0].preset, deviceSource: { identity, material: sources[0] } }));
assert.equal(selected.result.mutation.history_entry_delta, 1);
assert.equal(rack().slots[0].colour.effective, '#123456');
assert.equal(rack().slots.length, before.slots.length);
assert.deepEqual(rack().slots.map(s => s.logical_id), before.slots.map(s => s.logical_id));
const pickerAfter = JSON.stringify(observe());
assert.equal(command('orc_select_filament_slot_preset', { version: 1, revision: history().revision, slot: 1,
  preset: menu.options[0].preset, deviceSource: { identity, material: { ...sources[0], colour: { kind: 'solid', color: 'invalid' } } } }).ok, false);
assert.equal(JSON.stringify(observe()), pickerAfter, 'invalid device selection leaves every owner unchanged');
ok(command('orc_history_undo', context));
assert.deepEqual(rack().slots, before.slots);
const ready = ok(prepare());
assert.equal(ready.requiresReview, true, 'occupied plates require material review');
assert.equal(ready.sources[0].warning, null);
assert.match(ready.sources[0].preset, /Bambu PLA Basic/);
assert.equal(ready.references.length, before.slots.length);
ok(prepare({ identity: { ...identity, model: 'Other compatible device', externalRefs: [{ namespace: 'orca-compatible-printer-model', value: 'O1D' }] } }));
// Unreported identity is different from a reported identity unknown to the catalogue.
const unidentified = [source('external/no-type', '#00000000', '', []), source('external/type-only', '#EE0011', 'PLA', [{ namespace: 'provider', value: '' }])];
const mixedSources = [unidentified[0], ...sources, unidentified[1]];
const eligible = ok(prepare({ sources: mixedSources }));
assert.deepEqual(eligible.sources.map(s => s.slotId), sources.map(s => s.slotId));
assert.deepEqual(ok(command('orc_get_device_filament_options', request({ sources: mixedSources }))).options.map(s => s.slotId), sources.map(s => s.slotId));
const noIdentityBefore = JSON.stringify(observe());
assert.equal(apply({ mode: 'rebuild', sources: unidentified, mapping: [], replacements: [] }).error_code, 'unresolved_material');
assert.equal(JSON.stringify(observe()), noIdentityBefore, 'unidentified-only import does not change native owners or history');
ok(apply({ mode: 'rebuild', sources: mixedSources, mapping: [], replacements: before.slots.map(() => null) }));
assert.equal(rack().slots.length, sources.length, 'rebuild excludes unknown external records without compressing valid sources incorrectly');
assert.deepEqual(rack().slots.map(s => s.colour.effective), ['#123456', '#ABCDEF', '#ABCDEF']);
ok(command('orc_history_undo', context));
assert.deepEqual(rack().slots, before.slots);
ok(command('orc_history_redo', context));
assert.equal(rack().slots.length, sources.length);
ok(command('orc_history_undo', context));
ok(apply({ sources: [unidentified[0], sources[0], unidentified[1]], mapping: before.slots.map(() => unidentified[0].slotId) }));
assert.deepEqual(rack().slots.slice(0, before.slots.length), before.slots, 'invalid source mappings preserve existing slots');
assert.equal(rack().slots.length, before.slots.length + 1, 'append includes only the identified unused source');
ok(command('orc_history_undo', context));
for (const mode of ['mapping', 'rebuild']) {
  const materialSources = mode === 'mapping' ? mixedSources : [unidentified[0], sources[0]];
  ok(apply({ mode, sources: materialSources, mapping: before.slots.map((_, i) => i ? sources[0].slotId : unidentified[0].slotId),
    replacements: before.slots.map(() => null), colourOnly: true, appendUnused: true }));
  assert.deepEqual(rack().slots.map(s => [s.logical_id, s.preset]), before.slots.map(s => [s.logical_id, s.preset]), 'color-only never changes rack size, identities or presets');
  assert.deepEqual(rack().assignments, before.assignments);
  assert.equal(rack().slots[mode === 'mapping' ? 1 : 0].colour.effective, '#123456');
  if (mode === 'mapping') assert.deepEqual(rack().slots[0], before.slots[0]);
  else assert.deepEqual(rack().slots[1], before.slots[1]);
  ok(command('orc_history_undo', context));
  assert.deepEqual(rack().slots, before.slots);
}
ok(apply({ mode: 'rebuild', sources: mixedSources, colourOnly: true, replacements: [], mapping: [] }));
assert.equal(rack().slots.length, before.slots.length, 'extra eligible sources cannot grow a colors-only rebuild');
ok(command('orc_history_undo', context));
const fallback = ok(prepare({ sources: [source('unknown', '#FFFFFF', 'ASA Sparkle', [{ namespace: 'provider-material', value: 'unrecognized' }])] }));
assert.match(fallback.sources[0].preset, /Generic ASA/);
assert.ok(fallback.sources[0].warning);
assert.deepEqual(ok(command('orc_get_device_filament_options', request({ sources: [source('unknown', '#FFFFFF', 'ASA Sparkle', [{ namespace: 'provider-material', value: 'unrecognized' }])] }))).options, [], 'picker retains its narrower matching policy on the same source');
const mapped = ok(apply());
assert.equal(mapped.result.mutation.history_entry_delta, 1);
assert.equal(mapped.result.mutation.kind, 'synchronize');
const after = rack();
assert.equal(after.slots.length, before.slots.length + 1, 'identical unused source materials append only once');
assert.deepEqual(after.slots.slice(0, before.slots.length).map(s => s.logical_id), before.slots.map(s => s.logical_id));
assert.ok(after.slots.slice(0, before.slots.length).every(s => s.colour.effective === '#123456'));
ok(command('orc_history_undo', context));
assert.deepEqual(rack().slots, before.slots);
ok(command('orc_history_redo', context));
assert.deepEqual(rack().slots, after.slots);
const baseline = JSON.stringify(observe());
assert.equal(apply({ inject_failure_stage: 'before-history' }).ok, false);
assert.equal(JSON.stringify(observe()), baseline, 'late failure rolls back every native owner');
assert.equal(apply({ revision: history().revision - 1 }).error_code, 'stale_revision');
assert.equal(prepare({ identity: { ...identity, model: 'Different model', externalRefs: [] } }).error_code, 'printer_model_mismatch');
// Full rebuild requires surviving replacements for all referenced removed slots.
const rebuild = { mode: 'rebuild', sources: [sources[0]], mapping: [], replacements: rack().slots.map(() => null), appendUnused: false };
assert.equal(apply(rebuild).error_code, 'replacement_required');
const rebuilt = ok(apply({ ...rebuild, replacements: rack().slots.map(() => 1) }));
assert.equal(rebuilt.result.snapshot.slots.length, 1);
assert.ok(rebuilt.result.snapshot.assignments.objects.every(r => r.effective_slot === 1));
assert.ok(rebuilt.result.snapshot.assignments.parts.every(r => r.effective_slot === 1));
ok(command('orc_history_undo', context));
assert.deepEqual(rack().slots, after.slots);
ok(command('orc_history_redo', context));
assert.equal(rack().slots.length, 1);
// Color-only retains the project preset; native parallel colors stay multi-color.
const retainedPreset = rack().slots[0].preset.name;
ok(apply({ sources: [{ ...sources[0], materialType: 'ABS', catalogRefs: [{ namespace: 'provider-material', value: 'unrecognized' }], colour: { kind: 'parallel', colors: ['#112233', '#445566'] } }],
  mapping: [sources[0].slotId], replacements: [null], appendUnused: false, colourOnly: true }));
assert.equal(rack().slots[0].preset.name, retainedPreset);
assert.equal(rack().slots[0].colour.native.multi_colour, '#112233 #445566');
assert.equal(rack().slots[0].colour.native.type, '1');
const exported = ok(command('orc_export_project', {}));
const bytes = Module.HEAPU8.slice(exported.bytes_ptr, exported.bytes_ptr + exported.bytes_length);
Module._free(exported.bytes_ptr);
const expected = rack().slots.map(s => [s.preset.name, s.colour]);
const ptr = Module._malloc(bytes.length); Module.HEAPU8.set(bytes, ptr);
try { ok(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, bytes.length, 0, 'device-sync.3mf'])); }
finally { Module._free(ptr); }
assert.deepEqual(rack().slots.map(s => [s.preset.name, s.colour]), expected);
// Retain a compatible user preset and its shared project draft when native IDs match.
const custom = ok(command('orc_prepare_user_preset', { history_context: context, action: 'save-as', kind: 'filament',
  canonical_name: rack().slots[0].preset.name, name: 'Synced tuned PLA', expected_revision: history().revision }));
ok(command('orc_finish_user_preset', { token: custom.token, commit: true }));
ok(command('orc_mutate_preset_draft', { history_context: context, action: 'set', kind: 'filament', canonical_name: 'Synced tuned PLA',
  key: 'nozzle_temperature', value: '234', expected_revision: history().revision }));
const customBefore = ok(call('orc_get_preset_draft', ['string', 'string'], ['filament', 'Synced tuned PLA']));
assert.equal(ok(prepare()).sources[0].matches[0].preset, 'Synced tuned PLA');
ok(apply({ mapping: [sources[0].slotId], replacements: [null], appendUnused: false }));
assert.equal(rack().slots[0].preset.name, 'Synced tuned PLA');
assert.equal(ok(call('orc_get_preset_draft', ['string', 'string'], ['filament', 'Synced tuned PLA'])).effective_values.nozzle_temperature,
  customBefore.effective_values.nozzle_temperature);
// The native preset vector may be padded to tool count; proposal rows still
// describe the project rack, including a one-material dual-nozzle project.
const single = rack().slots[0];
ok(command('orc_select_printer_with_remembered_rack', { printer: ok(call('orc_get_preset_snapshot')).printer.name,
  remembered_bed_type: null, remembered_rack: { version: 1, slots: [{ preset: single.preset.name, colour: single.colour.effective, native: single.colour.native }] }, history_context: context }));
const oneMaterial = ok(prepare());
assert.equal(oneMaterial.references.length, 1);
assert.equal(oneMaterial.projectTypes.length, 1);
assert.ok(oneMaterial.sources.every(s => s.matches.length === 1));
// Rack entries do not establish project use. Dirty active drafts still require
// review, and an occupied non-selected plate must not take the direct path.
ok(call('orc_clear_model'));
assert.equal(ok(prepare()).requiresReview, true, 'empty plates retain review for a modified active Filament');
ok(command('orc_mutate_preset_draft', { history_context: context, action: 'reset-preset', kind: 'filament', canonical_name: 'Synced tuned PLA', expected_revision: history().revision }));
assert.equal(rack().slots.length, 1);
assert.equal(ok(prepare()).requiresReview, false, 'clean empty plates sync directly despite a configured rack');
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Used on another plate']));
const emptySelected = ok(call('orc_add_plate'));
assert.equal(emptySelected.plates.find(p => p.plate_id === emptySelected.current_plate_id).instance_ids.length, 0);
assert.equal(ok(prepare()).requiresReview, true, 'all plates participate in the dialog decision');
console.log('PASS device Filament sync: native exact/fallback matching, mapping identities, append deduplication, explicit Merge replacement, late rollback, Undo/Redo, parallel colors, 3MF, preserved custom drafts and single-material dual-nozzle proposal dimensions');
