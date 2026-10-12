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
ok(call('orc_init', [fixtureProfileOptions(Module)]));
const first = ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name;
assert.equal(ok(call('orc_user_preset_info', ['filament', first])).default_save_as_name, `${first} - Copy`);
const originalTemp = draft(first).effective_values.nozzle_temperature;
const created = mutate('save-as', 'filament', first, { name: 'Neo Local PLA' });
assert.equal(created.history_entry_delta, 1);
assert.equal(created.filament_session.slots[0].preset.name, 'Neo Local PLA');
assert.equal(disk.has('filament/Neo Local PLA.json'), true);
assert.equal(ok(call('orc_user_preset_info', ['filament', 'Neo Local PLA'])).default_save_as_name, 'Neo Local PLA');
let rack = ok(call('orc_get_filament_session_snapshot'));
ok(request('orc_add_filament_slot', { version: 1, revision: rack.revisions.session }));
ok(request('orc_mutate_preset_draft', { action: 'set', kind: 'filament', canonical_name: 'Neo Local PLA',
  key: 'nozzle_temperature', value: '210', expected_revision: status().revision }));
const beforeSave = status();
const saved = mutate('save-as', 'filament', 'Neo Local PLA', { name: 'Neo Local PLA' });
assert.equal(saved.history_entry_delta, 0);
assert.equal(status().undoEntries.length, beforeSave.undoEntries.length);
assert.equal(draft('Neo Local PLA').modified, false);
assert.deepEqual(draft('Neo Local PLA').overrides, {});
ok(call('orc_history_undo'));
let slot = ok(call('orc_get_filament_session_snapshot')).slots[0];
assert.match(slot.preset.name, /snapshot/);
assert.equal(draft(slot.preset.name).effective_values.nozzle_temperature, originalTemp);
assert.ok(draft(slot.preset.name).source_values.nozzle_temperature.split(',').every(value => value === '210'));
ok(call('orc_history_redo'));
slot = ok(call('orc_get_filament_session_snapshot')).slots[0];
assert.equal(slot.preset.name, 'Neo Local PLA');
assert.ok(draft(slot.preset.name).effective_values.nozzle_temperature.split(',').every(value => value === '210'));
assert.ok(ok(call('orc_get_filament_session_snapshot')).slots.every(row => row.preset.name === 'Neo Local PLA'));
// Reset on a historical version uses the current saved baseline for all slots.
ok(call('orc_history_undo'));
slot = ok(call('orc_get_filament_session_snapshot')).slots[0];
ok(request('orc_mutate_preset_draft', { action: 'reset-preset', kind: 'filament', canonical_name: slot.preset.name, expected_revision: status().revision }));
assert.ok(ok(call('orc_get_filament_session_snapshot')).slots.every(row => row.preset.name === 'Neo Local PLA'));
assert.equal(draft('Neo Local PLA').modified, false);
ok(request('orc_mutate_preset_draft', { action: 'set', kind: 'filament', canonical_name: 'Neo Local PLA',
  key: 'nozzle_temperature', value: '220', expected_revision: status().revision }));
mutate('save', 'filament', 'Neo Local PLA');
ok(call('orc_history_undo'));
const olderBeforeDelete = ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name;
assert.ok(draft(olderBeforeDelete).effective_values.nozzle_temperature.split(',').every(value => value === '210'));
mutate('delete', 'filament', olderBeforeDelete);
assert.equal(disk.has('filament/Neo Local PLA.json'), false);
ok(call('orc_history_undo'));
slot = ok(call('orc_get_filament_session_snapshot')).slots[0];
assert.equal(slot.preset.label, 'Neo Local PLA (Deleted)');
assert.equal(ok(call('orc_user_preset_info', ['filament', slot.preset.name])).default_save_as_name, 'Neo Local PLA');
assert.ok(draft(slot.preset.name).effective_values.nozzle_temperature.split(',').every(value => value === '210'));
assert.ok(draft(slot.preset.name).source_values.nozzle_temperature.split(',').every(value => value === '220'));
const deletedInfo = ok(call('orc_user_preset_info', ['filament', slot.preset.name]));
assert.equal(deletedInfo.can_save, false);
assert.equal(deletedInfo.deleted, true);
assert.equal(disk.has('filament/Neo Local PLA.json'), false);
const recreated = mutate('save-as', 'filament', slot.preset.name, { name: 'Neo Local PLA' });
assert.equal(recreated.filament_session.slots[0].preset.name, 'Neo Local PLA');
ok(call('orc_history_undo'));
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots[0].preset.label, 'Neo Local PLA (Deleted)');
ok(call('orc_history_redo'));
const beforeFailed = status();
mutate('save-as', 'filament', 'Neo Local PLA', { name: 'Failed Save' }, false);
assert.deepEqual(status(), beforeFailed);
assert.equal(call('orc_user_preset_info', ['filament', 'Failed Save']).ok, false);
assert.equal(request('orc_prepare_user_preset', { action: 'save-as', kind: 'filament', canonical_name: 'Neo Local PLA', name: first, confirm_overwrite: true, expected_revision: status().revision }).ok, false);

