import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { fixtureProfileOptions, createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { readZipEntries } from './native-3mf-parser.mjs';

const editingContext = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };

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
  const prepared = ok(request('orc_prepare_user_preset', { history_context: editingContext, action, kind, canonical_name, expected_revision: status().revision, ...extra }));
  if (commit) {
    if (prepared.change.content === null) disk.delete(prepared.change.path);
    else disk.set(prepared.change.path, prepared.change.content);
  }
  ok(request('orc_finish_user_preset', { token: prepared.token, commit }));
  return prepared.result;
}
ok(call('orc_init', [fixtureProfileOptions(Module)]));
const firstPreset = ok(call('orc_get_filament_session_snapshot')).slots[0].preset;
const first = firstPreset.name;
assert.equal(ok(call('orc_user_preset_info', ['filament', first])).default_save_as_name, `${first} - Copy`);
const originalTemp = draft(first).effective_values.nozzle_temperature;
const created = mutate('save-as', 'filament', first, { name: 'Neo Local PLA' });
assert.equal(created.history_entry_delta, 1);
assert.equal(created.filament_session.slots[0].preset.name, 'Neo Local PLA');
assert.equal(created.filament_session.slots[0].preset.is_user, true);
assert.equal(disk.has('filament/Neo Local PLA.json'), true);
assert.equal(draft('Neo Local PLA').editor_candidates.find(row => row.canonical_name === 'Neo Local PLA').is_user, true);
assert.equal(ok(call('orc_get_preset_snapshot')).filament_catalog.find(row => row.name === 'Neo Local PLA').is_user, true);
assert.equal(ok(call('orc_user_preset_info', ['filament', 'Neo Local PLA'])).default_save_as_name, 'Neo Local PLA');
let rack = ok(call('orc_get_filament_session_snapshot'));
ok(request('orc_add_filament_slot', { version: 1, revision: rack.revisions.session }));
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'set', kind: 'filament', canonical_name: 'Neo Local PLA',
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
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'reset-preset', kind: 'filament', canonical_name: slot.preset.name, expected_revision: status().revision }));
assert.ok(ok(call('orc_get_filament_session_snapshot')).slots.every(row => row.preset.name === 'Neo Local PLA'));
assert.equal(draft('Neo Local PLA').modified, false);
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'set', kind: 'filament', canonical_name: 'Neo Local PLA',
  key: 'nozzle_temperature', value: '220', expected_revision: status().revision }));
mutate('save', 'filament', 'Neo Local PLA');
ok(call('orc_history_undo'));
const olderBeforeDelete = ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name;
assert.ok(draft(olderBeforeDelete).effective_values.nozzle_temperature.split(',').every(value => value === '210'));
mutate('delete', 'filament', olderBeforeDelete);
assert.equal(disk.has('filament/Neo Local PLA.json'), false);
ok(call('orc_history_undo'));
slot = ok(call('orc_get_filament_session_snapshot')).slots[0];
assert.equal(slot.preset.label, firstPreset.label);
assert.equal(slot.preset.is_user, false);
assert.equal(draft(slot.preset.name).editor_candidates.find(row => row.canonical_name === slot.preset.name).is_user, false);
assert.equal(ok(call('orc_user_preset_info', ['filament', slot.preset.name])).default_save_as_name, 'Neo Local PLA');
assert.ok(draft(slot.preset.name).effective_values.nozzle_temperature.split(',').every(value => value === '210'));
assert.equal(draft(slot.preset.name).source_values.nozzle_temperature, originalTemp);
const deletedInfo = ok(call('orc_user_preset_info', ['filament', slot.preset.name]));
assert.equal(deletedInfo.can_save, false);
assert.equal(deletedInfo.deleted, true);
assert.equal(disk.has('filament/Neo Local PLA.json'), false);
const recreated = mutate('save-as', 'filament', slot.preset.name, { name: 'Neo Local PLA' });
assert.equal(recreated.filament_session.slots[0].preset.name, 'Neo Local PLA');
ok(call('orc_history_undo'));
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots[0].preset.label, firstPreset.label);
ok(call('orc_history_redo'));
const beforeFailed = status();
mutate('save-as', 'filament', 'Neo Local PLA', { name: 'Failed Save' }, false);
assert.deepEqual(status(), beforeFailed);
assert.equal(call('orc_user_preset_info', ['filament', 'Failed Save']).ok, false);
assert.equal(request('orc_prepare_user_preset', { history_context: editingContext, action: 'save-as', kind: 'filament', canonical_name: 'Neo Local PLA', name: first, confirm_overwrite: true, expected_revision: status().revision }).ok, false);

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
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'set', kind: 'filament', canonical_name: 'Neo Local PLA',
  key: 'nozzle_temperature', value: '230', expected_revision: status().revision }));
