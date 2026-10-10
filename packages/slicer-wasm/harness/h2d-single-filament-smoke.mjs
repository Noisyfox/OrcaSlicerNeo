import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages, fixtureProfileOptions } from './profile-installer.mjs';
import { callAsyncTask } from './async-task-mailbox.mjs';
import { readZipEntries } from './native-3mf-parser.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: h2d-single-filament-smoke.mjs <out/serial/orca_slice.js>');
const Module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
}
function session() {
  const value = call('orc_get_filament_session_snapshot');
  assert.equal(value.ok, true, JSON.stringify(value));
  return value;
}
function command(name, body = {}) {
  const value = call(name, ['string'], [JSON.stringify({ version: 1, revision: session().revisions.session, ...body })]);
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.result.mutation.history_entry_delta, 1);
  return value.result.snapshot;
}
function projection(value) {
  return { slots: value.slots, mappings: value.mappings, flushing: value.flushing,
    assignments: value.assignments, routing: value.routing };
}
assert.equal(call('orc_init', ['string'], [fixtureProfileOptions(Module)]).ok, true);
const selected = call('orc_select_preset', ['string', 'string'], ['printer', 'Bambu Lab H2D 0.4 nozzle']);
assert.equal(selected.ok, true, JSON.stringify(selected));
assert.equal(session().slots.length, 1, 'selecting H2D retains the existing material count');
command('orc_add_filament_slot');
assert.equal(session().slots.length, 2);
const alternate = selected.filament_catalog.find(entry => entry.name !== session().slots[0].preset.name);
assert.ok(alternate, 'H2D must expose a second compatible source preset');
command('orc_select_filament_slot_preset', { slot: 2, preset: alternate.name });
command('orc_set_filament_slot_colour', { slot: 1, colour: { kind: 'linear-gradient', start: '#123456', end: '#654321' } });
command('orc_set_filament_slot_colour', { slot: 2, colour: { kind: 'solid', color: '#ABCDEF' } });
assert.equal(call('orc_add_shape', ['string', 'string'], ['Cube', 'Single H2D material']).ok, true);
command('orc_assign_filament', { slot: 2, targets: [{ kind: 'object', id: session().assignments.objects[0].id }] });
command('orc_set_filament_routing', { slot: 2, selector: 'support-interface', targets: [{ kind: 'project', id: 0 }] });

const beforeFailure = session();
const beforeFailureHistory = call('orc_history_status');
const failure = call('orc_delete_filament_slot', ['string'], [JSON.stringify({
  version: 1, revision: beforeFailure.revisions.session, slot: 2, inject_failure_stage: 'before-history',
})]);
assert.equal(failure.error_code, 'native_validation_failure');
assert.deepEqual(session(), beforeFailure);
assert.deepEqual(call('orc_history_status'), beforeFailureHistory);

for (const [name, body, survivor] of [
  ['orc_delete_filament_slot', { slot: 2 }, 0],
  ['orc_delete_filament_slot', { slot: 1 }, 1],
  ['orc_merge_filament_slots', { source: 2, destination: 1 }, 0],
  ['orc_merge_filament_slots', { source: 1, destination: 2 }, 1],
]) {
  const before = session();
  const one = command(name, body);
  assert.equal(one.slots.length, 1);
  assert.equal(one.slots[0].logical_id, before.slots[survivor].logical_id);
  assert.deepEqual(one.slots[0].colour, before.slots[survivor].colour);
  assert.deepEqual(one.slots[0].preset, before.slots[survivor].preset);
  assert.equal(one.capabilities.nozzle_count, 2);
  assert.equal(one.capabilities.min_slots, 1);
  assert.equal(one.capabilities.can_delete, false);
  assert.equal(one.capabilities.can_merge, false);
  assert.equal(one.flushing.matrix_dimension, 1);
  assert.equal(one.flushing.plane_count, 2);
  assert.deepEqual(one.flushing.matrix, [0, 0]);
  assert.ok(one.assignments.objects.every(object => object.effective_slot === 1));
  assert.equal(one.routing.find(route => route.target === 'project' && route.selector === 'support-interface').explicit_slot,
    name === 'orc_delete_filament_slot' && body.slot === 2 ? 0 : 1);
  assert.equal(call('orc_history_undo').ok, true);
  assert.deepEqual(projection(session()), projection(before));
  assert.equal(call('orc_history_redo').ok, true);
  assert.deepEqual(projection(session()), projection(one));
  const added = command('orc_add_filament_slot');
  assert.equal(added.slots.length, 2);
  assert.deepEqual(added.slots[0], one.slots[0]);
  assert.equal(added.flushing.matrix.length, 8);
  assert.equal(call('orc_history_undo').ok, true);
  assert.deepEqual(projection(session()), projection(one));
  assert.equal(call('orc_history_undo').ok, true);
  assert.deepEqual(projection(session()), projection(before));
}

