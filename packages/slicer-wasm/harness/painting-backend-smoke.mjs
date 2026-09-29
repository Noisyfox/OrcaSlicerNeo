// Real-WASM command coverage using generated, repository-owned 3MF inputs.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { buildPaintedFacetProject } from './painted-facet-fixture-builder.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: painting-engine-smoke.mjs <orca_slice.js>');
const Module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
}
const command = (name, value) => call(name, ['string'], [JSON.stringify(value)]);
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const error = value => { assert.equal(typeof value.error, 'string', JSON.stringify(value)); return value; };
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const structure = () => ok(call('orc_get_model_structure')).objects;
const observe = () => ({ history: call('orc_history_status'), model: structure(), plates: call('orc_get_plate_session_snapshot') });
const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
function top(x = 98, y = 103) {
  const projection = [...identity]; projection[0] = .025; projection[5] = .025; projection[10] = -.005;
  const view = [...identity]; view[12] = -100; view[13] = -100; view[14] = -100;
  return { pointer: [(x - 60) * 2.5, (140 - y) * 2.5], viewport: [0,0,200,200], projection, view };
}
const source = await buildPaintedFacetProject();
function fixture(gap = false) {
  return writeStoredZip(readZipEntries(source).map(entry => {
    if (entry.name !== '3D/3dmodel.model') return entry;
    let xml = new TextDecoder().decode(entry.content).replace(/ paint_color="[^"]*"/g, '');
    if (gap) {
      // Replace all three coordinates deterministically, retaining the known
      // 20-mm cube's topology but reducing each triangle area to 2 mm².
      xml = xml.replace(/<vertex\b[^>]*>/g, vertex => vertex.replace(/="(-?)10"/g, (_, sign) => `="${sign}1"`));
      xml = xml.replace(/<triangle\b([^>]*?)\/>/, '<triangle$1 paint_color="4"/>');
    }
    return { ...entry, content: new TextEncoder().encode(xml) };
  }));
}
function load(bytes) {
  const pointer = Number(Module._malloc(bytes.length)); Module.HEAPU8.set(bytes, pointer);
  try { ok(call('orc_load_project', ['pointer','number','number','string'], [pointer, bytes.length, 0, 'painting-engine.3mf'])); }
  finally { Module._free(pointer); }
  command('orc_history_reset', context);
}
let session, hs;
const handle = () => ({ version: 1, sessionId: session.id, revision: session.revision });
const read = () => ok(command('orc_painting_session_read', handle())).session;
function update(name, request) {
  const reply = ok(command(name, { ...handle(), ...request }));
  session = { ...session, revision: reply.revision, strokeId: reply.strokeId, phase: reply.phase };
  return reply;
}
function open() {
  hs = ok(command('orc_history_session_open', {})).sessionId;
  const object = structure()[0];
  session = ok(command('orc_painting_session_open', { version: 1, historySessionId: hs, objectId: object.id, instanceId: object.instances[0].id })).session;
}
const begin = (tool, settings = {}, event = top(), extra = {}) => update('orc_painting_stroke_begin', { tool, settings, ...(event ? { event } : {}), ...extra });
const sample = (settings, event) => update('orc_painting_stroke_sample', { strokeId: session.strokeId, settings, event });
const finish = () => update('orc_painting_stroke_finish', { strokeId: session.strokeId });
const cancel = () => update('orc_painting_stroke_cancel', { strokeId: session.strokeId });
const preview = (tool, settings, event) => update('orc_painting_preview', { tool, settings, ...(event ? { event } : {}) });

