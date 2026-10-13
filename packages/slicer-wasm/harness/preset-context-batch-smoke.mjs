import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { fixtureProfileOptions, createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';

if (!process.argv[2]) throw new Error('usage: node preset-context-batch-smoke.mjs <orca_slice.js>');
const Module = await (await loadModuleFactory(resolve(process.argv[2])))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, args = []) {
  const pointer = Number(Module.ccall(name, 'number', args.map(() => 'string'), args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
}
const request = (name, body) => call(name, [JSON.stringify(body)]);
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const status = () => call('orc_history_status');
const rack = () => ok(call('orc_get_filament_session_snapshot'));
const draft = name => ok(call('orc_get_preset_draft', ['filament', name]));
const notes = name => JSON.parse(draft(name).effective_values.filament_notes);
function prepare(action, name, extra = {}) {
  return ok(request('orc_prepare_user_preset', { history_context: context, action, kind: 'filament', canonical_name: name,
    expected_revision: status().revision, ...extra }));
}
function finish(receipt, commit = true) { ok(request('orc_finish_user_preset', { token: receipt.token, commit })); }
function save(name, target = name) { const receipt = prepare('save-as', name, { name: target }); finish(receipt); return receipt; }
function edit(name, key, value) {
  ok(request('orc_mutate_preset_draft', { history_context: context, action: 'set', kind: 'filament', canonical_name: name,
    key, value, expected_revision: status().revision }));
}
function select(slot, name) {
  ok(request('orc_select_filament_slot_preset', { version: 1, revision: rack().revisions.session, slot, preset: name }));
}
const undo = () => ok(call('orc_history_undo'));
const redo = () => ok(call('orc_history_redo'));
const temperature = (name, expected) => assert.ok(draft(name).effective_values.nozzle_temperature.split(',').every(value => value === expected), name);
const parent = 'A Batch Parent';
const children = ['B Batch Child', 'C Batch Sibling', 'D Batch Grandchild'];
ok(call('orc_init', [fixtureProfileOptions(Module)]));
const system = rack().slots[0].preset.name;
save(system, parent);
edit(parent, 'nozzle_temperature', '210');
save(parent);
for (const child of children) {
  save(parent, child);
  edit(child, 'filament_notes', child);
  save(child);
}
// Native Save As preserves system inheritance. Build an explicit multi-source,
// two-level user chain using ordinary Orca JSON, then load it through startup.
Module.FS.mkdirTree('/user/default/filament/base/base');
for (const name of [parent, ...children]) {
  const path = `/user/default/filament/${name}.json`;
  const file = JSON.parse(Module.FS.readFile(path, { encoding: 'utf8' }));
  if (name !== parent) {
    file.inherits = name === children[2] ? children[0] : parent;
    delete file.nozzle_temperature;
  }
  const target = name === children[2] ? path : `/user/default/filament/base/${name === parent ? 'base/' : ''}${name}.json`;
  Module.FS.writeFile(target, JSON.stringify(file));
  if (target !== path) Module.FS.unlink(path);
}
ok(call('orc_init', [fixtureProfileOptions(Module)]));
for (const child of children) temperature(child, '210');
edit(parent, 'nozzle_temperature', '250');
for (let index = 0; index < children.length; ++index) {
  if (index > 0) ok(request('orc_add_filament_slot', { version: 1, revision: rack().revisions.session }));
  select(index + 1, children[index]);
}
edit(children[0], 'filament_notes', 'live child draft');
const checkpoint = request('orc_history_mark_saved', context);
assert.equal(checkpoint.dirty, false);
edit(children[1], 'filament_notes', 'redo sibling draft');
undo();
const beforeStatus = status();
const beforeRack = rack();
const beforeDrafts = children.map(draft);
const filePath = `/user/default/filament/base/base/${parent}.json`;
const beforeFile = Module.FS.readFile(filePath, { encoding: 'utf8' });
assert.equal(beforeStatus.canRedo, true);
assert.equal(beforeStatus.dirty, false);
const rejected = prepare('save', parent);
finish(rejected, false);
assert.deepEqual(status(), beforeStatus);
assert.deepEqual(rack(), beforeRack);
assert.deepEqual(children.map(draft), beforeDrafts);
assert.equal(Module.FS.readFile(filePath, { encoding: 'utf8' }), beforeFile);
redo();
assert.equal(notes(children[1]), 'redo sibling draft');
undo();

const saved = save(parent);
assert.equal(saved.result.history_entry_delta, 0);
assert.deepEqual(status().undoEntries, beforeStatus.undoEntries);
assert.deepEqual(status().redoEntries, beforeStatus.redoEntries);
assert.equal(status().savedCheckpoint, beforeStatus.savedCheckpoint);
assert.equal(status().dirty, false);
const frozen = rack().slots.map(slot => slot.preset.name);
assert.equal(new Set(frozen).size, children.length);
for (let index = 0; index < children.length; ++index) {
  assert.match(frozen[index], /\[snapshot \d+\]/);
  temperature(frozen[index], '210');
  assert.ok(draft(frozen[index]).source_values.nozzle_temperature.split(',').every(value => value === '250'), 'saved child baseline follows the new parent');
}
assert.equal(notes(frozen[0]), 'live child draft');
undo();
assert.equal(notes(rack().slots[0].preset.name), children[0]);
redo();
assert.deepEqual(rack().slots.map(slot => slot.preset.name), frozen);
assert.equal(status().dirty, false);
redo();
assert.equal(notes(rack().slots[1].preset.name), 'redo sibling draft');
for (const slot of rack().slots) temperature(slot.preset.name, '210');
undo();
assert.equal(status().dirty, false);
assert.match(JSON.parse(Module.FS.readFile(filePath, { encoding: 'utf8' })).nozzle_temperature.join(','), /^250/);

// Active Save As overwrites the ancestor from a child. It retains every old
// child/source together and records exactly one selection entry.
select(1, children[0]);
const activeBefore = rack();
const overwrite = prepare('save-as', children[0], { name: parent, confirm_overwrite: true });
finish(overwrite, false);
assert.deepEqual(rack(), activeBefore);
const accepted = prepare('save-as', children[0], { name: parent, confirm_overwrite: true });
finish(accepted);
assert.equal(accepted.result.history_entry_delta, 1);
assert.equal(rack().slots[0].preset.name, parent);
undo();
assert.match(rack().slots[0].preset.name, /\[snapshot \d+\]/);
temperature(rack().slots[0].preset.name, '250');
redo();
assert.equal(rack().slots[0].preset.name, parent);
console.log('preset-context-batch PASS: three descendants, inherited values, live drafts, retained Undo/Redo, saved checkpoint, persistence rollback and active child-to-parent overwrite');
process.exit(0);