assert.equal(mutate('save', 'filament', 'Neo Local PLA').history_entry_delta, 0);
const child = ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name;
assert.match(child, /snapshot/);
assert.ok(draft(child).effective_values.nozzle_temperature.split(',').every(value => value === '210'));
assert.ok(draft(child).source_values.nozzle_temperature.split(',').every(value => value === '230'));
assert.equal(request('orc_prepare_user_preset', { history_context: editingContext, action: 'delete', kind: 'filament', canonical_name: 'Neo Local PLA', expected_revision: status().revision }).ok, false);
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'reset-preset', kind: 'filament', canonical_name: child, expected_revision: status().revision }));
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name, 'Local Child');

// Printer save/overwrite follows the same identity and draft rules.
profiles = ok(call('orc_get_preset_snapshot'));
mutate('save-as', 'printer', profiles.printer.name, { name: 'Neo Local Printer' });
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'set', kind: 'printer', canonical_name: 'Neo Local Printer', key: 'printer_notes', value: 'local printer', expected_revision: status().revision }));
mutate('save', 'printer', 'Neo Local Printer');
ok(call('orc_history_undo'));
assert.match(ok(call('orc_get_preset_snapshot')).printer.name, /snapshot/);
ok(call('orc_history_redo'));
assert.equal(ok(call('orc_get_preset_snapshot')).printer.name, 'Neo Local Printer');
// A local user profile compares effective values with its saved head, including
// explicit equal-value edits; system profiles retain their existing semantics.
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'set', kind: 'printer', canonical_name: 'Neo Local Printer', key: 'printer_notes', value: 'local printer', expected_revision: status().revision }));
const equalPrinter = ok(call('orc_get_preset_draft', ['printer', 'Neo Local Printer']));
assert.equal(equalPrinter.modified, false);
assert.deepEqual(equalPrinter.overrides, {});

// Process edits materialize Orca's embedded child. Save adopts its saved parent
// without another history entry, and Redo must recover the new saved identity.
profiles = ok(call('orc_get_preset_snapshot'));
const parentPrintLabel = profiles.prints.find(row => row.name === profiles.print.name).label;
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
assert.equal(profiles.prints.find(row => row.name === profiles.print.name).is_user, true);
// Partial Reset keeps the historical identity. Its diff becomes empty, so the
// existing Reset All UI is disabled. The native full-reset command can still
// adopt the head when invoked directly by this internal contract test.
ok(call('orc_history_undo'));
let tx = ok(call('orc_history_begin', ['Reset field', 'project', JSON.stringify(historyContext), '']));
ok(request('orc_mutate_native_scoped_config', { version: 1, operation: 'reset', targets: [{ scope: 'project' }], key: 'layer_height' }));
call('orc_history_commit', [tx.transactionId, JSON.stringify(historyContext)]);
profiles = ok(call('orc_get_preset_snapshot'));
assert.notEqual(profiles.print.name, 'Neo Local Process');
assert.equal(profiles.project_config.layer_height, '0.28');
assert.equal(ok(call('orc_user_preset_info', ['print', profiles.print.name])).can_reset, true);
assert.equal(Object.hasOwn(ok(call('orc_get_native_scoped_config')).native_scoped_config.snapshot.project, 'layer_height'), false);
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
assert.equal(profiles.prints.find(row => row.name === profiles.print.name)?.label, parentPrintLabel);
assert.equal(profiles.prints.find(row => row.name === profiles.print.name)?.is_user, false);
assert.equal(profiles.project_config.layer_height, '0.28');

