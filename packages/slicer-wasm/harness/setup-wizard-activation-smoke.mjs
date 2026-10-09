import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { callAsyncTask, getSliceResult, exportGcode } from './async-task-mailbox.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
if (!process.argv[2]) throw new Error('usage: node setup-wizard-activation-smoke.mjs <module.js>');
const factory = await loadModuleFactory(resolve(process.argv[2]));
const activation = { models: [{ vendor: 'CompatibilityFixture', model: 'Compatibility Alpha', nozzle_diameter: ['0.4'] },
  { vendor: 'ExtraFixture', model: 'extra:Compatibility Alpha', nozzle_diameter: ['0.4'] }],
  filaments: ['Alpha Explicit Filament', 'extra:Alpha Explicit Filament'] };
async function start(record, transitionFixture = false) {
  const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
  const FS = Module.FS;
  async function copy(directory, target) {
    FS.mkdirTree(target);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await copy(join(directory, entry.name), `${target}/${entry.name}`);
      else FS.writeFile(`${target}/${entry.name}`, await readFile(join(directory, entry.name)));
    }
  }
  await copy(resolve(import.meta.dirname, 'fixtures/compatibility-profiles'), '/profiles');
  // A second real vendor supplies a sparse source draft that disappears from
  // the live catalogue when its printer-derived vendor is disabled.
  const sourceManifest = JSON.parse(FS.readFile('/profiles/CompatibilityFixture.json', { encoding: 'utf8' }));
  const names = new Map([...sourceManifest.machine_model_list, ...sourceManifest.machine_list,
    ...sourceManifest.process_list, ...sourceManifest.filament_list].map(item => [item.name, `extra:${item.name}`]));
  function rename(value) {
    if (Array.isArray(value)) return value.map(rename);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rename(item)]));
    if (typeof value === 'string') return value.split(';').map(name => names.get(name) ?? name).join(';');
    return value;
  }
  async function cloneVendor(directory, target) {
    FS.mkdirTree(target);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await cloneVendor(join(directory, entry.name), `${target}/${entry.name}`);
      else FS.writeFile(`${target}/${entry.name}`, JSON.stringify(rename(JSON.parse(await readFile(join(directory, entry.name), 'utf8')))));
    }
  }
  await cloneVendor(resolve(import.meta.dirname, 'fixtures/compatibility-profiles/CompatibilityFixture'), '/profiles/ExtraFixture');
  const extraManifest = rename(sourceManifest); extraManifest.name = 'Extra Fixture';
  FS.writeFile('/profiles/ExtraFixture.json', JSON.stringify(extraManifest)); FS.mkdirTree('/system');
  if (transitionFixture) {
    const edit = (path, values) => FS.writeFile(path, JSON.stringify({ ...JSON.parse(FS.readFile(path, { encoding: 'utf8' })), ...values }));
    edit('/profiles/CompatibilityFixture/machine/alpha.json', { support_multi_bed_types: '1' });
    edit('/profiles/CompatibilityFixture/machine/beta.json', { support_multi_bed_types: '1',
      printable_area: ['0x0', '150x0', '150x150', '0x150'], nozzle_diameter: ['0.4', '0.4'] });
    const variant = { ...JSON.parse(FS.readFile('/profiles/CompatibilityFixture/machine/beta.json', { encoding: 'utf8' })),
      name: 'Compatibility Beta 0.6 nozzle', printer_variant: '0.6', nozzle_diameter: ['0.6', '0.6'] };
    FS.writeFile('/profiles/CompatibilityFixture/machine/beta-06.json', JSON.stringify(variant));
    sourceManifest.machine_list.push({ name: variant.name, sub_path: 'machine/beta-06.json' });
    FS.writeFile('/profiles/CompatibilityFixture.json', JSON.stringify(sourceManifest));
    edit('/profiles/CompatibilityFixture/machine-model/beta.json', { nozzle_diameter: '0.4;0.6' });
  }

  function links(record) {
    for (const name of FS.readdir('/system')) if (name !== '.' && name !== '..') FS.unlink(`/system/${name}`);
    for (const vendor of new Set(['OrcaFilamentLibrary', ...(record?.models ?? []).map(model => model.vendor)])) {
      if (!FS.analyzePath(`/profiles/${vendor}.json`).exists) continue;
      FS.symlink(`/profiles/${vendor}.json`, `/system/${vendor}.json`);
      FS.symlink(`/profiles/${vendor}`, `/system/${vendor}`);
    }
  }
  function call(name, types = [], args = []) {
    const ptr = Number(Module.ccall(name, 'number', types, args));
    try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
  }
  links(record); must(call('orc_init', ['string'], [JSON.stringify({ log_level: 'error', profile_activation: record })]));
  return { FS, Module, call, links };
}
function preparation(record) { return { activation: record, remembered_filament_racks: {}, remembered_bed_types: {} }; }
function must(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
const session = await start(activation);
const { call, FS } = session;
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
call('orc_history_reset', ['string'], [JSON.stringify(context)]);
let tx = must(call('orc_history_begin', ['string', 'string', 'string', 'string'], ['Add Cube', 'project', JSON.stringify(context), '']));
must(call('orc_add_shape', ['string', 'string'], ['Cube', 'Activation Cube']));
must(setNativeScopedConfig(call, 'project', undefined, 'layer_height', '0.28'));
assert.equal(call('orc_history_commit', ['string', 'string'], [tx.transactionId, JSON.stringify(context)]).status.canUndo, true);
function snapshot() { return { profiles: call('orc_get_preset_snapshot'), filaments: call('orc_get_filament_session_snapshot'),
  config: call('orc_get_native_scoped_config'), history: call('orc_history_status'), model: call('orc_get_model_structure'),
  plates: call('orc_get_plate_session_snapshot'), links: FS.readdir('/system').sort().map(name => [name, name === '.' || name === '..' ? '' : FS.readlink(`/system/${name}`)]) }; }
const dormantSource = 'extra:Compatibility Alpha 0.4 nozzle';
must(call('orc_mutate_preset_draft', ['string'], [JSON.stringify({ action: 'set', kind: 'printer',
  canonical_name: dormantSource, expected_revision: call('orc_history_status').revision,
  key: 'printer_notes', value: 'retained dormant notes' })]));
const draftBefore = call('orc_get_preset_draft', ['string', 'string'], ['printer', dormantSource]);
const before = snapshot();
assert.equal(before.config.native_scoped_config.snapshot.project.layer_height, '0.28', 'native embedded Print override');
assert.equal(call('orc_prepare_profile_activation', ['string'], [JSON.stringify(preparation(activation))]).ok, false, 'requires open wizard');
assert.deepEqual(snapshot(), before);
must(call('orc_open_setup_wizard_catalogue'));
for (const record of [null, { models: [{ vendor: '../bad', model: 'P', nozzle_diameter: ['0.4'] }], filaments: ['F'] },
  { models: [{ vendor: 'Missing', model: 'P', nozzle_diameter: ['0.4'] }], filaments: ['Retired'] }]) {
  assert.equal(call('orc_prepare_profile_activation', ['string'], [JSON.stringify(preparation(record))]).ok, false);
  assert.deepEqual(snapshot(), before);
}
const target = { models: [{ vendor: 'CompatibilityFixture', model: 'Compatibility Beta', nozzle_diameter: ['0.4', '0.4'] },
  { vendor: 'MissingVendor', model: 'Retired printer', nozzle_diameter: ['9.9'] }], filaments: ['Retired Filament'] };
let prepared = must(call('orc_prepare_profile_activation', ['string'], [JSON.stringify(preparation(target))])).activation;
assert.equal(call('orc_prepare_profile_activation', ['string'], ['{invalid']).ok, false);
assert.equal(call('orc_apply_profile_activation').ok, false, 'malformed reprepare invalidates the previous native candidate');
assert.deepEqual(snapshot(), before);
prepared = must(call('orc_prepare_profile_activation', ['string'], [JSON.stringify(preparation(target))])).activation;
assert.ok(prepared.models.some(model => model.vendor === 'MissingVendor'));
assert.deepEqual(prepared.models.find(model => model.model === 'Compatibility Beta').nozzle_diameter, ['0.4']);
assert.ok(prepared.filaments.includes('Retired Filament'));
assert.ok(prepared.filaments.includes('Beta Explicit Filament'), 'native supplementation from target visible printer');
assert.equal(prepared.filaments.some(name => name.startsWith('Alpha ')), false, 'no default leakage from disabled model');
assert.deepEqual(snapshot(), before, 'prepare preserves complete live state and links');
// Model an application rejection after durable settings are saved: the active
// transaction fence must retain history and prepared state, enabling retry.
tx = must(call('orc_history_begin', ['string', 'string', 'string', 'string'], ['Blocking operation', 'project', JSON.stringify(context), '']));
const fenced = snapshot();
session.links(prepared);
assert.equal(call('orc_apply_profile_activation').ok, false);
const afterFailed = snapshot();
assert.deepEqual({ ...afterFailed, links: fenced.links }, fenced, 'failed apply leaves all native project state/history intact');
call('orc_history_abort', ['string'], [tx.transactionId]);
const modelBefore = call('orc_get_model_structure');
const beforePublication = snapshot();
must(call('orc_test_inject_profile_activation_failure'));
assert.equal(call('orc_apply_profile_activation').ok, false, 'late reversible publication fault');
assert.deepEqual(snapshot(), beforePublication, 'late publication rollback preserves complete live state/history');
assert.deepEqual(call('orc_get_preset_draft', ['string', 'string'], ['printer', dormantSource]), draftBefore);
must(call('orc_history_undo')); must(call('orc_history_redo'));
assert.deepEqual(call('orc_get_model_structure'), modelBefore, 'Undo/Redo remains usable after late publication rollback');
assert.deepEqual(call('orc_get_preset_draft', ['string', 'string'], ['printer', dormantSource]).overrides, draftBefore.overrides);
const applied = must(call('orc_apply_profile_activation'));
assert.equal(applied.history_status.canUndo, false); assert.equal(applied.history_status.canRedo, false);
assert.equal(applied.history_status.dirty, true, 'prior dirty project remains dirty after safe history baseline');
assert.deepEqual(call('orc_get_model_structure'), modelBefore, 'model data and identities retained');
assert.equal(call('orc_get_native_scoped_config').native_scoped_config.snapshot.project.layer_height, '0.28', 'embedded Print config retained');
assert.equal(applied.profile_snapshot.print.name, before.profiles.print.name, 'embedded selection retained');
assert.deepEqual(applied.profile_snapshot.printers.map(printer => printer.name), ['Compatibility Beta 0.4 nozzle']);
const next = await start(prepared);
assert.deepEqual(next.call('orc_get_preset_snapshot').printers.map(printer => printer.name), applied.profile_snapshot.printers.map(printer => printer.name));
assert.deepEqual(next.FS.readdir('/system').sort(), FS.readdir('/system').sort(), 'links equivalent to next startup');
// The first ordinary edit/Undo after the replacement must not try to restore
// removed source presets from the new history root.
tx = must(call('orc_history_begin', ['string', 'string', 'string', 'string'], ['Post activation Cube', 'project', JSON.stringify(context), '']));
must(call('orc_add_shape', ['string', 'string'], ['Cube', 'After activation']));
call('orc_history_commit', ['string', 'string'], [tx.transactionId, JSON.stringify(context)]);
must(call('orc_history_undo'));
assert.deepEqual(call('orc_get_model_structure'), modelBefore);
const restoredActivation = must(call('orc_prepare_profile_activation', ['string'], [JSON.stringify(preparation(activation))])).activation;
session.links(restoredActivation); must(call('orc_apply_profile_activation'));
assert.deepEqual(call('orc_get_preset_draft', ['string', 'string'], ['printer', dormantSource]).overrides,
  draftBefore.overrides, 'sparse dormant source overrides return when its vendor is enabled');
// Reapply is idempotent for project data, preserves dirty, and creates no entries.
const again = must(call('orc_apply_profile_activation'));
assert.equal(again.history_status.canUndo, false); assert.deepEqual(call('orc_get_model_structure'), modelBefore);
call('orc_history_mark_saved', ['string'], [JSON.stringify(context)]);
const clean = must(call('orc_apply_profile_activation'));
assert.equal(clean.configuration_changed, false, 'identical activation keeps effective configuration');
assert.equal(clean.history_status.dirty, false, 'clean unchanged project remains clean');
must(call('orc_close_setup_wizard_catalogue'));
assert.equal(call('orc_apply_profile_activation').ok, false, 'close releases prepared candidate');
console.log('setup activation smoke OK: validation, target defaults/stale records, prepare isolation, failed-apply retry, embedded/model preservation, safe history, next startup equivalence');

// Existing-project transition: real sliced data, native bed/rack/draft rules,
// source replacement colours, spatial reflow and a safe new editing baseline.
const base = { models: [activation.models[0]], filaments: ['Alpha Explicit Filament', 'Generic PLA @System'] };
const initialSetup = await start(null, true);
must(initialSetup.call('orc_open_setup_wizard_catalogue'));
must(initialSetup.call('orc_prepare_profile_activation', ['string'], [JSON.stringify(preparation(base))]));
initialSetup.links(base);
const initialApplied = must(initialSetup.call('orc_apply_profile_activation'));
assert.equal(initialApplied.configuration_changed, true, 'first-use replaces intrinsic defaults');
assert.equal(initialApplied.profile_snapshot.printer.name, 'Compatibility Alpha 0.4 nozzle', 'first-use selects a real usable printer');
assert.ok(initialApplied.profile_snapshot.prints.some(preset => preset.name === initialApplied.profile_snapshot.print.name), 'first-use Process belongs to compatible candidates');
assert.equal(initialSetup.call('orc_history_mark_saved', ['string'], ['']).dirty, false, 'first-use checkpoint establishes a clean project');
assert.equal(initialSetup.call('orc_history_status').canUndo, false);
must(initialSetup.call('orc_close_setup_wizard_catalogue'));
const cleanCandidates = await start(base, true);
const cc = cleanCandidates.call;
must(cc('orc_add_shape', ['string', 'string'], ['Cube', 'Clean candidate cube']));
assert.equal(cc('orc_history_mark_saved', ['string'], [JSON.stringify(context)]).dirty, false);
const candidateBefore = must(cc('orc_get_preset_snapshot'));
must(cc('orc_open_setup_wizard_catalogue'));
const addedMaterial = { ...base, filaments: [...base.filaments, 'Generic PLA @Compatibility Alpha'] };
must(cc('orc_prepare_profile_activation', ['string'], [JSON.stringify(preparation(addedMaterial))]));
cleanCandidates.links(addedMaterial);
const cleanAddition = must(cc('orc_apply_profile_activation'));
assert.deepEqual(cleanAddition.profile_snapshot.project_config, candidateBefore.project_config);
assert.equal(cleanAddition.configuration_changed, false, 'adding an unused material keeps effective project configuration');
assert.equal(cleanAddition.history_status.dirty, false, 'clean candidate-only project remains clean');
const cleanModelRecord = { ...addedMaterial, models: [...base.models,
  { vendor: 'CompatibilityFixture', model: 'Compatibility Beta', nozzle_diameter: ['0.4'] }] };
must(cc('orc_prepare_profile_activation', ['string'], [JSON.stringify(preparation(cleanModelRecord))]));
cleanCandidates.links(cleanModelRecord);
const cleanModel = must(cc('orc_apply_profile_activation'));
assert.equal(cleanModel.profile_snapshot.printer.name, candidateBefore.printer.name);
assert.deepEqual(cleanModel.profile_snapshot.project_config, candidateBefore.project_config);
assert.equal(cleanModel.configuration_changed, false);
assert.equal(cleanModel.history_status.dirty, false, 'adding a printer keeps the clean project baseline');
const anotherVendor = { ...cleanModelRecord, models: [...cleanModelRecord.models, activation.models[1]] };
must(cc('orc_prepare_profile_activation', ['string'], [JSON.stringify(preparation(anotherVendor))]));
cleanCandidates.links(anotherVendor);
const cleanVendor = must(cc('orc_apply_profile_activation'));
assert.equal(cleanVendor.profile_snapshot.printer.name, candidateBefore.printer.name);
assert.deepEqual(cleanVendor.profile_snapshot.project_config, candidateBefore.project_config);
assert.equal(cleanVendor.configuration_changed, false);
assert.equal(cleanVendor.history_status.dirty, false, 'adding another vendor printer keeps the clean baseline');
const betaRecord = { ...cleanModelRecord, models: [cleanModelRecord.models[1]] };
must(cc('orc_prepare_profile_activation', ['string'], [JSON.stringify(preparation(betaRecord))]));
cleanCandidates.links(betaRecord);
const fallback = must(cc('orc_apply_profile_activation'));
assert.equal(fallback.profile_snapshot.printer.name, 'Compatibility Beta 0.4 nozzle');
assert.equal(fallback.configuration_changed, true);
assert.equal(fallback.history_status.dirty, true, 'actual printer fallback changes the existing project');
assert.equal(cc('orc_history_mark_saved', ['string'], ['']).dirty, false);
const moreNozzles = { ...betaRecord, models: [{ ...betaRecord.models[0], nozzle_diameter: ['0.4', '0.6'] }] };
must(cc('orc_prepare_profile_activation', ['string'], [JSON.stringify(preparation(moreNozzles))]));
cleanCandidates.links(moreNozzles);
const cleanNozzle = must(cc('orc_apply_profile_activation'));
assert.equal(cleanNozzle.profile_snapshot.printer.name, fallback.profile_snapshot.printer.name);
assert.deepEqual(cleanNozzle.profile_snapshot.project_config, fallback.profile_snapshot.project_config);
assert.equal(cleanNozzle.configuration_changed, false);
assert.equal(cleanNozzle.history_status.dirty, false, 'adding a nozzle keeps the clean project baseline');
must(cc('orc_close_setup_wizard_catalogue'));
const detailed = await start(base, true);
const c = detailed.call;
const req = (name, body) => c(name, ['string'], [JSON.stringify(body)]);
const profiles = () => must(c('orc_get_preset_snapshot'));
const rack = () => must(c('orc_get_filament_session_snapshot'));
const plates = () => must(c('orc_get_plate_session_snapshot'));
const meshSnapshot = () => {
  const mesh = must(c('orc_get_model_mesh'));
  for (const geometry of mesh.geometries ?? []) { if (geometry.vertex_ptr) detailed.Module._free(Number(geometry.vertex_ptr)); if (geometry.index_ptr) detailed.Module._free(Number(geometry.index_ptr)); }
  return mesh.renderables;
};
const stateSnapshot = () => ({ profiles: profiles(), rack: rack(), plates: plates(), mesh: meshSnapshot(),
  config: c('orc_get_native_scoped_config'), model: c('orc_get_model_structure'), history: c('orc_history_status') });
const prep = (record, memory = {}) => req('orc_prepare_profile_activation', { activation: record,
  remembered_filament_racks: memory.racks ?? {}, remembered_bed_types: memory.beds ?? {} });
const apply = () => must(c('orc_apply_profile_activation'));
const draft = (kind, canonical_name, key, value) => must(req('orc_mutate_preset_draft', {
  action: 'set', kind, canonical_name, key, value, expected_revision: c('orc_history_status').revision }));
const A = 'Compatibility Alpha 0.4 nozzle', B = 'Compatibility Beta 0.4 nozzle';
must(c('orc_add_shape', ['string', 'string'], ['Cube', 'Plate A cube']));
const plateA = plates().current_plate_id;
must(c('orc_add_plate'));
must(c('orc_add_shape', ['string', 'string'], ['Cube', 'Plate B cube']));
const plateB = plates().current_plate_id;
must(setNativeScopedConfig(c, 'plate', plateB, 'curr_bed_type', 'High Temp Plate'));
draft('printer', A, 'printer_notes', 'old source only');
draft('printer', B, 'printer_notes', 'target own draft');
draft('filament', 'Beta Explicit Filament', 'default_filament_colour', '#334455');
must(c('orc_open_setup_wizard_catalogue'));
for (const missing of ['remembered_filament_racks', 'remembered_bed_types']) {
  const envelope = { activation: base, remembered_filament_racks: {}, remembered_bed_types: {} }; delete envelope[missing];
  const before = stateSnapshot(); assert.equal(req('orc_prepare_profile_activation', envelope).ok, false);
  assert.deepEqual(stateSnapshot(), before);
}
for (const memory of [{ remembered_filament_racks: { [A]: null }, remembered_bed_types: {} },
  { remembered_filament_racks: {}, remembered_bed_types: { [A]: 123 } }]) {
  const before = stateSnapshot(); assert.equal(req('orc_prepare_profile_activation', { activation: base, ...memory }).ok, false);
  assert.deepEqual(stateSnapshot(), before);
}
// Candidate-only change must retain actual result receipts, preview and export
// even with existing dirty state; successful activation still clears history.
const receipts = [];
for (const plate of [plateA, plateB]) {
  const sliced = must(await callAsyncTask(c, 'orc_slice_plate', ['string', 'string', 'number'],
    ['{}', plate, plates().input_revisions[plate]]));
  must(getSliceResult(c, sliced.receipt)); must(exportGcode(c, { receipt: sliced.receipt, filenameBase: '' }));
  receipts.push(sliced.receipt);
}
const beforeCandidates = stateSnapshot();
const candidateOnly = { ...base, filaments: [...base.filaments, 'Retired material'] };
must(prep(candidateOnly)); detailed.links(candidateOnly);
const candidatesApplied = apply();
assert.equal(candidatesApplied.configuration_changed, false);
assert.equal(candidatesApplied.history_status.dirty, beforeCandidates.history.dirty);
assert.equal(candidatesApplied.history_status.canUndo, false);
assert.deepEqual(plates().input_revisions, beforeCandidates.plates.input_revisions);
for (const receipt of receipts) { must(getSliceResult(c, receipt)); must(exportGcode(c, { receipt, filenameBase: '' })); }
// Save target printer memory, including a compatible gradient slot and an
// incompatible slot whose replacement must use the target material draft.
const memory = { beds: { [B]: 'Engineering Plate' }, racks: { [B]: { version: 1, slots: [
  { preset: 'Generic PLA @System', colour: '#123456', native: { representative: '#123456', multi_colour: '#123456 #ABCDEF', type: '0' } },
  { preset: 'Alpha Explicit Filament', colour: '#FFEEDD', native: { representative: '#FFEEDD', multi_colour: '#FFEEDD', type: '1' } },
] } } };
const both = { models: [...base.models, { vendor: 'CompatibilityFixture', model: 'Compatibility Beta', nozzle_diameter: ['0.4'] }],
  filaments: [...base.filaments, 'Beta Explicit Filament'] };
const beforeAddedModel = stateSnapshot();
must(prep(both)); detailed.links(both);
const addedModel = apply();
assert.equal(addedModel.profile_snapshot.printer.name, A, 'new model preserves the enabled current printer');
assert.equal(addedModel.configuration_changed, false);
assert.equal(addedModel.history_status.dirty, beforeAddedModel.history.dirty);
assert.deepEqual(plates().input_revisions, beforeAddedModel.plates.input_revisions);
for (const receipt of receipts) { must(getSliceResult(c, receipt)); must(exportGcode(c, { receipt, filenameBase: '' })); }
const betaOnly = { ...both, models: [both.models[1]] };
const beforeTransition = stateSnapshot();
must(prep(betaOnly, memory)); detailed.links(betaOnly);
must(c('orc_test_inject_profile_activation_failure'));
assert.equal(c('orc_apply_profile_activation').ok, false);
assert.deepEqual(stateSnapshot(), beforeTransition, 'failed spatial/rack publication rolls back full state');
for (const receipt of receipts) { must(getSliceResult(c, receipt)); must(exportGcode(c, { receipt, filenameBase: '' })); }
const result = apply();
assert.equal(result.profile_snapshot.printer.name, B, 'disabled current printer falls back to remaining model');
assert.equal(c('orc_get_preset_draft', ['string', 'string'], ['printer', B]).effective_values.printer_notes, 'target own draft');
assert.equal(result.native_scoped_config.snapshot.project.curr_bed_type, 'Engineering Plate');
assert.equal(result.filament_session.slots.length, 2, 'native fixed nozzle count and remembered rack');
assert.equal(result.filament_session.slots[0].preset.name, 'Generic PLA @System');
assert.equal(result.filament_session.slots[0].colour.native.multi_colour, '#123456 #ABCDEF');
assert.deepEqual(result.filament_session.slots[0].colour.display, { mode: 'gradient', colors: ['#123456', '#ABCDEF'] });
assert.equal(result.filament_session.slots[1].preset.name, 'Beta Explicit Filament');
assert.equal(result.filament_session.slots[1].colour.native.representative, '#334455');
assert.equal(result.filament_session.slots[1].colour.native.multi_colour, '#334455');
assert.equal(result.filament_session.slots[1].colour.native.type, '1');
assert.equal(result.filament_session.slots[0].logical_id, beforeTransition.rack.slots[0].logical_id);
assert.equal(result.configuration_changed, true); assert.equal(result.history_status.canUndo, false);
assert.equal(result.history_status.dirty, true);
assert.deepEqual(plates().plates.map(p => p.plate_id), beforeTransition.plates.plates.map(p => p.plate_id));
assert.deepEqual(plates().instances, beforeTransition.plates.instances, 'plate membership survives bed reflow');
assert.equal(plates().instances.length, 2);
assert.ok(result.plate_session.instance_transforms.length > 0);
for (const transform of result.plate_session.instance_transforms) {
  const instance = beforeTransition.plates.instances.find(row => row.instance_id === transform.instance_id);
  const beforePlate = beforeTransition.plates.plates.find(p => p.plate_id === instance.plate_id);
  const afterPlate = result.plate_session.plates.find(p => p.plate_id === instance.plate_id);
  const prior = beforeTransition.mesh.find(row => row.object_idx === transform.object_index && row.instance_idx === transform.instance_index);
  for (let axis = 0; axis < 3; ++axis) assert.ok(Math.abs(transform.world_transform.offset[axis] - afterPlate.origin[axis] - prior.offset[axis] + beforePlate.origin[axis]) < 1e-6, 'plate-local model position preserved');
}
assert.deepEqual(new Set(result.plate_session.affected_plate_ids), new Set([plateA, plateB]));
for (const plate of [plateA, plateB]) assert.ok(result.plate_session.input_revisions[plate] > beforeTransition.plates.input_revisions[plate]);
assert.notDeepEqual(plates().plates.map(p => p.origin), beforeTransition.plates.plates.map(p => p.origin));
assert.equal(c('orc_get_native_scoped_config').native_scoped_config.snapshot.plates[plateB].curr_bed_type, 'High Temp Plate');
for (const receipt of receipts) { assert.equal(getSliceResult(c, receipt).ok, false); assert.equal(exportGcode(c, { receipt, filenameBase: '' }).ok, false); }
const afterTransition = stateSnapshot();
const edit = must(c('orc_history_begin', ['string', 'string', 'string', 'string'], ['New baseline edit', 'project', JSON.stringify(context), '']));
must(c('orc_add_shape', ['string', 'string'], ['Cube', 'New baseline cube']));
c('orc_history_commit', ['string', 'string'], [edit.transactionId, JSON.stringify(context)]);
must(c('orc_history_undo'));
assert.deepEqual(c('orc_get_model_structure'), afterTransition.model);
assert.deepEqual(meshSnapshot(), afterTransition.mesh);
assert.deepEqual(rack().slots, afterTransition.rack.slots);
// Added nozzle variant preserves the enabled active variant.
const variant = { ...both, models: [base.models[0], { ...both.models[1], nozzle_diameter: ['0.4', '0.6'] }] };
must(prep(variant)); detailed.links(variant);
const variantResult = apply(); assert.equal(variantResult.profile_snapshot.printer.name, B);
assert.equal(variantResult.configuration_changed, false);
const onlyNewVariant = { ...variant, models: [{ ...both.models[1], nozzle_diameter: ['0.6'] }] };
must(prep(onlyNewVariant)); detailed.links(onlyNewVariant);
const replacedVariant = apply(); assert.equal(replacedVariant.profile_snapshot.printer.name, 'Compatibility Beta 0.6 nozzle');
assert.equal(replacedVariant.filament_session.slots[0].colour.native.multi_colour, '#123456 #ABCDEF', 'unchanged source keeps native colours across variant transition');
// Removing Beta falls back to Alpha and restores only Alpha's own draft. No
// remembered target rack means previous slots survive compatible normalization.
must(prep(base)); detailed.links(base);
const removed = apply();
assert.equal(removed.profile_snapshot.printer.name, A);
assert.equal(c('orc_get_preset_draft', ['string', 'string'], ['printer', A]).effective_values.printer_notes, 'old source only');
assert.equal(removed.filament_session.slots.length, 2);
// Orca excludes the base Generic library preset on Alpha when its vendor
// supplies Generic PLA @Compatibility Alpha; this is a source replacement.
assert.equal(removed.filament_session.slots[0].preset.name, 'Alpha Explicit Filament');
assert.equal(removed.filament_session.slots[0].colour.native.multi_colour, '#26A69A');
assert.equal(removed.filament_session.slots[1].preset.name, 'Alpha Explicit Filament');
assert.equal(removed.filament_session.slots[1].colour.native.representative, '#26A69A');
// A real Printer transition may shrink to its remembered rack; normalize
// object/plate slot references through the existing native mechanism.
must(req('orc_assign_filament', { version: 1, revision: rack().revisions.session, slot: 2, targets: [{ kind: 'object', id: c('orc_get_model_structure').objects[0].id }] }));
must(req('orc_set_filament_routing', { version: 1, revision: rack().revisions.session, selector: 'support-base', slot: 2, targets: [{ kind: 'project', id: 0 }] }));
must(setNativeScopedConfig(c, 'plate', plateB, 'filament_map', '1,1'));
const oneSlot = { version: 1, slots: [{ preset: 'Alpha Explicit Filament', colour: '#789ABC',
  native: { representative: '#789ABC', multi_colour: '#789ABC', type: '1' } }] };
// Move through Beta then return to A with explicit saved rack memory.
must(prep(betaOnly)); detailed.links(betaOnly); apply();
must(prep(base, { racks: { [A]: oneSlot }, beds: { [A]: 'retired-invalid-bed' } })); detailed.links(base);
const shrunk = apply();
assert.equal(shrunk.filament_session.slots.length, 1);
assert.equal(shrunk.filament_session.slots[0].colour.native.representative, '#789ABC');
const normalized = c('orc_get_native_scoped_config').native_scoped_config.snapshot;
assert.equal(normalized.objects[c('orc_get_model_structure').objects[0].id].extruder, '1');
assert.equal(normalized.project.support_filament, '0');
assert.equal(normalized.plates[plateB].filament_map, '1');
assert.notEqual(normalized.project.curr_bed_type, 'retired-invalid-bed');
// Export/import creates independent embedded project sources, including the
// printer's current own draft. Candidate-only activation preserves this source;
// added global models also preserve the independent embedded Printer.
const exported = must(c('orc_export_project'));
let bytes = detailed.Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + Number(exported.bytes_length));
const archive = readZipEntries(bytes);
const decode = new TextDecoder(), encode = new TextEncoder();
for (const entry of archive) {
  if (entry.name === 'Metadata/project_settings.config' || entry.name.startsWith('Metadata/machine_settings_')) {
    const values = JSON.parse(decode.decode(entry.content));
    values.printer_settings_id = 'Independent Activation Printer';
    if (entry.name.startsWith('Metadata/machine_settings_')) { values.name = 'Independent Activation Printer'; values.inherits = A; }
    else if (Array.isArray(values.inherits_group)) values.inherits_group[values.inherits_group.length - 1] = A;
    entry.content = encode.encode(JSON.stringify(values));
  }
}
bytes = writeStoredZip(archive);
detailed.Module._free(Number(exported.bytes_ptr));
const pointer = detailed.Module._malloc(bytes.length); detailed.Module.HEAPU8.set(bytes, pointer);
try { must(c('orc_load_project', ['pointer', 'number', 'number', 'string'], [pointer, bytes.length, 0, 'activation-embedded.3mf'])); }
finally { detailed.Module._free(pointer); }
const embeddedProfile = profiles();
assert.notEqual(embeddedProfile.printer.name, A, 'modified exported Printer reloads as embedded source');
const embeddedRack = rack().slots;
const embeddedModels = c('orc_get_model_structure');
must(prep(candidateOnly)); detailed.links(candidateOnly);
const retainedEmbedded = apply();
assert.equal(retainedEmbedded.profile_snapshot.printer.name, embeddedProfile.printer.name);
assert.equal(retainedEmbedded.profile_snapshot.print.name, embeddedProfile.print.name);
assert.deepEqual(retainedEmbedded.filament_session.slots, embeddedRack);
assert.deepEqual(c('orc_get_model_structure'), embeddedModels);
must(prep(both)); detailed.links(both);
assert.equal(apply().profile_snapshot.printer.name, embeddedProfile.printer.name, 'new global model preserves embedded Printer');
const foreign = { models: [activation.models[1]], filaments: ['extra:Alpha Explicit Filament'] };
must(prep(foreign)); detailed.links(foreign); apply();
const reload = detailed.Module._malloc(bytes.length); detailed.Module.HEAPU8.set(bytes, reload);
try { must(c('orc_load_project', ['pointer', 'number', 'number', 'string'], [reload, bytes.length, 0, 'activation-without-parent.3mf'])); }
finally { detailed.Module._free(reload); }
const absentParent = stateSnapshot();
assert.equal(detailed.FS.analyzePath('/system/CompatibilityFixture.json').exists, false);
must(prep(foreign)); detailed.links(foreign);
const independent = apply();
assert.equal(independent.profile_snapshot.printer.name, absentParent.profiles.printer.name);
assert.equal(independent.profile_snapshot.print.name, absentParent.profiles.print.name);
assert.deepEqual(independent.filament_session.slots, absentParent.rack.slots, 'embedded Filament remains independent of disabled vendor parent');
assert.deepEqual(c('orc_get_model_structure'), absentParent.model);
assert.equal(independent.configuration_changed, false);

must(c('orc_close_setup_wizard_catalogue'));
console.log('setup-wizard-transition PASS real slice retention/invalidation, retained models/variants and disabled fallback, memory/drafts/colours/bed/spatial rollback and new history baseline');