// An independent editor can save/delete a dormant source without changing the project.
let profiles = ok(call('orc_get_preset_snapshot'));
const dormant = profiles.filament_catalog.find(row => row.name !== 'Neo Local PLA' && !row.name.includes('[snapshot')).name;
const activeBefore = ok(call('orc_get_filament_session_snapshot')).slots.map(row => row.preset.name);
const dormantSave = mutate('save-as', 'filament', dormant, { name: 'Dormant Local.INI' });
assert.equal(ok(call('orc_user_preset_info', ['filament', 'Dormant Local.INI'])).default_save_as_name, 'Dormant Local');
assert.equal(dormantSave.history_entry_delta, 0);
assert.deepEqual(dormantSave.filament_session.slots.map(row => row.preset.name), activeBefore);
const dormantDelete = mutate('delete', 'filament', 'Dormant Local.INI');
assert.equal(dormantDelete.history_entry_delta, 0);
assert.deepEqual(dormantDelete.filament_session.slots.map(row => row.preset.name), activeBefore);

// A child retains old effective parameters when its inactive parent is saved.
mutate('save-as', 'filament', 'Neo Local PLA', { name: 'Local Child' });
ok(request('orc_mutate_preset_draft', { action: 'set', kind: 'filament', canonical_name: 'Neo Local PLA',
  key: 'nozzle_temperature', value: '230', expected_revision: status().revision }));
assert.equal(mutate('save', 'filament', 'Neo Local PLA').history_entry_delta, 0);
const child = ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name;
assert.match(child, /snapshot/);
assert.ok(draft(child).effective_values.nozzle_temperature.split(',').every(value => value === '210'));
assert.ok(draft(child).source_values.nozzle_temperature.split(',').every(value => value === '230'));
assert.equal(request('orc_prepare_user_preset', { action: 'delete', kind: 'filament', canonical_name: 'Neo Local PLA', expected_revision: status().revision }).ok, false);
ok(request('orc_mutate_preset_draft', { action: 'reset-preset', kind: 'filament', canonical_name: child, expected_revision: status().revision }));
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name, 'Local Child');

// Printer save/overwrite follows the same identity and draft rules.
profiles = ok(call('orc_get_preset_snapshot'));
mutate('save-as', 'printer', profiles.printer.name, { name: 'Neo Local Printer' });
ok(request('orc_mutate_preset_draft', { action: 'set', kind: 'printer', canonical_name: 'Neo Local Printer', key: 'printer_notes', value: 'local printer', expected_revision: status().revision }));
mutate('save', 'printer', 'Neo Local Printer');
ok(call('orc_history_undo'));
assert.match(ok(call('orc_get_preset_snapshot')).printer.name, /snapshot/);
ok(call('orc_history_redo'));
assert.equal(ok(call('orc_get_preset_snapshot')).printer.name, 'Neo Local Printer');
// A local user profile compares effective values with its saved head, including
// explicit equal-value edits; system profiles retain their existing semantics.
ok(request('orc_mutate_preset_draft', { action: 'set', kind: 'printer', canonical_name: 'Neo Local Printer', key: 'printer_notes', value: 'local printer', expected_revision: status().revision }));
const equalPrinter = ok(call('orc_get_preset_draft', ['printer', 'Neo Local Printer']));
assert.equal(equalPrinter.modified, false);
assert.deepEqual(equalPrinter.overrides, {});

