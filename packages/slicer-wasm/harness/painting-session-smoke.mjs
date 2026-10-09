import { fixtureProfileOptions } from './profile-installer.mjs';
// Real serial-WASM lifecycle coverage; no production painting test hooks.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { buildPaintedFacetProject, buildPaintingChannelProject } from './painted-facet-fixture-builder.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: painting-session-smoke.mjs <orca_slice.js>');
const Module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
}
const command = (name, request) => call(name, ['string'], [JSON.stringify(request)]);
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
const error = result => { assert.equal(typeof result.error, 'string', JSON.stringify(result)); return result; };
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const history = () => call('orc_history_status');
const structure = () => ok(call('orc_get_model_structure')).objects;
const observe = () => ({ history: history(), model: structure(), plates: call('orc_get_plate_session_snapshot') });
const bytes = await buildPaintedFacetProject();
function load(input = bytes) {
  const pointer = Number(Module._malloc(input.length));
  Module.HEAPU8.set(input, pointer);
  try { return ok(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [pointer, input.length, 0, 'painting-session.3mf'])); }
  finally { Module._free(pointer); }
}
const handle = session => ({ version: 1, channel: session.channel, sessionId: session.id, revision: session.revision });
const target = object => ({ objectId: object.id, instanceId: object.instances[0].id });
const open = (hs, object) => command('orc_painting_session_open', { version: 1, channel: 'mmu', historySessionId: hs, ...target(object) });
const read = session => command('orc_painting_session_read', handle(session));
ok(command('orc_init', JSON.parse(fixtureProfileOptions(Module))));
load();
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Second solid']));
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Modifier']));
ok(call('orc_merge_objects_to_multipart', ['string', 'string'], [JSON.stringify(structure().map(o => o.id)), 'Painting assembly']));
let assembly = structure()[0];
ok(call('orc_set_volume_type', ['number', 'string'], [assembly.volumes[2].id, 'parameter_modifier']));
ok(call('orc_set_object_printable', ['number', 'number'], [assembly.id, 0]));
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Other target']));
[assembly] = structure();
const other = structure()[1];
command('orc_history_reset', context);
const hs = ok(command('orc_history_session_open', {})).sessionId;
const before = observe();
const session = ok(open(hs, assembly)).session;
assert.equal(session.parts.length, 2);
assert.deepEqual(session.parts.map(p => p.volumeId), assembly.volumes.slice(0, 2).map(v => v.id));
assert.ok(session.parts[0].facetCounts.slice(1).some(count => count > 0), 'load committed painting');
assert.ok(session.parts[0].facetCounts.reduce((a, b) => a + b, 0) > session.parts[0].sourceTriangleCount, 'retain subdivision');
assert.equal(session.parts[1].facetCounts[0], 12);
assert.equal(session.strokeId, null);
assert.match(session.parts[0].draftResourceId, /^pd-/);
assert.deepEqual(ok(read(session)).session, session);
assert.deepEqual(observe(), before, 'open/read never change model, plate or history');
error(open(hs, assembly));
for (const patch of [{ sessionId: 'ps-01' }, { sessionId: session.id + '\0suffix' },
  { sessionId: 'ps-18446744073709551616' }, { revision: session.revision + 1 }, { revision: -1 },
  { version: 2 }, { unknown: true }]) error(command('orc_painting_session_read', { ...handle(session), ...patch }));
