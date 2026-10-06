// Native bed-type validation, result retention, transactions and history.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { awaitAsyncTask, callAsyncTask, getSliceResult, exportGcode } from './async-task-mailbox.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { setNativeScopedConfig, resetNativeScopedConfig, mutateNativeScopedConfig } from './native-scoped-command.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const moduleArg = process.argv[2];
if (!moduleArg) throw new Error('usage: bed-type-lifecycle-smoke.mjs <module.js>');
const Module = await (await loadModuleFactory(resolve(moduleArg)))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
}
function must(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function request(name, body) { return call(name, ['string'], [JSON.stringify(body)]); }
function session() { return must(call('orc_get_plate_session_snapshot')); }
function config() { return must(call('orc_get_native_scoped_config')).native_scoped_config.snapshot; }
function profiles() { return must(call('orc_get_preset_snapshot')); }
function pass(label) { console.log(`bed-type-lifecycle PASS ${label}`); }
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
function resetHistory() { const result = call('orc_history_reset', ['string'], [JSON.stringify(context)]); assert.equal(result.error, undefined); return result; }
function begin() { return must(call('orc_history_begin', ['string', 'string', 'string', 'string'], ['Bed Type', 'project', JSON.stringify(context), ''])); }
function commit(transaction) {
  const result = call('orc_history_commit', ['string', 'string'], [transaction.transactionId, JSON.stringify(context)]);
  assert.equal(result.error, undefined, JSON.stringify(result)); return result;
}
function set(scope, id, value) { return must(setNativeScopedConfig(call, scope, id, 'curr_bed_type', value)); }
function transition(printer) { return must(request('orc_select_printer_with_remembered_rack', { printer, remembered_bed_type: null, remembered_rack: null })); }
function draft(key, value) {
  const printer = profiles().printer.name;
  const source = must(call('orc_get_preset_draft', ['string', 'string'], ['printer', printer]));
  return must(request('orc_mutate_preset_draft', { action: 'set', kind: 'printer', canonical_name: printer,
    expected_revision: source.revision, key, value }));
}
const receipts = new Map();
async function slice(id) {
  const result = must(await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'], ['{}', id, session().input_revisions[id]]));
  receipts.set(id, result.receipt);
  must(getSliceResult(call, result.receipt));
}
function result(id) { return getSliceResult(call, receipts.get(id)); }
function stale(id) { assert.equal(result(id).ok, false); }

must(call('orc_init', ['string'], ['{"log_level":"error"}']));
transition('Bambu Lab X1 Carbon 0.4 nozzle');
must(call('orc_clear_model'));
const a = session().current_plate_id;
must(call('orc_add_shape', ['string', 'string'], ['Cube', 'Inheriting plate']));
must(call('orc_add_plate'));
const b = session().current_plate_id;
must(call('orc_add_shape', ['string', 'string'], ['Cube', 'Explicit plate']));
set('project', undefined, 'High Temp Plate');
set('plate', b, 'High Temp Plate');
resetHistory();
await slice(a);
await slice(b);
const before = session();
const exportedBefore = must(exportGcode(call, receipts.get(b)));
const retainedGcode = Module.FS.readFile(exportedBefore.path, { encoding: 'utf8' });
assert.ok((retainedGcode.match(/^G1\b[^\r\n]*\b[XY][-\d.]+[^\r\n]*\bE[\d.]+/gm) ?? []).length > 10,
  'retained result has real extrusion paths');
const tx = begin();
const globalEdit = set('project', undefined, 'Textured PEI Plate');
assert.deepEqual(globalEdit.plate_session.affected_plate_ids, [a]);
assert.equal(session().input_revisions[b], before.input_revisions[b]);
commit(tx);
stale(a);
must(result(b));
assert.equal(Module.FS.readFile(must(exportGcode(call, receipts.get(b))).path, { encoding: 'utf8' }), retainedGcode);
pass('global bed change retains explicit-equal override stamps, result and export bytes');


const noOpSession = session();
const noOpConfig = config();
const noOpHistory = call('orc_history_status');
const unchanged = set('project', undefined, 'Textured PEI Plate');
assert.equal(unchanged.plate_session, undefined);
assert.deepEqual(session(), noOpSession);
assert.deepEqual(call('orc_history_status'), noOpHistory);
pass('repeated global value creates no mutation, stamp or history entry');

const rejected = mutateNativeScopedConfig(call, 'set', [{ scope: 'project' }, { scope: 'plate', id: b }],
  { values: { curr_bed_type: 'not-a-bed', print_sequence: 'by layer' } });
assert.equal(rejected.ok, false);
assert.equal(rejected.error_code, 'native_validation_failure');
assert.deepEqual(session(), noOpSession);
assert.deepEqual(call('orc_history_status'), noOpHistory);
must(result(b));
assert.deepEqual(config(), noOpConfig);
pass('invalid multi-target bed write rejects atomically');

must(call('orc_history_undo'));
assert.equal(config().project.curr_bed_type, 'High Temp Plate');
stale(a); stale(b);
must(call('orc_history_redo'));
assert.equal(config().project.curr_bed_type, 'Textured PEI Plate');
stale(a); stale(b);
pass('global bed Undo/Redo restores native values and retains existing shared-history invalidation');

await slice(a);
await slice(b);
const abortSession = session();
const abortTx = begin();
set('project', undefined, 'Cool Plate');
stale(a);
must(call('orc_history_abort', ['string'], [abortTx.transactionId]));
assert.deepEqual(session().input_revisions, abortSession.input_revisions);
assert.equal(config().project.curr_bed_type, 'Textured PEI Plate');
must(result(a)); must(result(b));
pass('transaction abort restores native bed roots, stamps and presentation');

const reset = must(resetNativeScopedConfig(call, 'plate', b, 'curr_bed_type'));
assert.deepEqual(reset.plate_session.affected_plate_ids, [b]);
assert.equal(config().plates[b]?.curr_bed_type, undefined);
must(result(a)); stale(b);
set('plate', b, 'Engineering Plate');
resetHistory();
const changed = transition('Bambu Lab A1 mini 0.4 nozzle');
assert.equal(changed.mutation.history_entry_delta, 1);
assert.equal(config().plates[b]?.curr_bed_type, undefined);
assert.equal(changed.native_scoped_config.snapshot.plates[b]?.curr_bed_type, undefined);
assert.equal(config().project.curr_bed_type, changed.profile_snapshot.bed_type.default_value);
assert.equal(setNativeScopedConfig(call, 'plate', b, 'curr_bed_type', 'Engineering Plate').ok, false);
must(call('orc_history_undo'));
assert.equal(config().plates[b].curr_bed_type, 'Engineering Plate');
must(call('orc_history_redo'));
assert.equal(config().plates[b]?.curr_bed_type, undefined);
pass('printer transition removes unsupported local type in one undoable action');
const excludedDefault = draft('default_bed_type', 'Engineering Plate');
assert.equal(excludedDefault.profile_snapshot.bed_type.default_value, 'Engineering Plate');
assert.equal(config().project.curr_bed_type, excludedDefault.profile_snapshot.bed_type.choices[0].value);
pass('excluded configured default normalizes to first native supported choice');

transition('Snapmaker U1 (0.4 nozzle)');
set('project', undefined, 'Engineering Plate');
must(resetNativeScopedConfig(call, 'project', undefined, 'curr_bed_type'));
assert.equal(config().project.curr_bed_type, 'Textured PEI Plate');
pass('selectable project reset restores printer default');
set('plate', b, 'High Temp Plate');
set('project', undefined, 'Engineering Plate');
draft('support_multi_bed_types', '1');
assert.equal(config().project.curr_bed_type, 'Engineering Plate');
assert.equal(config().plates[b].curr_bed_type, 'High Temp Plate');
pass('explicit draft with unchanged effective capabilities preserves selected bed roots');
resetHistory();
const disabled = draft('support_multi_bed_types', '0');
assert.equal(disabled.history_entry_delta, 1);
assert.equal(disabled.profile_snapshot.bed_type.supports_selection, false);
assert.equal(disabled.native_scoped_config.snapshot.project.curr_bed_type, 'Textured PEI Plate');
assert.equal(disabled.native_scoped_config.snapshot.plates[b]?.curr_bed_type, undefined);
assert.equal(setNativeScopedConfig(call, 'plate', b, 'curr_bed_type', 'Textured PEI Plate').ok, false);
assert.equal(setNativeScopedConfig(call, 'project', undefined, 'curr_bed_type', 'Cool Plate').ok, false);
const restored = must(call('orc_history_undo'));
assert.equal(restored.profile_snapshot.bed_type.supports_selection, true);
assert.equal(config().project.curr_bed_type, 'Engineering Plate');
assert.equal(config().plates[b].curr_bed_type, 'High Temp Plate');
const redone = must(call('orc_history_redo'));
assert.equal(redone.profile_snapshot.bed_type.supports_selection, false);
assert.equal(config().plates[b]?.curr_bed_type, undefined);
pass('effective support toggle and Undo/Redo publish normalized roots/capability snapshot');
const globalReset = must(resetNativeScopedConfig(call, 'project', undefined, 'curr_bed_type'));
assert.equal(config().project.curr_bed_type, 'Textured PEI Plate');
assert.equal(globalReset.plate_session, undefined);
pass('single-bed project reset retains supported native default and is unchanged');

transition('Bambu Lab X1 Carbon 0.4 nozzle');
set('plate', b, 'Cool Plate');
const both = must(mutateNativeScopedConfig(call, 'set', [{ scope: 'project' }],
  { values: { curr_bed_type: 'Engineering Plate', layer_height: '0.1' } }));
assert.deepEqual(new Set(both.plate_session.affected_plate_ids), new Set([a, b]));
pass('combined shared setting edit retains all-plate invalidation');
const activeOverrideSlice = call('orc_slice_plate', ['string', 'string', 'number'], ['{}', b, session().input_revisions[b]]);
if (activeOverrideSlice.accepted === true) {
  const mailbox = call('orc_drain_async_task_mailbox');
  assert.ok(!(mailbox.messages ?? []).some(message => message.type === 'task-terminal' && message.task_id === activeOverrideSlice.task_id), 'override slice remains admitted before unrelated global edit');
}
const unrelated = set('project', undefined, 'Textured PEI Plate');
assert.deepEqual(unrelated.plate_session.affected_plate_ids, [a]);
const activeOverrideResult = must(await awaitAsyncTask(call, activeOverrideSlice));
must(getSliceResult(call, activeOverrideResult.receipt));
if (activeOverrideSlice.accepted === true) pass('admitted threaded override slice completes across unrelated global bed edit without cancellation');
receipts.set(b, activeOverrideResult.receipt);
set('project', undefined, 'Textured PEI Plate');

console.log('bed-type-lifecycle PASS all native lifecycle checks');
process.exit(0);