// Deleted Process differences and Reset use its system parent, not saved 0.28.
assert.equal(ok(call('orc_get_native_scoped_config')).native_scoped_config.snapshot.project.layer_height, '0.28');
tx = ok(call('orc_history_begin', ['Reset deleted preset', 'project', JSON.stringify(historyContext), '']));
ok(request('orc_mutate_native_scoped_config', { version: 1, operation: 'reset-all', targets: [{ scope: 'project' }] }));
call('orc_history_commit', [tx.transactionId, JSON.stringify(historyContext)]);
assert.equal(ok(call('orc_get_preset_snapshot')).project_config.layer_height, oldLayer);
assert.equal(Object.hasOwn(ok(call('orc_get_native_scoped_config')).native_scoped_config.snapshot.project, 'layer_height'), false);
ok(call('orc_history_undo'));
assert.equal(ok(call('orc_get_preset_snapshot')).project_config.layer_height, '0.28');

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
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'set', kind: 'filament', canonical_name: 'Overwrite Source', key: 'nozzle_temperature', value: '210', expected_revision: status().revision }));
mutate('save-as', 'filament', 'Overwrite Source', { name: 'Overwrite Source' });
mutate('save-as', 'filament', 'Overwrite Source', { name: 'Overwrite Target' });
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'set', kind: 'filament', canonical_name: 'Overwrite Target', key: 'nozzle_temperature', value: '240', expected_revision: status().revision }));
mutate('save', 'filament', 'Overwrite Target');
let overwriteRack = ok(call('orc_get_filament_session_snapshot'));
ok(request('orc_add_filament_slot', { version: 1, revision: overwriteRack.revisions.session }));
overwriteRack = ok(call('orc_get_filament_session_snapshot'));
ok(request('orc_select_filament_slot_preset', { version: 1, revision: overwriteRack.revisions.session, slot: overwriteRack.slots.length, preset: 'Overwrite Source' }));
const overwriteBefore = ok(call('orc_get_filament_session_snapshot'));
const targetFileBefore = disk.get('filament/Overwrite Target.json');
assert.equal(request('orc_prepare_user_preset', { history_context: editingContext, action: 'save-as', kind: 'filament', canonical_name: 'Overwrite Source', name: 'Overwrite Target', expected_revision: status().revision }).ok, false);
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
// Deleted child snapshots follow the nearest surviving original ancestor.
ok(call('orc_init', [fixtureProfileOptions(Module)]));
mutate('save-as', 'filament', first, { name: 'Parent Chain' });
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'set', kind: 'filament', canonical_name: 'Parent Chain', key: 'nozzle_temperature', value: '231', expected_revision: status().revision }));
mutate('save', 'filament', 'Parent Chain');
mutate('save-as', 'filament', 'Parent Chain', { name: 'Child Chain' });
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'set', kind: 'filament', canonical_name: 'Child Chain', key: 'nozzle_temperature', value: '241', expected_revision: status().revision }));
mutate('save', 'filament', 'Child Chain');
// Orca Save As normally retains the existing system inheritance. Load an
// explicit user-parent relationship to exercise a real multi-level chain.
// Native user libraries load base/ before derived files.
Module.FS.mkdirTree('/user/default/filament/base');
Module.FS.writeFile('/user/default/filament/base/Parent Chain.json', disk.get('filament/Parent Chain.json'));
Module.FS.unlink('/user/default/filament/Parent Chain.json');
const childFile = JSON.parse(disk.get('filament/Child Chain.json'));
childFile.inherits = 'Parent Chain';
Module.FS.writeFile('/user/default/filament/Child Chain.json', JSON.stringify(childFile));
ok(call('orc_init', [fixtureProfileOptions(Module)]));
let chainRack = ok(call('orc_get_filament_session_snapshot'));
ok(request('orc_select_filament_slot_preset', { version: 1, revision: chainRack.revisions.session, slot: 1, preset: 'Child Chain' }));
mutate('delete', 'filament', 'Child Chain');
ok(call('orc_history_undo'));
const deletedChild = ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name;
assert.equal(draft(deletedChild).editor_candidates.find(row => row.canonical_name === deletedChild)?.label, 'Parent Chain');
assert.equal(draft(deletedChild).editor_candidates.find(row => row.canonical_name === deletedChild)?.is_user, true);
assert.ok(draft(deletedChild).source_values.nozzle_temperature.split(',').every(value => value === '231'));
assert.ok(draft(deletedChild).effective_values.nozzle_temperature.split(',').every(value => value === '241'));
// A surviving parent's current saved values remain the comparison baseline.
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'set', kind: 'filament', canonical_name: 'Parent Chain', key: 'nozzle_temperature', value: '232', expected_revision: status().revision }));
mutate('save', 'filament', 'Parent Chain');
assert.ok(draft(deletedChild).source_values.nozzle_temperature.split(',').every(value => value === '232'));
assert.ok(draft(deletedChild).effective_values.nozzle_temperature.split(',').every(value => value === '241'));
mutate('delete', 'filament', 'Parent Chain');
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots[0].preset.label, firstPreset.label);
assert.equal(draft(deletedChild).source_values.nozzle_temperature, originalTemp);
mutate('save-as', 'filament', first, { name: 'Parent Chain' });
assert.equal(draft(deletedChild).source_values.nozzle_temperature, originalTemp);
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name, deletedChild);
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'reset-preset', kind: 'filament', canonical_name: deletedChild, expected_revision: status().revision }));
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name, deletedChild);
assert.equal(draft(deletedChild).modified, false);
assert.equal(draft(deletedChild).effective_values.nozzle_temperature, originalTemp);
assert.equal(ok(call('orc_user_preset_info', ['filament', deletedChild])).can_save, false);
ok(call('orc_history_undo'));
assert.ok(draft(deletedChild).effective_values.nozzle_temperature.split(',').every(value => value === '241'));