error(command('orc_painting_session_target', { ...handle(session), objectId: other.id, instanceId: assembly.instances[0].id }));
assert.deepEqual(ok(read(session)).session, session);
const switched = ok(command('orc_painting_session_target', { ...handle(session), ...target(other) })).session;
assert.equal(switched.id, session.id);
assert.equal(switched.historySessionId, hs);
assert.equal(switched.revision, session.revision + 1);
assert.notEqual(switched.parts[0].draftResourceId, session.parts[0].draftResourceId);
assert.deepEqual(observe(), before, 'target switch preserves history and committed model');
error(read(session));
const tx = ok(call('orc_history_begin', ['string', 'string', 'string', 'string'], ['Busy', 'project', JSON.stringify(context), '']));
error(read(switched));
ok(call('orc_history_abort', ['string'], [tx.transactionId]));
// Closing does not need to dereference target pointers after a history restore.
ok(command('orc_painting_session_close', handle(switched)));
error(read(switched));
const fresh = ok(open(hs, structure()[1])).session;
assert.notEqual(fresh.id, session.id);
ok(command('orc_history_session_close', { sessionId: hs }));
error(read(fresh));
const hs2 = ok(command('orc_history_session_open', {})).sessionId;
const resetSession = ok(open(hs2, structure()[1])).session;
command('orc_history_reset', context);
error(read(resetSession));
const hs3 = ok(command('orc_history_session_open', {})).sessionId;
const replacedSession = ok(open(hs3, structure()[1])).session;
load();
error(read(replacedSession));
assert.equal(history().editingSession, null);
const hs4 = ok(command('orc_history_session_open', {})).sessionId;
const last = ok(open(hs4, structure()[0])).session;
assert.notEqual(last.id, replacedSession.id);
ok(call('orc_clear_model'));
error(read(last));
ok(command('orc_history_session_close', { sessionId: hs4 }));
// One-slot continuation uses an unpainted target; slot mutations and selector
// reconciliation are separate from the entry-only gate.
load();
ok(call('orc_clear_model'));
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'One-slot continuation']));
command('orc_history_reset', context);
const hs5 = ok(command('orc_history_session_open', {})).sessionId;
const continued = ok(open(hs5, structure()[0])).session;
const rack = call('orc_get_filament_session_snapshot');
ok(command('orc_delete_filament_slot', { version: 1, revision: rack.revisions.session, slot: 2 }));
const reconciled = ok(command('orc_painting_session_read', { ...handle(continued), latest: true })).session;
const rebound = ok(command('orc_painting_session_target', { ...handle(reconciled), ...target(structure()[0]) })).session;
assert.equal(rebound.id, continued.id);
ok(read(rebound));
ok(command('orc_painting_session_close', handle(rebound)));
error(open(hs5, structure()[0]));
ok(command('orc_history_session_close', { sessionId: hs5 }));
// New channels use their own imported trees and remain legal with one slot.
load(await buildPaintingChannelProject());
let singleRack = ok(call('orc_get_filament_session_snapshot'));
ok(command('orc_merge_filament_slots', { version: 1, revision: singleRack.revisions.session, source: 2, destination: 1 }));
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Independent channel second part']));
ok(call('orc_merge_objects_to_multipart', ['string', 'string'], [JSON.stringify(structure().map(o => o.id)), 'Channel assembly']));
command('orc_history_reset', context);
const channelHistory = ok(command('orc_history_session_open', {})).sessionId;
const channelObject = structure()[0];
for (const channel of ['support', 'seam', 'fuzzy']) {
  const request = { version: 1, channel, historySessionId: channelHistory, ...target(channelObject) };
  const { channel: removed, ...missing } = request;
  error(command('orc_painting_session_open', missing));
  error(command('orc_painting_session_open', { ...request, channel: 'invalid' }));
  const observed = observe();
  const active = ok(command('orc_painting_session_open', request)).session;
  assert.equal(active.channel, channel);
  assert.equal(active.parts.length, 2);
  assert.ok(active.parts[0].facetCounts.reduce((a,b) => a+b,0) > 12, `${channel} imported its independent split tree`);
  assert.ok(active.parts[0].facetCounts[1] > 0);
  assert.ok(active.parts[0].annotationTimestamp > 0);
  assert.match(active.parts[0].draftResourceId, new RegExp(`^pd-${channel}-`));
  assert.equal(active.parts[1].facetCounts[0], 12);
  error(command('orc_painting_session_read', { ...handle(active), channel: 'mmu' }));
  error(command('orc_painting_session_close', { ...handle(active), channel: 'mmu' }));
  assert.deepEqual(observe(), observed);
  ok(command('orc_painting_session_close', handle(active)));
}
error(command('orc_painting_session_open', { version: 1, channel: 'mmu', historySessionId: channelHistory, ...target(channelObject) }));
ok(command('orc_history_session_close', { sessionId: channelHistory }));
// A malformed imported active channel cannot silently clamp its legal state
// domain or borrow the legal MMU tree. Failure leaves all model/history roots.
const channelFixture = await buildPaintingChannelProject();
for (const [channel, attribute, state] of [['support', 'paint_supports', '0C'], ['seam', 'paint_seam', '0C'], ['fuzzy', 'paint_fuzzy_skin', '8']]) {
  const corrupted = writeStoredZip(readZipEntries(channelFixture).map(entry => entry.name !== '3D/3dmodel.model' ? entry : {
    ...entry, content: new TextEncoder().encode(new TextDecoder().decode(entry.content).replace(new RegExp(`${attribute}="[^"]*"`), `${attribute}="${state}"`))
  }));
  load(corrupted);
  const malformedHistory = ok(command('orc_history_session_open', {})).sessionId;
  const observed = observe();
  error(command('orc_painting_session_open', { version: 1, channel, historySessionId: malformedHistory, ...target(structure()[0]) }));
  assert.deepEqual(observe(), observed);
  ok(command('orc_history_session_close', { sessionId: malformedHistory }));
}
console.log('Painting session real-WASM lifecycle smoke passed');
