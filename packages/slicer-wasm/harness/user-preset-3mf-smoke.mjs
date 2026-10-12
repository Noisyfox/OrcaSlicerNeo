import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { fixtureProfileOptions, createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { readZipEntries } from './native-3mf-parser.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: node user-presets-smoke.mjs <orca_slice.js>');
const Module = await (await loadModuleFactory(resolve(modulePath)))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, args = [], types = args.map(() => 'string')) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
}
const request = (name, body) => call(name, [JSON.stringify(body)]);
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const status = () => call('orc_history_status');
const draft = name => ok(call('orc_get_preset_draft', ['filament', name]));
const disk = new Map();
function mutate(action, kind, canonical_name, extra = {}, commit = true) {
  const prepared = ok(request('orc_prepare_user_preset', { action, kind, canonical_name, expected_revision: status().revision, ...extra }));
  if (commit) {
    if (prepared.change.content === null) disk.delete(prepared.change.path);
    else disk.set(prepared.change.path, prepared.change.content);
  }
  ok(request('orc_finish_user_preset', { token: prepared.token, commit }));
  return prepared.result;
}
// Saved user identities survive 3MF interchange; missing users stay embedded.
ok(call('orc_init', [fixtureProfileOptions(Module)]));
const first = ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name;
let roundtripProfiles = ok(call('orc_get_preset_snapshot'));
mutate('save-as', 'printer', roundtripProfiles.printer.name, { name: 'Roundtrip Printer' });
mutate('save-as', 'print', roundtripProfiles.print.name, { name: 'Roundtrip Process' });
mutate('save-as', 'filament', first, { name: 'Roundtrip Filament' });
let roundtripRack = ok(call('orc_get_filament_session_snapshot'));
ok(request('orc_add_filament_slot', { version: 1, revision: roundtripRack.revisions.session }));
function roundtripExport() {
  const archive = ok(call('orc_export_project'));
  const content = Module.HEAPU8.slice(Number(archive.bytes_ptr), Number(archive.bytes_ptr) + archive.bytes_length);
  Module._free(Number(archive.bytes_ptr));
  for (const entry of readZipEntries(content).filter(entry => /Metadata\/.+\.(config|json)$/.test(entry.name)))
    assert.doesNotMatch(new TextDecoder().decode(entry.content), /\[snapshot \d+\]|\(Deleted\)/, entry.name);
  return content;
}
function roundtripLoad(content) {
  const buffer = Module._malloc(content.length);
  Module.HEAPU8.set(content, buffer);
  try { ok(call('orc_load_project', [Number(buffer), content.length, 0, 'users.3mf'], ['pointer', 'number', 'number', 'string'])); }
  finally { Module._free(buffer); }
}
function assertRoundtripIdentities() {
  const profiles = ok(call('orc_get_preset_snapshot'));
  assert.equal(profiles.printer.name, 'Roundtrip Printer');
  assert.equal(profiles.print.name, 'Roundtrip Process');
  assert.ok(ok(call('orc_get_filament_session_snapshot')).slots.every(slot => slot.preset.name === 'Roundtrip Filament'));
  assert.equal(profiles.printers.find(preset => preset.name === profiles.printer.name).is_project_embedded, false);
  assert.equal(profiles.prints.find(preset => preset.name === profiles.print.name).is_project_embedded, false);
  assert.ok(ok(call('orc_get_filament_session_snapshot')).slots.every(slot => !slot.preset.is_project_embedded));
  for (const [kind, name] of [['printer', 'Roundtrip Printer'], ['print', 'Roundtrip Process'], ['filament', 'Roundtrip Filament']])
    assert.equal(ok(call('orc_user_preset_info', [kind, name])).can_save, true);
}
roundtripLoad(roundtripExport());
assertRoundtripIdentities();
ok(request('orc_mutate_preset_draft', { action: 'set', kind: 'printer', canonical_name: 'Roundtrip Printer', key: 'printer_notes', value: 'project notes', expected_revision: status().revision }));
ok(request('orc_mutate_preset_draft', { action: 'set', kind: 'filament', canonical_name: 'Roundtrip Filament', key: 'nozzle_temperature', value: '237', expected_revision: status().revision }));
ok(request('orc_mutate_native_scoped_config', { version: 1, operation: 'set', targets: [{ scope: 'project' }], key: 'layer_height', value: '0.27' }));
const editedUserArchive = roundtripExport();
// The library may have advanced since export; importing must keep file values.
ok(request('orc_mutate_preset_draft', { action: 'set', kind: 'filament', canonical_name: 'Roundtrip Filament', key: 'nozzle_temperature', value: '245', expected_revision: status().revision }));
mutate('save', 'filament', 'Roundtrip Filament');
roundtripLoad(editedUserArchive);
assertRoundtripIdentities();
assert.equal(ok(call('orc_get_preset_snapshot')).project_config.layer_height, '0.27');
assert.equal(ok(call('orc_get_preset_draft', ['printer', 'Roundtrip Printer'])).effective_values.printer_notes, 'project notes');
assert.ok(draft('Roundtrip Filament').effective_values.nozzle_temperature.split(',').every(value => value === '237'));
// Durable files are unchanged by importing project overrides.
const filesBeforeReload = new Map(disk);
roundtripLoad(editedUserArchive);
assert.deepEqual(disk, filesBeforeReload);
for (const [kind, name] of [['printer', 'Roundtrip Printer'], ['print', 'Roundtrip Process'], ['filament', 'Roundtrip Filament']])
  mutate('delete', kind, name);
ok(call('orc_init', [fixtureProfileOptions(Module)]));
roundtripLoad(editedUserArchive);
const missingProfiles = ok(call('orc_get_preset_snapshot'));
assert.equal(missingProfiles.printers.find(preset => preset.name === missingProfiles.printer.name).is_project_embedded, true);
assert.equal(missingProfiles.prints.find(preset => preset.name === missingProfiles.print.name).is_project_embedded, true);
assert.equal(missingProfiles.project_config.layer_height, '0.27');
assert.equal(ok(call('orc_user_preset_info', ['printer', missingProfiles.printer.name])).can_save, false);
assert.equal(ok(call('orc_get_preset_draft', ['printer', missingProfiles.printer.name])).effective_values.printer_notes, 'project notes');
assert.equal(ok(call('orc_user_preset_info', ['print', missingProfiles.print.name])).can_save, false);
const missingFilament = ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name;
assert.ok(ok(call('orc_get_filament_session_snapshot')).slots.every(slot => slot.preset.is_project_embedded));
assert.equal(ok(call('orc_user_preset_info', ['filament', missingFilament])).can_save, false);
assert.ok(draft(missingFilament).effective_values.nozzle_temperature.split(',').every(value => value === '237'));

console.log('user-preset-3mf PASS installed identities, project overrides, advanced saved head, multiple slots and missing-library fallback');
process.exit(0);