// Close while the deleted Filament is still active, before printer changes
// can legitimately normalize the rack for another printer.
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name, deletedChild);
ok(call('orc_close_project'));
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name, first);
assert.equal(call('orc_user_preset_info', ['filament', deletedChild]).ok, false);

// Printer deletion uses the same parent label and parameter baseline.
profiles = ok(call('orc_get_preset_snapshot'));
const printerParent = profiles.printer.name;
const printerParentDraft = ok(call('orc_get_preset_draft', ['printer', printerParent]));
const printerParentLabel = ok(call('orc_user_preset_info', ['printer', printerParent])).label;
mutate('save-as', 'printer', printerParent, { name: 'Deleted Printer' });
ok(request('orc_mutate_preset_draft', { history_context: editingContext, action: 'set', kind: 'printer', canonical_name: 'Deleted Printer', key: 'printer_notes', value: 'retained notes', expected_revision: status().revision }));
mutate('save', 'printer', 'Deleted Printer');
mutate('delete', 'printer', 'Deleted Printer');
ok(call('orc_history_undo'));
const deletedPrinter = ok(call('orc_get_preset_snapshot')).printer.name;
assert.equal(ok(call('orc_get_preset_snapshot')).printers.find(row => row.name === deletedPrinter).is_user, false);
const deletedPrinterDraft = ok(call('orc_get_preset_draft', ['printer', deletedPrinter]));
assert.equal(deletedPrinterDraft.editor_candidates.find(row => row.canonical_name === deletedPrinter)?.label, printerParentLabel);
assert.equal(deletedPrinterDraft.source_values.printer_notes, printerParentDraft.source_values.printer_notes);
assert.equal(deletedPrinterDraft.effective_values.printer_notes, 'retained notes');
assert.equal(deletedPrinterDraft.modified, true);

