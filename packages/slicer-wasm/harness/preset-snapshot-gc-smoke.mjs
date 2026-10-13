import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { fixtureProfileOptions, createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';

if (!process.argv[2]) throw new Error('usage: node preset-snapshot-gc-smoke.mjs <orca_slice.js>');
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
const profiles = () => ok(call('orc_get_preset_snapshot'));
const selected = kind => kind === 'filament' ? ok(call('orc_get_filament_session_snapshot')).slots[0].preset.name : profiles()[kind].name;
const info = (kind, name) => call('orc_user_preset_info', [kind, name]);
function prepare(kind, source, name) {
  return ok(request('orc_prepare_user_preset', { history_context: context, action: 'save-as', kind,
    canonical_name: source, name, expected_revision: status().revision }));
}
function finish(receipt, commit = true) { ok(request('orc_finish_user_preset', { token: receipt.token, commit })); }
function save(kind, source, name = source) { const receipt = prepare(kind, source, name); finish(receipt); }
function begin() { return ok(call('orc_history_begin', ['GC regression', 'project', JSON.stringify(context), ''])).transactionId; }
function commit(tx) {
  const result = call('orc_history_commit', [tx, JSON.stringify(context)]);
  assert.ok(result.status, JSON.stringify(result));
}
function processEdit(value) {
  const tx = begin();
  ok(request('orc_mutate_native_scoped_config', { version: 1, operation: 'set', targets: [{ scope: 'project' }], key: 'layer_height', value }));
  commit(tx);
}
function edit(kind, name, value) {
  if (kind === 'print') processEdit(value);
  else ok(request('orc_mutate_preset_draft', { history_context: context, action: 'set', kind, canonical_name: name,
    key: `${kind}_notes`, value, expected_revision: status().revision }));
}
const undo = () => ok(call('orc_history_undo'));
const redo = () => ok(call('orc_history_redo'));
ok(call('orc_init', [fixtureProfileOptions(Module)]));

// Observe native collection membership through the ordinary source lookup.
// A hidden picker row is not evidence that the underlying config was released.
for (const kind of ['printer', 'filament', 'print']) {
  ok(call('orc_close_project'));
  const source = selected(kind);
  const name = `A GC ${kind}`;
  save(kind, source, name);
  edit(kind, name, kind === 'print' ? '0.31' : 'saved revision');
  save(kind, selected(kind), name);
  undo();
  const snapshot = selected(kind);
  assert.match(snapshot, /\[snapshot \d+\]/);
  assert.equal(info(kind, snapshot).ok, true);
  undo();
  assert.equal(selected(kind), source);
  const before = status();

  // Rejected input, explicit abort, an unchanged transaction and a failed
  // persistence operation must leave the exact Redo branch and versions alive.
  assert.equal(request('orc_prepare_user_preset', { history_context: context, action: 'save-as', kind,
    canonical_name: source, name: '', expected_revision: before.revision }).ok, false);
  const cancelled = begin();
  ok(call('orc_history_abort', [cancelled]));
  commit(begin());
  assert.deepEqual(status().redoEntries, before.redoEntries);
  const pending = prepare(kind, source, `Cancelled GC ${kind}`);
  assert.equal(status().canRedo, false);
  assert.equal(info(kind, snapshot).ok, true, 'prepare must retain rollback versions');
  finish(pending, false);
  assert.deepEqual(status().redoEntries, before.redoEntries);
  assert.equal(info(kind, snapshot).ok, true);
  redo();
  assert.equal(selected(kind), snapshot);
  redo();
  assert.equal(selected(kind), name);
  undo(); undo();

  // Exercise the shared atomic path, ordinary transaction path and durable
  // repository finish path; all discard the old branch and release its roots.
  if (kind === 'printer') edit('printer', source, 'new branch');
  else if (kind === 'filament') processEdit('0.37');
  else save(kind, source, `Z GC ${kind}`);
  assert.equal(status().canRedo, false);
  assert.equal(info(kind, snapshot).ok, false, `${kind}: unreachable config still in native collection`);
  if (kind === 'filament') {
    assert.equal(profiles().project_config.layer_height, '0.37', 'GC must preserve the edited Process config');
    const currentPrint = selected('print');
    undo(); redo();
    assert.equal(selected('print'), currentPrint);
    assert.equal(profiles().project_config.layer_height, '0.37');
  } else { undo(); redo(); }
}

// A version shared by the current source/draft and retained Undo must survive
// branch collection, including when a Process edit creates an embedded child.
for (const kind of ['printer', 'filament', 'print']) {
  ok(call('orc_close_project'));
  const source = selected(kind);
  const name = `Shared GC ${kind}`;
  save(kind, source, name);
  edit(kind, name, kind === 'print' ? '0.32' : 'first revision');
  save(kind, selected(kind), name);
  undo();
  const snapshot = selected(kind);
  assert.match(snapshot, /\[snapshot \d+\]/);
  edit(kind, snapshot, kind === 'print' ? '0.38' : 'branch revision');
  assert.equal(info(kind, snapshot).ok, true);
  const branchSelection = selected(kind);
  undo();
  assert.equal(selected(kind), snapshot);
  redo();
  assert.equal(selected(kind), branchSelection);
  assert.equal(info(kind, snapshot).ok, true);
  save(kind, branchSelection, `Retained GC ${kind}`);
  undo();
  assert.equal(selected(kind), branchSelection);
  redo();
  assert.equal(selected(kind), `Retained GC ${kind}`);
  assert.equal(info(kind, snapshot).ok, true, 'surviving history must retain shared versions');
}
// An independent editor may still own a draft on a now-dormant historical
// source when the scene is back on its original system preset.
for (const kind of ['printer', 'filament']) {
  ok(call('orc_close_project'));
  const source = selected(kind);
  const name = `Dormant GC ${kind}`;
  save(kind, source, name);
  edit(kind, name, 'saved version');
  save(kind, name);
  undo();
  const snapshot = selected(kind);
  undo();
  assert.equal(selected(kind), source);
  edit(kind, snapshot, 'dormant draft');
  assert.equal(selected(kind), source, 'browsing/editing must not adopt the dormant source');
  assert.equal(info(kind, snapshot).ok, true);
  const draft = () => ok(call('orc_get_preset_draft', [kind, snapshot]));
  const expectedNotes = kind === 'filament' ? [{ value: 'dormant draft' }] : 'dormant draft';
  assert.deepEqual(draft().overrides[`${kind}_notes`], expectedNotes);
  const dormantEffective = draft().effective_values;
  undo(); redo();
  assert.deepEqual(draft().overrides[`${kind}_notes`], expectedNotes);
  assert.deepEqual(draft().effective_values, dormantEffective);
}
console.log('preset-snapshot-gc PASS: real Printer/Filament/Process release, failure/abort/no-op/persistence rollback, shared Undo/Redo and embedded/dormant draft roots');
process.exit(0);
