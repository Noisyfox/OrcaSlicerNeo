import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
if (!process.argv[2]) throw new Error('usage: node setup-wizard-activation-smoke.mjs <module.js>');
const factory = await loadModuleFactory(resolve(process.argv[2]));
const activation = { models: [{ vendor: 'CompatibilityFixture', model: 'Compatibility Alpha', nozzle_diameter: ['0.4'] },
  { vendor: 'ExtraFixture', model: 'extra:Compatibility Alpha', nozzle_diameter: ['0.4'] }],
  filaments: ['Alpha Explicit Filament', 'extra:Alpha Explicit Filament'] };
async function start(record) {
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
  function links(record) {
    for (const name of FS.readdir('/system')) if (name !== '.' && name !== '..') FS.unlink(`/system/${name}`);
    for (const vendor of new Set(['OrcaFilamentLibrary', ...record.models.map(model => model.vendor)])) {
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
assert.equal(call('orc_prepare_profile_activation', ['string'], [JSON.stringify(activation)]).ok, false, 'requires open wizard');
assert.deepEqual(snapshot(), before);
must(call('orc_open_setup_wizard_catalogue'));
for (const record of [null, { models: [{ vendor: '../bad', model: 'P', nozzle_diameter: ['0.4'] }], filaments: ['F'] },
  { models: [{ vendor: 'Missing', model: 'P', nozzle_diameter: ['0.4'] }], filaments: ['Retired'] }]) {
  assert.equal(call('orc_prepare_profile_activation', ['string'], [JSON.stringify(record)]).ok, false);
  assert.deepEqual(snapshot(), before);
}
const target = { models: [{ vendor: 'CompatibilityFixture', model: 'Compatibility Beta', nozzle_diameter: ['0.4', '0.4'] },
  { vendor: 'MissingVendor', model: 'Retired printer', nozzle_diameter: ['9.9'] }], filaments: ['Retired Filament'] };
let prepared = must(call('orc_prepare_profile_activation', ['string'], [JSON.stringify(target)])).activation;
assert.equal(call('orc_prepare_profile_activation', ['string'], ['{invalid']).ok, false);
assert.equal(call('orc_apply_profile_activation').ok, false, 'malformed reprepare invalidates the previous native candidate');
assert.deepEqual(snapshot(), before);
prepared = must(call('orc_prepare_profile_activation', ['string'], [JSON.stringify(target)])).activation;
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
const restoredActivation = must(call('orc_prepare_profile_activation', ['string'], [JSON.stringify(activation)])).activation;
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
