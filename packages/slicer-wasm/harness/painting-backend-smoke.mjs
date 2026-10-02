// Real-WASM command coverage using generated, repository-owned 3MF inputs.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { buildPaintedFacetProject, buildPaintingChannelProject } from './painted-facet-fixture-builder.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { callAsyncTask, getSliceResult } from './async-task-mailbox.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: painting-engine-smoke.mjs <orca_slice.js>');
const Module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, printErr: console.error });
const testHook = typeof Module._orc_painting_test_fail_next_commit === 'function';
assert.ok(!(process.argv.includes('--expect-test-hooks') && process.argv.includes('--expect-production')),
  'choose one expected build mode');
if (process.argv.includes('--expect-production'))
  assert.equal(testHook, false, 'a production artifact must not export the test failure hook');
else if (process.argv.includes('--expect-test-hooks') || !process.argv.includes('--interop-only'))
  assert.equal(testHook, true, 'the comprehensive test artifact must export the failure hook');
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
function fixture(gap = false, otherChannels = false) {
  return writeStoredZip(readZipEntries(source).map(entry => {
    if (entry.name !== '3D/3dmodel.model') return entry;
    let xml = new TextDecoder().decode(entry.content).replace(/ paint_color="[^"]*"/g, '');
    if (otherChannels) {
      // Facet strings are hex bitstreams. Nibble 4 is an unsplit triangle in
      // state 1; nibble 1 would claim child triangles without encoding them.
      xml = xml.replace(/<triangle\b([^>]*?)\/>/,
        '<triangle$1 paint_supports="4" paint_seam="4" paint_fuzzy_skin="4"/>');
    }
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
const handle = () => ({ version: 1, channel: session.channel, sessionId: session.id, revision: session.revision });
const read = () => ok(command('orc_painting_session_read', handle())).session;
function update(name, request) {
  const reply = ok(command(name, { ...handle(), ...request }));
  assert.equal(reply.channel, session.channel, 'channel identity survives every native receipt');
  session = { ...session, revision: reply.revision, strokeId: reply.strokeId, phase: reply.phase };
  return reply;
}
function open(channel = 'mmu') {
  hs = ok(command('orc_history_session_open', {})).sessionId;
  const object = structure()[0];
  session = ok(command('orc_painting_session_open', { version: 1, channel, historySessionId: hs, objectId: object.id, instanceId: object.instances[0].id })).session;
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
  const bytes = exportedBytes();
  return new TextDecoder().decode(readZipEntries(bytes).find(e => e.name === '3D/3dmodel.model').content);
}
function exportedBytes() {
  const result = ok(call('orc_export_project'));
  const bytes = Module.HEAPU8.slice(result.bytes_ptr, result.bytes_ptr + result.bytes_length); Module._free(result.bytes_ptr);
  return bytes;
}
ok(command('orc_init', { log_level: 'error' }));
if (!process.argv.includes('--interop-only')) {
// POINTER preview carries exactly the native original/subdivided leaf and its
// white MMU contour. Hover replaces selection resources, never annotations or
// history; drawing selects the current leaf again after applying its colour.
for (const subdivided of [false, true]) {
  load(fixture()); open();
  if (subdivided) { begin('circle', { state: 1, radius: 1 }, top(92.013, 105.027)); commit(); }
  const beforeHover = history(), annotations = exportedPaint();
  const initial = read(), draft = geometry();
  const originalKey = draft.parts[0].resourceId;
  if (subdivided) assert.ok(draft.resources[0].vertexCount > 36, 'fixture must actually contain subdivided leaves');
  const result = preview('triangle', { state: 2, angle: null, radius: 100 }, top(92.013, 105.027));
  const selected = read();
  assert.equal(selected.candidate.selectedFacetCount, 1);
  assert.deepEqual(selected.parts.map(p => p.facetCounts), initial.parts.map(p => p.facetCounts));
  assert.deepEqual(selected.candidate.parts.map(p => p.facetCounts), initial.parts.map(p => p.facetCounts));
  assert.deepEqual(history(), beforeHover); assert.equal(exportedPaint(), annotations);
  const candidate = geometry([originalKey]);
  assert.equal(candidate.parts[0].resourceId, originalKey);
  const leaf = candidate.resources.find(r => r.kind === 'triangle');
  assert.ok(leaf); assert.equal(leaf.vertexCount, 3);
  assert.ok(leaf.contourVertexCount >= 6 && leaf.contourVertexCount % 2 === 0);
  const draftVertices = draft.resources[0].vertices;
  assert.ok(Array.from({ length: draftVertices.length / 18 }, (_, i) => draftVertices.slice(i * 18, i * 18 + 18))
    .some(vertices => JSON.stringify(vertices) === JSON.stringify(leaf.vertices)), 'native selected geometry must be one current draft leaf');
  if (subdivided) {
    const [a, b, c] = [0, 6, 12].map(i => leaf.vertices.slice(i, i + 3));
    const ab = b.map((v, i) => v - a[i]), ac = c.map((v, i) => v - a[i]);
    const area = Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) / 2;
    assert.ok(area < 200, 'subdivided selection must be smaller than an original cube triangle');
  }
  assert.equal(geometry([originalKey, leaf.resourceId]).resources.length, 0);
  begin('triangle', { state: 2, angle: null, radius: 100 }, top(92.013, 105.027), { candidateRevision: result.candidateRevision });
  const drawing = geometry().resources.find(r => r.kind === 'triangle');
  assert.deepEqual(drawing.vertices, leaf.vertices); assert.deepEqual(drawing.groups, [[2, 0, 3]]);
  sample({ state: 2 }, top(108, 95));
  assert.notDeepEqual(geometry().resources.find(r => r.kind === 'triangle').vertices, leaf.vertices);
  sample({ state: 2 }, top(60, 60)); assert.deepEqual(geometry().candidates, []);
  cancel(); assert.equal(exportedPaint(), annotations); assert.deepEqual(history(), beforeHover);
  preview('triangle', { state: 2 }, top(60, 60)); assert.deepEqual(geometry().candidates, []);
  ok(command('orc_history_session_close', { sessionId: hs }));
}
console.log('Painting triangle original/subdivided leaf preview/history smoke passed');
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
assert.equal(clean.resources.filter(r => r.kind === 'draft').length, 1); assert.notEqual(clean.parts[0].resourceId, changed.parts[0].resourceId);
assert.equal(commit().committed, false);
// The failure probe is compiled into the test build only. Production artifacts
// run the same interoperability assertions without exposing that ABI.
if (testHook) {
  const stableHistory = history(); const stablePlates = call('orc_get_plate_session_snapshot');
  begin('sphere', { state: 1, radius: 50 });
  Module.ccall('orc_painting_test_fail_next_commit', null, [], []);
  const failure = error(command('orc_painting_stroke_commit', { ...handle(), strokeId: session.strokeId }));
  assert.equal(failure.recovered, true); session.revision = failure.revision; refresh();
  assert.equal(session.phase, 'idle'); assert.deepEqual(session.parts.map(p => p.facetCounts), committedCounts);
  assert.deepEqual(history(), stableHistory); assert.deepEqual(call('orc_get_plate_session_snapshot'), stablePlates);
  assert.equal(exportedPaint(), committedExport);
}
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
}

// Persist a newly committed two-material edit, reload it through the public
// 3MF bridge, and prove the slicer consumes both material assignments. Keep
// the other three facet annotation channels as an independent round-trip
// witness: painting must neither clear nor rewrite them.
async function sliceExtrusionTools() {
  const sliced = await callAsyncTask(call, 'orc_slice', ['string'], ['{}'], 240_000);
  ok(sliced);
  const result = ok(getSliceResult(call, sliced.receipt));
  const segmentCount = Number(result.toolpath?.segment_count ?? 0);
  assert.ok(segmentCount > 0, 'project produced no toolpath');
  const toolIds = Module.HEAPU8.slice(result.toolpath.extruder_id_ptr,
    result.toolpath.extruder_id_ptr + segmentCount);
  const moveTypes = Module.HEAPU8.slice(result.toolpath.move_type_ptr,
    result.toolpath.move_type_ptr + segmentCount);
  for (const [key, pointer] of Object.entries(result.toolpath))
    if (key.endsWith('_ptr') && pointer) Module._free(pointer);
  for (const metric of Object.values(result.toolpath.metrics ?? {}))
    if (metric.ptr) Module._free(metric.ptr);
  return { segmentCount, tools: [...new Set(toolIds.filter((_, index) => moveTypes[index] === 10))].sort() };
}
// Exercise the same Worker instance across consecutive project replacements
// before its first slice, including the imported annotation parser.
if (process.argv.includes('--interop-only')) {
  load(fixture());
  assert.equal(structure().length, 1);
}
load(fixture(false, true));
const independentAttrs = ['paint_supports', 'paint_seam', 'paint_fuzzy_skin'];
const channelValues = xml => Object.fromEntries(independentAttrs.map(attr =>
  [attr, [...xml.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map(match => match[1])]
));
const independentBefore = channelValues(exportedPaint());
for (const attr of independentAttrs) assert.deepEqual(independentBefore[attr], ['4'], `${attr} fixture did not import a valid unsplit state`);
const unpaintedSlice = await sliceExtrusionTools();
assert.deepEqual(unpaintedSlice.tools, [1], 'the unpainted fixture should extrude only inherited slot 2');
open();
const unpainted = refresh().parts.map(part => part.facetCounts);
begin('triangle', { state: 1 }, top(92, 105));
const paintedReceipt = commit({ settings: { state: 1 }, event: top(108, 95) });
assert.equal(paintedReceipt.committed, true);
const paintedCounts = refresh().parts.map(part => part.facetCounts);
assert.ok(paintedCounts[0][1] > 0 && paintedCounts[0][0] < unpainted[0][0]);
const saved = exportedBytes();
const savedXml = new TextDecoder().decode(readZipEntries(saved).find(entry => entry.name === '3D/3dmodel.model').content);
assert.deepEqual(channelValues(savedXml), independentBefore, 'painting changed independent facet annotation channels');
assert.match(savedXml, /paint_color=/);
ok(command('orc_history_session_close', { sessionId: hs }));
ok(call('orc_clear_model'));
load(saved);
assert.deepEqual(channelValues(exportedPaint()), independentBefore, 'reload changed independent facet annotation channels');
open();
assert.deepEqual(refresh().parts.map(part => part.facetCounts), paintedCounts, 'saved 3MF lost committed paint facets');
assert.equal(structure()[0].instances.length, 2, 'saved 3MF lost the shared second instance');
ok(command('orc_history_session_close', { sessionId: hs }));
const paintedSlice = await sliceExtrusionTools();
assert.deepEqual(paintedSlice.tools, [0, 1], 'actual extrusion did not consume both painted and inherited material');
// Step 13: edit the actual independent native fields, preserving all other
// annotations and ordinary MMU resources. This executes in production too;
// only fault injection requires the existing compile-gated test artifact.
const allAttrs = { mmu: 'paint_color', support: 'paint_supports', seam: 'paint_seam', fuzzy: 'paint_fuzzy_skin' };
const annotationBytes = xml => Object.fromEntries(Object.entries(allAttrs).map(([channel, attr]) => [channel,
  [...xml.matchAll(/<triangle\b[^>]*\/>/g)].map(match => match[0].match(new RegExp(`${attr}="([^"]*)"`))?.[1] ?? '')]));
function preservesOtherFields(before, active) {
  const after = annotationBytes(exportedPaint());
  for (const channel of Object.keys(allAttrs)) if (channel !== active) assert.deepEqual(after[channel], before[channel], `${active} changed ${channel} native tree bytes`);
}
for (const channel of ['support', 'seam', 'fuzzy']) {
  load(await buildPaintingChannelProject());
  const rack = ok(call('orc_get_filament_session_snapshot'));
  ok(command('orc_merge_filament_slots', { version: 1, revision: rack.revisions.session, source: 2, destination: 1 }));
  ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Channel second solid']));
  ok(call('orc_set_instance_offset', ['number','number','number','number','number'], [1,0,180,100,10]));
  ok(call('orc_merge_objects_to_multipart', ['string', 'string'], [JSON.stringify(structure().map(o => o.id)), 'Channel multipart']));
  ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Channel other target']));
  command('orc_history_reset', context);
  open(channel);
  assert.equal(session.channel, channel);
  assert.equal(ok(call('orc_get_filament_session_snapshot')).slots.length, 1);
  const baseline = annotationBytes(exportedPaint());
  const loaded = refresh();
  const loadedCounts = loaded.parts.map(p => p.facetCounts);
  const timestamps = loaded.parts.map(p => p.annotationTimestamp);
  assert.equal(loaded.parts.length, 2);
  assert.ok(loadedCounts[0].reduce((a,b) => a+b,0) > 12, `${channel} lost imported subdivision`);
  const ordinary = mesh();
  assert.ok(ordinary.renderables.every(r => Number.isSafeInteger(r.volume_id) && Object.hasOwn(r, 'paint_key')));
  const originalResources = ordinary.renderables.map(r => [r.volume_id, r.paint_key]);
  const firstGeometry = geometry();
  assert.equal(firstGeometry.channel, channel);
  assert.ok(firstGeometry.parts.every(p => p.resourceId.startsWith(`pd-${channel}-`)));
  const beforeInvalid = observe();
  const validMax = channel === 'fuzzy' ? 1 : 2;
  for (const settings of [{ state: validMax + 1 }, { state: validMax + 1, erase: true }, { state: -1 }])
    error(command('orc_painting_stroke_begin', { ...handle(), tool: 'circle', settings, event: top() }));
  for (const tool of ['region', 'height', ...(channel === 'support' ? [] : ['gap']), ...(channel === 'fuzzy' ? [] : ['triangle'])]) {
    error(command('orc_painting_stroke_begin', { ...handle(), tool, settings: {}, ...(tool === 'gap' ? {} : { event: top() }) }));
    error(command('orc_painting_preview', { ...handle(), tool, settings: {}, ...(tool === 'gap' ? {} : { event: top() }) }));
  }
  const { channel: omitted, ...missingHandle } = handle();
  for (const patch of [missingHandle, { ...handle(), channel: 'invalid' }, { ...handle(), channel: 'mmu' }]) {
    error(command('orc_painting_geometry', patch));
    error(command('orc_painting_stroke_begin', { ...patch, tool: 'circle', settings: {}, event: top() }));
  }
  assert.deepEqual(observe(), beforeInvalid);
  assert.deepEqual(refresh().parts.map(p => p.annotationTimestamp), timestamps);
  // Both brushes, live state/erase/radius changes and cancellation restore the
  // exact selector bytes/resource generation without touching Model/history.
  for (const tool of ['circle', 'sphere', ...(channel === 'fuzzy' ? ['triangle'] : [])]) {
    begin(tool, { state: 1, radius: .75 }, top(92.013, 105.027));
    sample({ state: validMax, radius: 2 }, top(97, 105));
    sample({ erase: true, radius: 1 }, top(102, 105));
    cancel();
    assert.deepEqual(refresh().parts.map(p => p.facetCounts), loadedCounts);
    assert.deepEqual(annotationBytes(exportedPaint()), baseline);
    assert.deepEqual(refresh().parts.map(p => p.annotationTimestamp), timestamps);
  }
  assert.deepEqual(observe(), beforeInvalid);
  begin('circle', { state: validMax, radius: 1 }, top(92.013, 105.027));
  const stale = { ...handle(), revision: session.revision - 1 };
  error(command('orc_painting_stroke_cancel', { ...stale, strokeId: session.strokeId }));
  if (testHook) {
    const beforeFailure = observe();
    Module.ccall('orc_painting_test_fail_next_commit', null, [], []);
    const failed = error(command('orc_painting_stroke_commit', { ...handle(), strokeId: session.strokeId, settings: { state: 1, radius: 2 }, event: top(108,95) }));
    assert.equal(failed.recovered, true); assert.equal(failed.channel, channel); assert.equal(failed.phase, 'idle');
    session.revision = failed.revision; session.strokeId = null; session.phase = 'idle';
    assert.deepEqual(observe(), beforeFailure, `${channel} failed publication changed model/history/plates`);
    assert.deepEqual(annotationBytes(exportedPaint()), baseline, `${channel} failed commit did not roll back annotation bytes`);
    assert.deepEqual(refresh().parts.map(p => p.annotationTimestamp), timestamps, `${channel} failed commit did not restore timestamps`);
    assert.deepEqual(refresh().parts.map(p => p.facetCounts), loadedCounts, `${channel} failed commit retained draft`);
    assert.deepEqual(mesh().renderables.map(r => [r.volume_id, r.paint_key]), originalResources);
    begin('circle', { state: validMax, radius: 1 }, top(92.013, 105.027));
  }
  const committed = commit({ settings: { state: validMax, radius: 2 }, event: top(108,95) });
  assert.equal(committed.committed, true);
  assert.equal(committed.history.undoEntries[0].label, channel === 'support' ? 'Paint Supports' : channel === 'seam' ? 'Paint Seam' : 'Paint Fuzzy Skin');
  preservesOtherFields(baseline, channel);
  const painted = refresh();
  assert.notEqual(painted.parts[0].annotationTimestamp, timestamps[0]);
  assert.equal(painted.parts[1].annotationTimestamp, timestamps[1]);
  assert.notEqual(painted.parts[0].draftResourceId, loaded.parts[0].draftResourceId);
  assert.equal(painted.parts[1].draftResourceId, loaded.parts[1].draftResourceId);
  assert.deepEqual(mesh().renderables.map(r => [r.volume_id, r.paint_key]), originalResources, `${channel} changed ordinary MMU resources`);
  const paintedBytes = annotationBytes(exportedPaint());
  const paintedCounts = painted.parts.map(p => p.facetCounts);
  const savedChannel = exportedBytes();
  ok(call('orc_history_undo')); refresh();
  assert.equal(session.channel, channel);
  assert.deepEqual(annotationBytes(exportedPaint()), baseline);
  assert.deepEqual(session.parts.map(p => p.facetCounts), loadedCounts);
  ok(call('orc_history_redo')); refresh();
  assert.deepEqual(annotationBytes(exportedPaint()), paintedBytes);
  assert.deepEqual(session.parts.map(p => p.facetCounts), paintedCounts);
  // Rebinding to another object preserves the discriminant and stale guard.
  const other = structure()[1];
  session = ok(command('orc_painting_session_target', { ...handle(), objectId: other.id, instanceId: other.instances[0].id })).session;
  assert.equal(session.channel, channel);
  const original = structure()[0];
  session = ok(command('orc_painting_session_target', { ...handle(), objectId: original.id, instanceId: original.instances[0].id })).session;
  assert.deepEqual(session.parts.map(p => p.facetCounts), paintedCounts);
  begin('eraseAll', {}, null); cancel(); assert.deepEqual(annotationBytes(exportedPaint()), paintedBytes);
  begin('eraseAll', {}, null); assert.equal(commit().committed, true);
  assert.ok(refresh().parts.every(p => p.facetCounts.slice(1).every(n => n === 0)));
  preservesOtherFields(baseline, channel);
  const beforeNoop = observe();
  const erasedTimestamps = session.parts.map(p => p.annotationTimestamp);
  begin('eraseAll', {}, null); assert.equal(commit().committed, false);
  assert.deepEqual(observe(), beforeNoop);
  assert.deepEqual(refresh().parts.map(p => p.annotationTimestamp), erasedTimestamps);
  ok(command('orc_history_session_close', { sessionId: hs, label: channel === 'support' ? 'Paint Supports' : channel === 'seam' ? 'Paint Seam' : 'Paint Fuzzy Skin' }));
  const closed = history();
  assert.ok(closed.undoEntries.some(e => e.label === (channel === 'support' ? 'Paint Supports' : channel === 'seam' ? 'Paint Seam' : 'Paint Fuzzy Skin')), `${channel} compacted history name`);
  load(savedChannel); open(channel);
  assert.deepEqual(annotationBytes(exportedPaint()), paintedBytes, `${channel} save/reload lost native tree`);
  assert.deepEqual(refresh().parts.map(p => p.facetCounts), paintedCounts);
  ok(command('orc_history_session_close', { sessionId: hs, label: channel === 'support' ? 'Paint Supports' : channel === 'seam' ? 'Paint Seam' : 'Paint Fuzzy Skin' }));
  console.log(`${channel} native field/tree/state/tool/timestamp/resource/cancel/erase/no-op/target/reconcile/3MF checks passed; injected rollback ${testHook ? 'passed' : 'compiled out'}`);
}
console.log(`Painting backend real-WASM ${process.argv.includes('--interop-only') ? 'unpainted/painted interoperability' : 'publication/geometry/history/remap/3MF/slice'} smoke passed (unpainted tool ${unpaintedSlice.tools}, painted tools ${paintedSlice.tools}; ${paintedSlice.segmentCount} segments)`);
