// Hidden four-channel foundation: real history, native summaries and fresh slices.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { buildPaintedFacetProject } from './painted-facet-fixture-builder.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { callAsyncTask, getSliceResult, exportGcode } from './async-task-mailbox.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: painting-history-plate-smoke.mjs <gated orca_slice.js>');
const Module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, print: () => {}, printErr: () => {} });
assert.equal(typeof Module._orc_history_test_fail_next_restore, 'function', 'history-test build required');
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const command = (name, value) => call(name, ['string'], [JSON.stringify(value)]);
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const plates = () => ok(call('orc_get_plate_session_snapshot'));
const structure = () => ok(call('orc_get_model_structure')).objects;
function preview(receipt) {
  const result = getSliceResult(call, receipt);
  for (const [key, ptr] of Object.entries(result.toolpath ?? {})) if (key.endsWith('_ptr') && ptr) Module._free(ptr);
  for (const metric of Object.values(result.toolpath?.metrics ?? {})) if (metric.ptr) Module._free(metric.ptr);
  return result;
}
function gcode(receipt) {
  const result = exportGcode(call, receipt);
  if (result.bytes_ptr) Module._free(result.bytes_ptr);
  return result;
}
const cache = () => ok(call('orc_painting_test_cache_snapshot'));
const tower = () => ok(call('orc_get_prime_tower_projection'));
const settle = () => ok(command('orc_painting_settle', { version: 1 }));
function releaseGeometry(value) {
  for (const geometry of [...value.geometries, ...value.paint_geometries]) {
    if (geometry.vertex_ptr) Module._free(geometry.vertex_ptr);
    if (geometry.index_ptr) Module._free(geometry.index_ptr);
  }
  return value;
}
const mesh = () => releaseGeometry(ok(call('orc_get_model_mesh')));
const ordinaryKeys = () => mesh().renderables.map(r => [r.object_id, r.volume_id, r.instance_id, r.paint_key]);
const source = await buildPaintedFacetProject();
// Keep all four annotations initially empty, two shared instances, two slots,
// and explicit support routing. No fixture bytes are hand-authored history.
const fixture = writeStoredZip(readZipEntries(source).map(entry => {
  if (entry.name === '3D/3dmodel.model') return { ...entry, content: new TextEncoder().encode(
    new TextDecoder().decode(entry.content).replace(/ paint_color="[^"]*"/g, '')) };
  if (entry.name === 'Metadata/project_settings.config') {
    const config = JSON.parse(new TextDecoder().decode(entry.content));
    Object.assign(config, { enable_support: '1', support_filament: '1', support_interface_filament: '1',
      enable_prime_tower: '1', layer_height: '0.2', sparse_infill_density: '5%' });
    return { ...entry, content: new TextEncoder().encode(JSON.stringify(config)) };
  }
  return entry;
}));
console.log('fixture sha256', createHash('sha256').update(fixture).digest('hex'));
function load() {
  const ptr = Number(Module._malloc(fixture.length)); Module.HEAPU8.set(fixture, ptr);
  try { ok(call('orc_load_project', ['pointer','number','number','string'], [ptr, fixture.length, 0, 'four-channel-history.3mf'])); }
  finally { Module._free(ptr); }
}
let session, hs;
const handle = () => ({ version: 1, channel: session.channel, sessionId: session.id, revision: session.revision });
function refresh() { session = ok(command('orc_painting_session_read', { ...handle(), latest: true })).session; return session; }
function stroke(name, value = {}) {
  const reply = command(name, { ...handle(), ...value });
  if (reply.recovered) { session.revision = reply.revision; session.phase = reply.phase; session.strokeId = null; }
  else { ok(reply); session = { ...session, revision: reply.revision, phase: reply.phase, strokeId: reply.strokeId }; }
  return reply;
}
function begin(channel) {
  const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const projection = [...identity]; projection[0] = .025; projection[5] = .025; projection[10] = -.005;
  const view = [...identity]; view[12] = -100; view[13] = -100; view[14] = -100;
  stroke('orc_painting_stroke_begin', { tool: 'circle', settings: { state: 1, radius: 2 },
    event: { pointer: [95,92.5], viewport: [0,0,200,200], projection, view } });
  assert.equal(session.phase, 'drawing', channel);
}
const commit = () => stroke('orc_painting_stroke_commit', { strokeId: session.strokeId });
function assertStale(receipt) {
  const result = preview(receipt);
  assert.equal(result.ok, false); assert.ok(['stale','unavailable'].includes(result.status), JSON.stringify(result));
  assert.equal(gcode(receipt).ok, false);
}
async function slice(id, previous) {
  ok(call('orc_select_plate', ['string'], [id]));
  const stamp = plates().input_revisions[id];
  const result = ok(await callAsyncTask(call, 'orc_slice_plate', ['string','string','number'], ['{}', id, stamp]));
  assert.equal(result.receipt.input_stamp, stamp);
  if (previous) assert.notEqual(result.receipt.result_generation, previous.result_generation);
  const freshPreview = ok(preview(result.receipt));
  assert.ok(freshPreview.toolpath?.segment_count > 0, 'fresh native toolpath');
  ok(gcode(result.receipt));
  return result.receipt;
}
function assertInvalidation(before, ids, unaffected, receipts) {
  const after = plates().input_revisions;
  for (const id of ids) { assert.ok(after[id] > before[id], 'fresh affected input stamp'); assertStale(receipts[id]); }
  assert.equal(after[unaffected], before[unaffected]);
  ok(call('orc_select_plate', ['string'], [unaffected]));
  ok(preview(receipts[unaffected]));
}
function assertCachePath(before, after, affected, unaffected, material) {
  for (const id of affected) {
    const old = before.lookups[id], next = after.lookups[id];
    assert.equal(next.full - old.full, material ? 1 : 0, `${id} full scan policy`);
    assert.equal(next.hit - old.hit, material ? 0 : 1, `${id} summary hit policy`);
  }
  assert.deepEqual(after.lookups[unaffected], before.lookups[unaffected], 'unaffected tower projection reuse');
}
function observe() {
  return { history: call('orc_history_status'), plates: plates(), model: structure(), resources: ordinaryKeys(),
    cache: cache(), session: refresh() };
}
for (const channel of ['support','seam','fuzzy','mmu']) {
  load();
  const second = ok(call('orc_add_plate')); const origin = second.plates[1].origin;
  const third = ok(call('orc_add_plate'));
  ok(call('orc_set_instance_offset', ['number','number','number','number','number'], [0,1,origin[0]+100,origin[1]+100,10]));
  ok(call('orc_recompute_plate_membership'));
  const ids = plates().plates.map(p => p.plate_id), affected = ids.slice(0,2), unaffected = ids[2];
  ok(call('orc_select_plate', ['string'], [unaffected]));
  ok(call('orc_add_shape', ['string','string'], ['Cube','Unrelated slice witness']));
  ok(call('orc_recompute_plate_membership'));
  const initialTower = tower();
  for (const id of affected) assert.deepEqual(initialTower.plates.find(p => p.plate_id === id).used_slots, [1,2], 'native object/support routing use');
  for (const plate of initialTower.plates.filter(p => p.eligible)) ok(command('orc_move_prime_tower', { version: 1, plate_id: plate.plate_id,
    revision: plates().input_revisions[plate.plate_id], x: 200, y: 200 }));
  command('orc_history_reset', context);
  const object = structure()[0];
  hs = ok(command('orc_history_session_open', {})).sessionId;
  session = ok(command('orc_painting_session_open', { version: 1, channel, historySessionId: hs,
    objectId: object.id, instanceId: object.instances[0].id })).session;
  const initialCounts = session.parts.map(p => p.facetCounts);
  let receipts = {};
  for (const id of ids) receipts[id] = await slice(id);
  ok(call('orc_select_plate', ['string'], [affected[0]]));
  tower(); settle();
  const originalKeys = ordinaryKeys();
  const initial = observe();
  begin(channel);
  Module.ccall('orc_painting_test_fail_next_commit', null, [], []);
  const failure = commit(); assert.equal(failure.recovered, true);
  // The failed stroke discards its draft; model/history/result/cache authority
  // remains unchanged. Session revision legitimately advances for stale guards.
  const failed = observe();
  for (const field of ['history','plates','model','resources','cache']) assert.deepEqual(failed[field], initial[field], `${channel} commit rollback ${field}`);
  assert.deepEqual(failed.session.parts.map(p => p.facetCounts), initialCounts);
  for (const id of ids) { ok(call('orc_select_plate', ['string'], [id])); ok(preview(receipts[id])); }
  ok(call('orc_select_plate', ['string'], [affected[0]]));
  begin(channel);
  const beforeCommit = plates().input_revisions, warm = cache();
  const committed = commit(); assert.equal(committed.committed, true);
  assert.deepEqual([...committed.affectedPlateIds].sort(), [...affected].sort());
  assertInvalidation(beforeCommit, affected, unaffected, receipts);
  const cold = cache();
  assert.equal(cold.derivedVersion, warm.derivedVersion + (['mmu','support'].includes(channel) ? 1 : 0));
  assert.equal(cold.settledVersion, warm.settledVersion, 'effective commit defers derived settlement');
  for (const id of affected) {
    assert.equal(Object.hasOwn(cold.projections,id), false);
    assert.equal(Object.hasOwn(cold.summaries,id), !['mmu','support'].includes(channel));
  }
  assert.deepEqual(cold.projections[unaffected], warm.projections[unaffected]);
  tower(); assertCachePath(warm, cache(), affected, unaffected, ['mmu','support'].includes(channel));
  const committedSettlement = settle();
  assert.equal(committedSettlement.projections.materials.revisions.session, committed.history.revision);
  assert.deepEqual(committedSettlement.projections.materials.revisions.plates, plates().input_revisions);
  const paintedCounts = refresh().parts.map(p => p.facetCounts);
  assert.notDeepEqual(paintedCounts, initialCounts);
  if (channel !== 'mmu') assert.deepEqual(ordinaryKeys(), originalKeys);
  for (const id of affected) receipts[id] = await slice(id, receipts[id]);
  for (const direction of ['undo','redo']) {
    ok(call('orc_select_plate', ['string'], [affected[0]])); tower(); settle();
    for (const stage of [1,2]) {
      const beforeFailure = observe();
      Module.ccall('orc_history_test_fail_next_restore', null, ['number'], [stage]);
      const failedRestore = call(`orc_history_${direction}`);
      assert.equal(failedRestore.ok, false); assert.equal(failedRestore.error.code, 'restore-failed');
      assert.match(failedRestore.error.message, /injected history (reconciliation|publication) failure/);
      assert.deepEqual(observe(), beforeFailure, `${channel} ${direction} stage ${stage} rollback`);
      for (const id of ids) { ok(call('orc_select_plate', ['string'], [id])); ok(preview(receipts[id])); }
      ok(call('orc_select_plate', ['string'], [affected[0]]));
    }
    const before = plates().input_revisions, beforeCache = cache();
    const restored = ok(call(`orc_history_${direction}`));
    assert.deepEqual([...restored.affected_plate_ids].sort(), [...affected].sort());
    if (channel !== 'mmu') {
      assert.deepEqual(restored.scene_delta.retained_renderer_object_ids, [object.id]);
      assert.equal(restored.impact.filamentRack, channel === 'support', 'support-use projection refresh is independent of scene retention');
      assert.deepEqual(ordinaryKeys(), originalKeys);
      // Execute the ordinary scene-delta projection with known resources; the
      // retained object needs no patch or native buffer export.
      const toRead = restored.scene_delta.object_ids.filter(id => !restored.scene_delta.retained_renderer_object_ids.includes(id));
      const patch = releaseGeometry(ok(command('orc_get_model_scene_patch', { object_ids: toRead,
        known_volume_ids: mesh().renderables.map(r => r.volume_id), known_paint_keys: mesh().renderables.map(r => r.paint_key).filter(Boolean) })));
      assert.equal(patch.renderables.length, 0); assert.equal(patch.geometries.length,0); assert.equal(patch.paint_geometries.length,0);
    } else assert.deepEqual(restored.scene_delta.retained_renderer_object_ids, []);
    const restoredCache = cache();
    assert.equal(restoredCache.derivedVersion, beforeCache.derivedVersion + (['mmu','support'].includes(channel) ? 1 : 0));
    assert.equal(restoredCache.settledVersion, beforeCache.settledVersion, 'restore defers settlement');
    assertInvalidation(before, affected, unaffected, receipts);
    tower(); assertCachePath(beforeCache, cache(), affected, unaffected, ['mmu','support'].includes(channel));
    const restoredSettlement = settle();
    assert.equal(restoredSettlement.projections.materials.revisions.session, restored.status.revision);
    assert.deepEqual(restoredSettlement.projections.materials.revisions.plates, plates().input_revisions);
    assert.deepEqual(refresh().parts.map(p => p.facetCounts), direction === 'undo' ? initialCounts : paintedCounts);
    for (const id of affected) receipts[id] = await slice(id, receipts[id]);
  }
  // Jump across painting plus an instance move. The source contains the
  // shared instance on C, the target on B: both memberships must invalidate.
  const shared = mesh().renderables.find(r => r.object_idx === 0 && r.instance_idx === 1);
  assert.ok(shared);
  const destination = plates().plates[2].origin;
  const movedTransform = { ...shared.instance_transform, offset: [destination[0] + 130, destination[1] + 100, 10] };
  delete movedTransform.matrix;
  const tx = ok(call('orc_history_begin', ['string','string','string','string'],
    ['Move shared instance', 'project', JSON.stringify(context), '']));
  ok(call('orc_set_model_transforms', ['string','string'], [tx.transactionId, JSON.stringify([{
    objectIdx: shared.object_idx, volumeIdx: shared.volume_idx, instanceIdx: shared.instance_idx,
    instanceTransform: movedTransform, volumeTransform: shared.volume_transform,
  }])]));
  const moveCommit = call('orc_history_commit', ['string','string'], [tx.transactionId, JSON.stringify(context)]);
  assert.equal(moveCommit.status.canUndo, true);
  const beforeJump = plates().input_revisions;
  const jumped = ok(call('orc_history_jump', ['string','string'], [committed.history.undoEntries[0].id, 'undo']));
  assert.deepEqual([...jumped.affected_plate_ids].sort(), [...ids].sort(), 'before/after shared-instance membership union');
  for (const id of ids) {
    assert.ok(plates().input_revisions[id] > beforeJump[id]);
    assertStale(receipts[id]);
    receipts[id] = await slice(id, receipts[id]);
  }
  assert.deepEqual(refresh().parts.map(p => p.facetCounts), initialCounts);
  ok(command('orc_history_session_close', { sessionId: hs }));
  console.log(`${channel}: commit/Undo/Redo fresh slices, two shared-instance plates, unaffected reuse, summary dependency, retained scene, before/after membership jump and five fault rollbacks passed`);
}
console.log('four-channel painting history/plate PASS');