command('orc_delete_filament_slot', { slot: 2 });
const one = session();
const history = call('orc_history_status');
for (const [name, body] of [['orc_delete_filament_slot', { slot: 1 }], ['orc_merge_filament_slots', { source: 1, destination: 1 }]]) {
  const rejected = call(name, ['string'], [JSON.stringify({ version: 1, revision: one.revisions.session, ...body })]);
  assert.equal(rejected.error_code, 'capability_rejected');
  assert.deepEqual(session(), one);
  assert.deepEqual(call('orc_history_status'), history);
}
const exported = call('orc_export_project');
assert.equal(exported.ok, true, JSON.stringify(exported));
const bytes = Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + exported.bytes_length);
Module._free(Number(exported.bytes_ptr));
const config = JSON.parse(new TextDecoder().decode(readZipEntries(bytes).find(entry => entry.name === 'Metadata/project_settings.config').content));
assert.equal(config.filament_colour.length, 1);
assert.equal(config.nozzle_diameter.length, 2);
assert.equal(config.filament_settings_id.length, 2, 'native preset padding is retained');
assert.equal(config.filament_map.length, 2, 'native full_config expands maps to its preset count');
assert.equal(config.flush_volumes_matrix.length, 8);
const sliced = await callAsyncTask(call, 'orc_slice', ['string'], ['{}']);
assert.equal(sliced.ok, true, JSON.stringify(sliced));
assert.equal(session().slots.length, 1);
// A process/profile lifecycle must not resurrect the padded preset as a slot.
const reselected = call('orc_select_preset', ['string', 'string'], ['printer', 'Bambu Lab H2D 0.4 nozzle']);
assert.equal(reselected.ok, true, JSON.stringify(reselected));
assert.equal(session().slots.length, 1);
const pointer = Number(Module._malloc(bytes.length));
Module.HEAPU8.set(bytes, pointer);
let loaded;
try { loaded = call('orc_load_project', ['pointer', 'number', 'number', 'string'], [pointer, bytes.length, 0, 'h2d-one-material.3mf']); }
finally { Module._free(pointer); }
assert.equal(loaded.ok, true, JSON.stringify(loaded));
assert.equal(session().slots.length, 1);
assert.deepEqual(session().slots[0].colour, one.slots[0].colour);
assert.equal(session().capabilities.nozzle_count, 2);
// Padded native preset #2 must never pass material-index validation.
const beforeInvalid = session();
const beforeInvalidHistory = call('orc_history_status');
for (const [name, body] of [
  ['orc_set_filament_slot_colour', { slot: 2, colour: { kind: 'solid', color: '#123456' } }],
  ['orc_select_filament_slot_preset', { slot: 2, preset: beforeInvalid.slots[0].preset.name }],
  ['orc_assign_filament', { slot: 2, targets: [{ kind: 'object', id: beforeInvalid.assignments.objects[0].id }] }],
  ['orc_set_filament_routing', { slot: 2, selector: 'support-interface', targets: [{ kind: 'project', id: 0 }] }],
]) {
  const invalid = call(name, ['string'], [JSON.stringify({ version: 1, revision: beforeInvalid.revisions.session, ...body })]);
  assert.equal(invalid.ok, false, name);
  assert.deepEqual(session(), beforeInvalid, name);
  assert.deepEqual(call('orc_history_status'), beforeInvalidHistory, name);
}
const reexported = call('orc_export_project');
assert.equal(reexported.ok, true, JSON.stringify(reexported));
const savedBytes = Module.HEAPU8.slice(Number(reexported.bytes_ptr), Number(reexported.bytes_ptr) + reexported.bytes_length);
Module._free(Number(reexported.bytes_ptr));
const saved = JSON.parse(new TextDecoder().decode(readZipEntries(savedBytes).find(entry => entry.name === 'Metadata/project_settings.config').content));
assert.equal(saved.filament_colour.length, 1);
assert.equal(saved.filament_settings_id.length, 2);
assert.equal((await callAsyncTask(call, 'orc_slice', ['string'], ['{}'])).ok, true);
console.log('H2D single-filament smoke OK: delete/merge, history, add, padded presets, actual-slot validation, profile lifecycle, 3MF roundtrip, slice');