const history = () => call('orc_history_status');
const refresh = () => { session = ok(command('orc_painting_session_read', { ...handle(), latest: true })).session; return session; };
const commit = extra => update('orc_painting_stroke_commit', { strokeId: session.strokeId, ...extra });
function geometry(knownResourceIds = []) {
  const result = ok(command('orc_painting_geometry', { ...handle(), knownResourceIds }));
  try { for (const resource of result.resources) {
      resource.vertices = Array.from(new Float32Array(Module.HEAPU8.slice(resource.vertex_ptr, resource.vertex_ptr + resource.vertexCount * 24).buffer));
      resource.contour = Array.from(new Float32Array(Module.HEAPU8.slice(resource.contour_ptr, resource.contour_ptr + resource.contourVertexCount * 12).buffer));
  } } finally { Module.ccall('orc_painting_geometry_release', null, ['string'], [JSON.stringify({ version: 1, leaseId: result.leaseId })]); }
  return result;
}
function mesh() {
  const result = ok(call('orc_get_model_mesh'));
  for (const resource of [...result.geometries, ...result.paint_geometries]) {
    if (resource.vertex_ptr) Module._free(resource.vertex_ptr);
    if (resource.index_ptr) Module._free(resource.index_ptr);
  }
  return result;
}
function exportedPaint() {
  const result = ok(call('orc_export_project'));
  const bytes = Module.HEAPU8.slice(result.bytes_ptr, result.bytes_ptr + result.bytes_length); Module._free(result.bytes_ptr);
  return new TextDecoder().decode(readZipEntries(bytes).find(e => e.name === '3D/3dmodel.model').content);
}
ok(command('orc_init', { log_level: 'error' }));
load(fixture());
// Keep a third empty plate as an unaffected input-generation witness.
const twoPlates = ok(call('orc_add_plate')); ok(call('orc_add_plate'));
const secondOrigin = twoPlates.plates[1].origin;
ok(call('orc_set_instance_offset', ['number','number','number','number','number'], [0,1, secondOrigin[0] + 100, secondOrigin[1] + 100, 10]));
ok(call('orc_recompute_plate_membership'));
command('orc_history_reset', context); open();
const initialGeometry = geometry(); const firstKey = initialGeometry.parts[0].resourceId;
assert.equal(geometry([firstKey]).resources.length, 0);
assert.equal(mesh().paint_geometries.length, 0);
const plateBefore = ok(call('orc_get_plate_session_snapshot'));
const before = history();
begin('triangle', { state: 2 }, top(92, 105));
const draftGeometry = geometry([firstKey]); assert.ok(draftGeometry.resources.length > 0);
assert.notEqual(draftGeometry.parts[0].resourceId, firstKey);
assert.equal(mesh().paint_geometries.length, 0, 'draft never replaces committed scene');
const committed = commit({ settings: { state: 2 }, event: top(108, 95) });
assert.equal(committed.committed, true); assert.equal(committed.phase, 'idle');
assert.equal(committed.history.undoEntries.length, before.undoEntries.length + 1);
assert.ok(refresh().parts[0].facetCounts[2] >= 2, 'final release endpoint painted another original face');
assert.ok(mesh().paint_geometries.length > 0);
assert.match(exportedPaint(), /paint_color=/);
const plateAfter = ok(call('orc_get_plate_session_snapshot'));
for (const plate of plateBefore.plates) {
  const affected = committed.affectedPlateIds.includes(plate.plate_id);
  assert.equal(plateAfter.input_revisions[plate.plate_id] !== plateBefore.input_revisions[plate.plate_id], affected);
}
assert.equal(committed.affectedPlateIds.length, 2, 'both plates containing shared object instances invalidated');
const committedCounts = refresh().parts.map(p => p.facetCounts);
const committedExport = exportedPaint();
const undoPlateBefore = ok(call('orc_get_plate_session_snapshot'));
const undone = ok(call('orc_history_undo')); refresh(); assert.equal(session.parts[0].facetCounts[2], 0);
assert.deepEqual([...undone.affected_plate_ids].sort(), [...committed.affectedPlateIds].sort());
for (const id of committed.affectedPlateIds) assert.notEqual(ok(call('orc_get_plate_session_snapshot')).input_revisions[id], undoPlateBefore.input_revisions[id]);
assert.equal(mesh().paint_geometries.length, 0);
ok(call('orc_history_redo')); refresh(); assert.deepEqual(session.parts.map(p => p.facetCounts), committedCounts);
assert.equal(exportedPaint(), committedExport);
// Same-colour region still publishes native candidate membership and contour.
preview('region', { state: 2 }, top());
const candidate = geometry(); const overlay = candidate.resources.find(r => r.kind === 'region');
assert.ok(overlay && overlay.vertexCount > 0 && overlay.contourVertexCount > 0);
assert.equal(geometry(candidate.resources.map(r => r.resourceId)).resources.length, 0);
// A changed draft returning to clean must replace its last published geometry.
begin('triangle', { state: 1 }); const changed = geometry();
sample({ state: 2 }, top()); const clean = geometry(changed.parts.map(p => p.resourceId));
assert.equal(clean.resources.length, 1); assert.notEqual(clean.parts[0].resourceId, changed.parts[0].resourceId);
assert.equal(commit().committed, false);
// Failure is injected only in the test build, through a non-production ABI.
const stableHistory = history(); const stablePlates = call('orc_get_plate_session_snapshot');
begin('sphere', { state: 1, radius: 50 });
Module.ccall('orc_painting_test_fail_next_commit', null, [], []);
const failure = error(command('orc_painting_stroke_commit', { ...handle(), strokeId: session.strokeId }));
assert.equal(failure.recovered, true); session.revision = failure.revision; refresh();
assert.equal(session.phase, 'idle'); assert.deepEqual(session.parts.map(p => p.facetCounts), committedCounts);
assert.deepEqual(history(), stableHistory); assert.deepEqual(call('orc_get_plate_session_snapshot'), stablePlates);
assert.equal(exportedPaint(), committedExport);
begin('triangle', { state: 1 }); assert.equal(commit().committed, true);
begin('triangle', { state: 2 }); assert.equal(commit().committed, true);
assert.deepEqual(refresh().parts.map(p => p.facetCounts), committedCounts);
// Nonpaint rack edit separates the two Paint runs; remap and its Undo synchronize selectors.
let rack = ok(call('orc_get_filament_session_snapshot'));
ok(command('orc_merge_filament_slots', { version: 1, revision: rack.revisions.session, source: 2, destination: 1 }));
refresh(); assert.ok(session.parts[0].facetCounts[1] > 0); assert.equal(session.parts[0].facetCounts[2], 0);
ok(call('orc_history_undo')); refresh(); assert.deepEqual(session.parts.map(p => p.facetCounts), committedCounts);
ok(call('orc_history_redo')); refresh(); assert.ok(session.parts[0].facetCounts[1] > 0);
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots.length, 1);
begin('triangle', { erase: true }); assert.equal(commit().committed, true, 'one-slot continuation');
const beforeClose = exportedPaint(); const entriesBefore = history().undoEntries.length;
const settled = ok(command('orc_painting_settle', { version: 1 }));
assert.deepEqual(command('orc_painting_settle', { version: 1 }), settled);
ok(command('orc_history_session_close', { sessionId: hs }));
assert.equal(exportedPaint(), beforeClose); assert.equal(history().undoEntries.length, entriesBefore - 2, 'three adjacent Paint children compact once around nonpaint entry');
assert.equal(history().editingSession, null);
assert.equal(ok(command('orc_painting_settle', { version: 1 })).settledVersion, settled.settledVersion, 'close metadata does not resettle unchanged dependencies');
const metadataSession = ok(command('orc_history_session_open', {})).sessionId;
assert.equal(ok(command('orc_painting_settle', { version: 1 })).settledVersion, settled.settledVersion, 'open metadata does not resettle');
ok(command('orc_history_session_close', { sessionId: metadataSession }));
// An actual painted reference cannot be merged to explicit final state17.
load(fixture()); open(); begin('triangle', { state: 2 }); commit();
for (let count = 2; count < 18; count++) {
  const rack = ok(call('orc_get_filament_session_snapshot'));
  ok(command('orc_add_filament_slot', { version: 1, revision: rack.revisions.session }));
}
refresh();
const remapBefore = observe(); const remapPaint = exportedPaint();
const rack18 = ok(call('orc_get_filament_session_snapshot'));
error(command('orc_merge_filament_slots', { version: 1, revision: rack18.revisions.session, source: 2, destination: 18 }));
assert.deepEqual(observe(), remapBefore); assert.equal(exportedPaint(), remapPaint);
// Same high destination is legal when no actual annotation uses the source.
const merged = ok(command('orc_merge_filament_slots', { version: 1, revision: rack18.revisions.session, source: 3, destination: 18 }));
refresh(); assert.ok(session.parts[0].facetCounts[2] > 0);
const outstandingLease = ok(command('orc_painting_geometry', handle())).leaseId;
ok(command('orc_history_session_close', { sessionId: hs }));
// Ownership is request-scoped, independent of a now-closed painting session.
for (const leaseId of [outstandingLease, outstandingLease, 'pg-18446744073709551615'])
  Module.ccall('orc_painting_geometry_release', null, ['string'], [JSON.stringify({ version: 1, leaseId })]);