// Process edits materialize Orca's embedded child. Save adopts its saved parent
// without another history entry, and Redo must recover the new saved identity.
profiles = ok(call('orc_get_preset_snapshot'));
mutate('save-as', 'print', profiles.print.name, { name: 'Neo Local Process' });
const historyContext = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
function editProcess(value) {
  const tx = ok(call('orc_history_begin', ['Edit process', 'project', JSON.stringify(historyContext), '']));
  ok(request('orc_mutate_native_scoped_config', { version: 1, operation: 'set', targets: [{ scope: 'project' }], key: 'layer_height', value }));
  call('orc_history_commit', [tx.transactionId, JSON.stringify(historyContext)]);
}
const oldLayer = ok(call('orc_get_preset_snapshot')).project_config.layer_height;
editProcess('0.28');
profiles = ok(call('orc_get_preset_snapshot'));
assert.equal(mutate('save', 'print', profiles.print.name).history_entry_delta, 0);
ok(call('orc_history_undo'));
profiles = ok(call('orc_get_preset_snapshot'));
assert.equal(profiles.project_config.layer_height, oldLayer);
ok(call('orc_history_redo'));
profiles = ok(call('orc_get_preset_snapshot'));
assert.equal(profiles.print.name, 'Neo Local Process');
assert.equal(profiles.project_config.layer_height, '0.28');
// Partial Reset keeps the historical identity; full Reset then adopts the
// head even though all effective parameters already equal that head.
ok(call('orc_history_undo'));
let tx = ok(call('orc_history_begin', ['Reset field', 'project', JSON.stringify(historyContext), '']));
ok(request('orc_mutate_native_scoped_config', { version: 1, operation: 'reset', targets: [{ scope: 'project' }], key: 'layer_height' }));
call('orc_history_commit', [tx.transactionId, JSON.stringify(historyContext)]);
profiles = ok(call('orc_get_preset_snapshot'));
assert.notEqual(profiles.print.name, 'Neo Local Process');
assert.equal(profiles.project_config.layer_height, '0.28');
assert.equal(ok(call('orc_user_preset_info', ['print', profiles.print.name])).can_reset, true);
tx = ok(call('orc_history_begin', ['Reset preset', 'project', JSON.stringify(historyContext), '']));
ok(request('orc_mutate_native_scoped_config', { version: 1, operation: 'reset-all', targets: [{ scope: 'project' }] }));
call('orc_history_commit', [tx.transactionId, JSON.stringify(historyContext)]);
assert.equal(ok(call('orc_get_preset_snapshot')).print.name, 'Neo Local Process');
ok(call('orc_history_undo'));
assert.notEqual(ok(call('orc_get_preset_snapshot')).print.name, 'Neo Local Process');
ok(call('orc_history_redo'));
assert.equal(ok(call('orc_get_preset_snapshot')).print.name, 'Neo Local Process');
mutate('delete', 'print', 'Neo Local Process');
ok(call('orc_history_undo'));
profiles = ok(call('orc_get_preset_snapshot'));
assert.equal(profiles.prints.find(row => row.name === profiles.print.name)?.label, 'Neo Local Process (Deleted)');
assert.equal(profiles.project_config.layer_height, '0.28');

// Only ordinary Orca embedded profiles cross the 3MF boundary.
ok(call('orc_add_shape', ['Cube', 'local preset roundtrip']));
const exported = ok(call('orc_export_project'));
const bytes = Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + exported.bytes_length);
Module._free(Number(exported.bytes_ptr));
for (const entry of readZipEntries(bytes).filter(entry => /Metadata\/.+\.(config|json)$/.test(entry.name)))
  assert.doesNotMatch(new TextDecoder().decode(entry.content), /\[snapshot \d+\]|\(Deleted\)/, entry.name);
