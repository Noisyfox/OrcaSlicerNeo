import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';

if (!process.argv[2]) throw new Error('usage: node setup-wizard-catalogue-smoke.mjs <module.js>');
const factory = await loadModuleFactory(resolve(process.argv[2]));
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
FS.mkdirTree('/system');
FS.symlink('/profiles/OrcaFilamentLibrary.json', '/system/OrcaFilamentLibrary.json');
FS.symlink('/profiles/OrcaFilamentLibrary', '/system/OrcaFilamentLibrary');
FS.writeFile('/profiles/CompatibilityFixture/Compatibility Alpha_cover.png', new Uint8Array([137, 80, 78, 71]));
const manifestPath = '/profiles/CompatibilityFixture.json';
const manifest = JSON.parse(FS.readFile(manifestPath, { encoding: 'utf8' }));
function addFilament(name, inherits, compatible, condition = '') {
  const sub_path = `filament/wizard-${manifest.filament_list.length}.json`;
  manifest.filament_list.push({ name, sub_path });
  FS.writeFile(`/profiles/CompatibilityFixture/${sub_path}`, JSON.stringify({ type: 'filament', name,
    inherits, from: 'system', instantiation: 'true', filament_id: `wizard-${manifest.filament_list.length}`, compatible_printers: compatible,
    compatible_printers_condition: condition }));
}
addFilament('Generic PLA @Compatibility Beta', 'Generic PLA @System', ['Compatibility Beta 0.4 nozzle']);
addFilament('Unknown Explicit @Fixture', 'fixture_filament_common', ['retired printer']);
FS.writeFile(manifestPath, JSON.stringify(manifest));
FS.mkdirTree('/profiles/Broken'); FS.writeFile('/profiles/Broken.json', '{invalid vendor');
function call(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
function must(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
must(call('orc_init', ['string'], [JSON.stringify({ log_level: 'error', profile_activation: null })]));
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
call('orc_history_reset', ['string'], [JSON.stringify(context)]);
const transaction = must(call('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Add catalogue test Cube', 'project', JSON.stringify(context), '']));
must(call('orc_add_shape', ['string', 'string'], ['Cube', 'Wizard isolation Cube']));
assert.equal(call('orc_history_commit', ['string', 'string'], [transaction.transactionId, JSON.stringify(context)]).status.canUndo, true);
function snapshot() {
  return { profiles: call('orc_get_preset_snapshot'), history: call('orc_history_status'),
    model: call('orc_get_model_structure'), filaments: call('orc_get_filament_session_snapshot'), config: call('orc_get_native_scoped_config'),
    plates: call('orc_get_plate_session_snapshot'), system: FS.readdir('/system').sort(),
    libraryLink: FS.readlink('/system/OrcaFilamentLibrary') };
}
const before = snapshot();
for (const domain of ['profiles', 'filaments', 'config', 'plates']) assert.equal(before[domain].ok, true, domain);
assert.equal(before.history.canUndo, true, 'nonempty live history');
let rawReads = 0;
const open = FS.open;
FS.open = function(path, ...args) { if (typeof path === 'string' && path.startsWith('/profiles/')) rawReads++; return open.call(this, path, ...args); };
const first = must(call('orc_open_setup_wizard_catalogue')).catalogue;
assert.equal(first.models.length, 2, 'raw unlinked vendor models are present');
const alpha = first.models.find(model => model.model === 'Compatibility Alpha');
assert.deepEqual(alpha.nozzle_diameter, ['0.4']);
assert.deepEqual(alpha.default_materials, ['Alpha Condition Filament', 'Alpha Explicit Filament']);
assert.equal(alpha.image, '/profiles/CompatibilityFixture/Compatibility Alpha_cover.png');
assert.equal(FS.readFile(alpha.image).length, 4);
const generic = first.filaments.find(group => group.name === 'Generic PLA');
assert.equal(generic.vendor, 'Generic'); assert.equal(generic.type, 'PLA');
assert.deepEqual(generic.presets.map(member => member.name).sort(),
  ['Generic PLA @Compatibility Alpha', 'Generic PLA @Compatibility Beta', 'Generic PLA @System'].sort());
for (const member of generic.presets) {
  assert.equal(member.resource_vendor, member.name.endsWith('@System') ? 'OrcaFilamentLibrary' : 'CompatibilityFixture');
  if (member.name.endsWith('@System')) assert.deepEqual(member.compatible_models, []);
  else assert.deepEqual(member.compatible_models, [{ vendor: 'CompatibilityFixture',
    model: member.name.endsWith('Alpha') ? 'Compatibility Alpha' : 'Compatibility Beta', nozzle_diameter: ['0.4'] }]);
}
assert.deepEqual(first.filaments.find(group => group.name === 'Alpha Condition Filament').presets[0].compatible_models, [],
  'condition-only workspace compatibility is not evaluated by wizard');
assert.deepEqual(first.filaments.find(group => group.name === 'Unknown Explicit').presets[0].compatible_models, [],
  'unknown explicit printer names resolve to Orca empty mapping');
assert.deepEqual(snapshot(), before);
const readsAfterFirst = rawReads;
assert.ok(readsAfterFirst > 0);
assert.deepEqual(must(call('orc_open_setup_wizard_catalogue')).catalogue, first, 'repeated open rebuilds identically');
assert.ok(rawReads > readsAfterFirst, 'second open reparses raw files');
must(call('orc_close_setup_wizard_catalogue'));
must(call('orc_close_setup_wizard_catalogue'));
assert.deepEqual(snapshot(), before);
const sourcePath = '/profiles/CompatibilityFixture/machine-model/alpha.json';
const model = JSON.parse(FS.readFile(sourcePath, { encoding: 'utf8' }));
model.default_materials = 'Updated after close';
FS.writeFile(sourcePath, JSON.stringify(model));
const reopened = must(call('orc_open_setup_wizard_catalogue')).catalogue;
assert.deepEqual(reopened.models.find(model => model.model === 'Compatibility Alpha').default_materials, ['Updated after close'],
  'close retains no projection reused by subsequent open');
must(call('orc_close_setup_wizard_catalogue'));
assert.deepEqual(snapshot(), before);
assert.equal(FS.readdir('/system').some(name => name.includes('CompatibilityFixture')), false);
// Directory discovery failure must neither publish a partial catalogue nor
// mutate the live project; the following open retries from a fresh bundle.
FS.rename('/profiles', '/profiles-hidden');
FS.writeFile('/profiles', 'not a directory');
const failed = call('orc_open_setup_wizard_catalogue');
assert.equal(failed.ok, false); assert.equal(typeof failed.error, 'string');
assert.deepEqual(snapshot(), before);
must(call('orc_close_setup_wizard_catalogue'));
FS.unlink('/profiles'); FS.rename('/profiles-hidden', '/profiles');
assert.deepEqual(must(call('orc_open_setup_wizard_catalogue')).catalogue, reopened);
must(call('orc_close_setup_wizard_catalogue'));
assert.deepEqual(snapshot(), before);
console.log('setup catalogue smoke OK: full raw vendors, inheritance/grouping, explicit mapping, rebuild, live model/history/config/links preserved');