// New Project releases tombstones only after resolving their parent selections.
const processBeforeBoundary = ok(call('orc_get_preset_snapshot')).print.name;
mutate('save-as', 'print', processBeforeBoundary, { name: 'Boundary Process' });
mutate('delete', 'print', 'Boundary Process');
ok(call('orc_history_undo'));
ok(call('orc_close_project'));
const afterBoundary = ok(call('orc_get_preset_snapshot'));
assert.equal(afterBoundary.printer.name, printerParent);
assert.equal(afterBoundary.print.name, processBeforeBoundary);
assert.equal(status().canUndo, false);
assert.equal(call('orc_user_preset_info', ['printer', deletedPrinter]).ok, false);
assert.equal(call('orc_user_preset_info', ['filament', deletedChild]).ok, false);

// Renderer-only selection/gizmo changes are sampled at the next mutation,
// independently of whatever editing context the preceding history entry held.
ok(call('orc_add_shape', ['Cube', 'preset editing context']));
assert.equal(request('orc_history_reset', editingContext).canUndo, false);
const contextObject = ok(call('orc_get_model_structure')).objects[0];
function sampleContext(mode, gizmo) {
  editingContext.selection = { mode,
    objectIds: mode === 'object' ? [contextObject.id] : [],
    partIds: mode === 'part' ? [contextObject.volumes[0].id] : [],
    instanceIds: mode === 'instance' ? [contextObject.instances[0].id] : [] };
  editingContext.gizmo = { type: gizmo };
}
function checkContextRoundtrip() {
  for (const command of ['orc_history_undo', 'orc_history_redo']) {
    const restored = ok(call(command));
    assert.deepEqual(restored.context.selection, editingContext.selection, `${command}: renderer selection`);
    assert.deepEqual(restored.context.gizmo, editingContext.gizmo, `${command}: renderer gizmo`);
  }
}
for (const kind of ['printer', 'filament', 'print']) {
  const source = kind === 'filament' ? ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name
    : ok(call('orc_get_preset_snapshot'))[kind].name;
  const revision = status().revision;
  const bodies = [
    ['orc_prepare_user_preset', { action: 'save-as', kind, canonical_name: source, name: `Context ${kind}`, expected_revision: revision }],
    ...(kind === 'print' ? [] : [['orc_mutate_preset_draft', { action: 'set', kind, canonical_name: source,
      key: `${kind}_notes`, value: 'context regression', expected_revision: revision }]]),
  ];
  for (const [command, body] of bodies) {
    const historyBefore = status();
    const profileBefore = ok(call('orc_get_preset_snapshot'));
    for (const fields of [{}, { history_context: null }, { history_context: {} }]) {
      assert.equal(request(command, { ...body, ...fields }).ok, false, `${command} requires valid renderer context`);
      assert.deepEqual(status(), historyBefore);
      assert.deepEqual(ok(call('orc_get_preset_snapshot')), profileBefore);
    }
  }
  if (kind !== 'print') {
    sampleContext('part', 'scale');
    ok(request('orc_mutate_preset_draft', { ...bodies[1][1], history_context: editingContext }));
    checkContextRoundtrip();
  }
  sampleContext('object', 'move');
  assert.equal(mutate('save-as', kind, source, { name: `Context ${kind}` }).history_entry_delta, 1);
  checkContextRoundtrip();
  sampleContext('instance', 'rotate');
  assert.equal(mutate('delete', kind, `Context ${kind}`).history_entry_delta, 1);
  checkContextRoundtrip();
}

console.log('user-presets PASS shared save dialog, self/cross overwrite, snapshots, delete, Undo/Redo, Reset, shared slots, dormant editor, Printer, Process, 3MF, name reuse, failed persistence, required renderer context and selection/gizmo roundtrips');
process.exit(0);