// Gap preview draws the resulting state, including NONE, without touching the
// base draft or committed annotations. Its native membership survives cloning.
load(fixture(true)); open();
const gapBefore = exportedPaint();
const gapPreview = preview('gap', { gapArea: 3 });
const gapGeometry = geometry();
const gaps = gapGeometry.resources.filter(r => r.kind === 'gap');
assert.ok(gaps.length > 0);
assert.ok(gaps.every(r => r.groups.every(g => g[0] === 0)), 'lowest neighboring NONE is the displayed destination');
assert.equal(exportedPaint(), gapBefore);
begin('gap', { gapArea: 3 }, null, { candidateRevision: gapPreview.candidateRevision });
assert.equal(commit().committed, true);
assert.ok(refresh().parts.every(p => p.facetCounts.slice(1).every(n => n === 0)), 'Apply matches NONE preview');
ok(command('orc_history_session_close', { sessionId: hs }));
// Runtime slot identity is independent of duplicate preset names and colours.
load(fixture());
const slotSnapshot = () => ok(call('orc_get_filament_session_snapshot'));
const slotCommand = (name, fields = {}) => ok(command(name, { version: 1, revision: slotSnapshot().revisions.session, ...fields }));
slotCommand('orc_add_filament_slot');
let identical = slotSnapshot();
for (const slot of identical.slots.slice(1)) {
  slotCommand('orc_select_filament_slot_preset', { slot: slot.slot, preset: identical.slots[0].preset.name });
  slotCommand('orc_set_filament_slot_colour', { slot: slot.slot, colour: identical.slots[0].colour.effective });
}
identical = slotSnapshot();
const ids = identical.slots.map(slot => slot.logical_id);
assert.equal(new Set(ids).size, 3);
assert.ok(ids.every(id => /^filament-[1-9][0-9]*$/.test(id)));
assert.deepEqual(identical.slots.map(slot => slot.preset.name), Array(3).fill(identical.slots[0].preset.name));
slotCommand('orc_delete_filament_slot', { slot: 1 });
assert.deepEqual(slotSnapshot().slots.map(slot => slot.logical_id), ids.slice(1));
const deleteEntry = history().undoEntries[0].id;
ok(call('orc_history_undo'));
assert.deepEqual(slotSnapshot().slots.map(slot => slot.logical_id), ids);
ok(call('orc_history_redo'));
assert.deepEqual(slotSnapshot().slots.map(slot => slot.logical_id), ids.slice(1));
ok(call('orc_history_jump', ['string', 'string'], [deleteEntry, 'undo']));
assert.deepEqual(slotSnapshot().slots.map(slot => slot.logical_id), ids);
slotCommand('orc_merge_filament_slots', { source: 2, destination: 3 });
assert.deepEqual(slotSnapshot().slots.map(slot => slot.logical_id), [ids[0], ids[2]]);
ok(call('orc_history_undo'));
assert.deepEqual(slotSnapshot().slots.map(slot => slot.logical_id), ids);
ok(call('orc_history_redo'));
assert.deepEqual(slotSnapshot().slots.map(slot => slot.logical_id), [ids[0], ids[2]]);
const beforeRejectedIdentity = slotSnapshot();
error(command('orc_delete_filament_slot', { version: 1, revision: beforeRejectedIdentity.revisions.session, slot: 1, inject_failure: true }));
assert.deepEqual(slotSnapshot(), beforeRejectedIdentity, 'failed remap restores identities with the rack');
error(call('orc_history_reset', ['string'], ['{invalid']));
assert.deepEqual(slotSnapshot(), beforeRejectedIdentity, 'failed reset preserves identities');
error(call('orc_select_preset', ['string', 'string'], ['print', 'missing-stage09-process']));
assert.deepEqual(slotSnapshot(), beforeRejectedIdentity, 'failed profile selection preserves identities');
slotCommand('orc_add_filament_slot');
const abandonedId = slotSnapshot().slots.at(-1).logical_id;
ok(call('orc_history_undo'));
slotCommand('orc_add_filament_slot');
assert.notEqual(slotSnapshot().slots.at(-1).logical_id, abandonedId, 'branch allocation never reuses a removed identity');
const previousIds = new Set(slotSnapshot().slots.map(slot => slot.logical_id));
load(fixture());
assert.ok(slotSnapshot().slots.every(slot => !previousIds.has(slot.logical_id)), 'replacement owns fresh runtime identities');
// Effective Process selection remains a chronological separator after close.
const nextProcess = ok(call('orc_get_preset_snapshot')).print;
ok(command('orc_mutate_native_scoped_config', { version: 1, operation: 'set', targets: [{ scope: 'project' }], key: 'layer_height', value: '0.24' }));
command('orc_history_reset', context);
open(); begin('triangle', { state: 2 }); commit();
const firstPaint = exportedPaint();
const processBefore = ok(call('orc_get_preset_snapshot'));
assert.notEqual(nextProcess.name, processBefore.print.name, 'effective scoped edit materializes a distinct Process');
const processTransaction = ok(call('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['Select Process Preset', 'project', JSON.stringify(context), '']));
ok(call('orc_select_preset', ['string', 'string'], ['print', nextProcess.name]));
ok(call('orc_mark_shared_configuration_mutation'));
assert.equal(call('orc_history_commit', ['string', 'string'], [processTransaction.transactionId, JSON.stringify(context)]).status.undoLabel, 'Select Process Preset');
refresh(); begin('triangle', { state: 1 }); commit();
const secondPaint = exportedPaint();
ok(command('orc_history_session_close', { sessionId: hs }));
assert.deepEqual(history().undoEntries.slice(0, 3).map(entry => entry.label), ['Paint', 'Select Process Preset', 'Paint']);
ok(call('orc_history_undo')); assert.equal(exportedPaint(), firstPaint);
assert.equal(ok(call('orc_get_preset_snapshot')).print.name, nextProcess.name);
ok(call('orc_history_undo'));
assert.equal(ok(call('orc_get_preset_snapshot')).print.name, processBefore.print.name);
assert.equal(exportedPaint(), firstPaint);
ok(call('orc_history_redo')); ok(call('orc_history_redo'));
assert.equal(ok(call('orc_get_preset_snapshot')).print.name, nextProcess.name);
assert.equal(exportedPaint(), secondPaint);
console.log('Painting backend real-WASM publication/geometry/history/remap smoke passed');