const ptr = Module._malloc(bytes.length);
Module.HEAPU8.set(bytes, ptr);
try {
  ok(call('orc_load_project', [Number(ptr), bytes.length, 0, 'local.3mf'], ['pointer', 'number', 'number', 'string']));
}
finally { Module._free(ptr); }
assert.equal(ok(call('orc_get_preset_snapshot')).project_config.layer_height, '0.28');
const imported = ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name;
assert.ok(draft(imported).effective_values.nozzle_temperature.split(',').every(value => value === '230'));
profiles = ok(call('orc_get_preset_snapshot'));
assert.equal(ok(call('orc_get_preset_draft', ['printer', profiles.printer.name])).effective_values.printer_notes, 'local printer');
assert.equal(ok(call('orc_user_preset_info', ['print', profiles.print.name])).can_save, false);
// The shared dialog can overwrite another user destination. Both active
// sources adopt the destination; Undo retains its old version, never its file.
ok(call('orc_init', [fixtureProfileOptions(Module)]));
mutate('save-as', 'filament', first, { name: 'Overwrite Source' });
ok(request('orc_mutate_preset_draft', { action: 'set', kind: 'filament', canonical_name: 'Overwrite Source', key: 'nozzle_temperature', value: '210', expected_revision: status().revision }));
mutate('save-as', 'filament', 'Overwrite Source', { name: 'Overwrite Source' });
mutate('save-as', 'filament', 'Overwrite Source', { name: 'Overwrite Target' });
ok(request('orc_mutate_preset_draft', { action: 'set', kind: 'filament', canonical_name: 'Overwrite Target', key: 'nozzle_temperature', value: '240', expected_revision: status().revision }));
mutate('save', 'filament', 'Overwrite Target');
let overwriteRack = ok(call('orc_get_filament_session_snapshot'));
ok(request('orc_add_filament_slot', { version: 1, revision: overwriteRack.revisions.session }));
overwriteRack = ok(call('orc_get_filament_session_snapshot'));
ok(request('orc_select_filament_slot_preset', { version: 1, revision: overwriteRack.revisions.session, slot: overwriteRack.slots.length, preset: 'Overwrite Source' }));
const overwriteBefore = ok(call('orc_get_filament_session_snapshot'));
const targetFileBefore = disk.get('filament/Overwrite Target.json');
assert.equal(request('orc_prepare_user_preset', { action: 'save-as', kind: 'filament', canonical_name: 'Overwrite Source', name: 'Overwrite Target', expected_revision: status().revision }).ok, false);
const abortedOverwrite = mutate('save-as', 'filament', 'Overwrite Source', { name: 'Overwrite Target', confirm_overwrite: true }, false);
assert.deepEqual(ok(call('orc_get_filament_session_snapshot')), overwriteBefore);
assert.equal(disk.get('filament/Overwrite Target.json'), targetFileBefore);
const crossSaved = mutate('save-as', 'filament', 'Overwrite Source', { name: 'Overwrite Target', confirm_overwrite: true });
assert.equal(crossSaved.history_entry_delta, 1);
assert.ok(crossSaved.filament_session.slots.every(row => row.preset.name === 'Overwrite Target'));
assert.ok(draft('Overwrite Target').effective_values.nozzle_temperature.split(',').every(value => value === '210'));
ok(call('orc_history_undo'));
overwriteRack = ok(call('orc_get_filament_session_snapshot'));
assert.match(overwriteRack.slots[0].preset.name, /snapshot/);
assert.ok(draft(overwriteRack.slots[0].preset.name).effective_values.nozzle_temperature.split(',').every(value => value === '240'));
assert.equal(overwriteRack.slots.at(-1).preset.name, 'Overwrite Source');
ok(call('orc_history_redo'));
assert.ok(ok(call('orc_get_filament_session_snapshot')).slots.every(row => row.preset.name === 'Overwrite Target'));
// Saving a child over its parent retains the active child version and cannot
// create a self-inheritance cycle in the durable destination.
overwriteRack = ok(call('orc_get_filament_session_snapshot'));
ok(request('orc_select_filament_slot_preset', { version: 1, revision: overwriteRack.revisions.session, slot: 1, preset: 'Local Child' }));
const parentOverwrite = mutate('save-as', 'filament', 'Local Child', { name: 'Neo Local PLA', confirm_overwrite: true });
assert.equal(parentOverwrite.history_entry_delta, 1);
assert.equal(parentOverwrite.filament_session.slots[0].preset.name, 'Neo Local PLA');
const parentFile = [...disk].find(([path]) => path.endsWith('/Neo Local PLA.json'));
assert.ok(parentFile, 'the destination may be stored in the native base subdirectory');
assert.notEqual(JSON.parse(parentFile[1]).inherits, 'Neo Local PLA');
ok(call('orc_history_undo'));
assert.match(ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name, /snapshot/);
ok(call('orc_history_redo'));
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name, 'Neo Local PLA');
console.log('user-presets PASS shared save dialog, self/cross overwrite, snapshots, delete, Undo/Redo, Reset, shared slots, dormant editor, Printer, Process, 3MF, name reuse, failed persistence');
process.exit(0);
