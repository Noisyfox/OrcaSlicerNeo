import { fixtureProfileOptions } from './profile-installer.mjs';
// Real-WASM command coverage using generated, repository-owned 3MF inputs.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { buildPaintedFacetProject, buildPaintingChannelProject } from './painted-facet-fixture-builder.mjs';
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
const handle = () => ({ version: 1, channel: session.channel, sessionId: session.id, revision: session.revision });
const read = () => ok(command('orc_painting_session_read', handle())).session;
function update(name, request) {
  const reply = ok(command(name, { ...handle(), ...request }));
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
ok(command('orc_init', JSON.parse(fixtureProfileOptions(Module))));
load(fixture()); open();
const committed = observe();
const initial = read().parts.map(p => p.facetCounts);
assert.deepEqual(initial[0], [12, ...Array(16).fill(0)]);
for (const tool of ['circle', 'sphere', 'triangle', 'height', 'region']) {
  const receipt = begin(tool, { state: 16, radius: 50, height: 2 });
  assert.equal(receipt.phase, 'drawing'); assert.equal(receipt.effective, true, tool);
  assert.equal(receipt.hit.volumeId, session.parts[0].volumeId);
  assert.ok(receipt.hit.originalFacet >= 0 && receipt.hit.originalFacet < 12);
  assert.ok(Math.abs(receipt.hit.world[2] - 20) < 1e-4);
  assert.ok(read().parts[0].facetCounts[16] > 0);
  if (tool === 'circle') assert.ok(read().parts[0].facetCounts[0] > 0);
  if (tool === 'sphere') assert.equal(read().parts[0].facetCounts[16], 12);
  if (tool === 'triangle') assert.equal(read().parts[0].facetCounts[16], 1);
  if (tool === 'region') assert.equal(read().parts[0].facetCounts[16], 2);
  const active = read();
  error(command('orc_history_session_close', { sessionId: hs }));
  assert.deepEqual(read(), active); assert.deepEqual(observe(), committed);
  finish();
  error(command('orc_history_session_close', { sessionId: hs }));
  error(command('orc_painting_session_close', handle()));
  error(command('orc_painting_stroke_sample', { ...handle(), strokeId: session.strokeId, settings: {}, event: top() }));
  assert.deepEqual(observe(), committed);
  cancel(); assert.deepEqual(read().parts.map(p => p.facetCounts), initial);
}
// Live per-event settings, sparse native interpolation and full cancellation.
begin('circle', { state: 1, radius: 2 }, top(92,100));
sample({ state: 2, radius: 1 }, top(108,100));
assert.ok(read().parts[0].facetCounts[1] > 0 && read().parts[0].facetCounts[2] > 0);
sample({ erase: true, radius: 1 }, top(108,100));
const active = read();
for (const patch of [{ revision: session.revision - 1 }, { strokeId: session.strokeId + '\0bad' },
  { settings: { radius: 0 } }, { settings: { state: 17 } }, { settings: { angle: 91 } },
  { event: { ...top(), projection: Array(16).fill(0) } }, { event: { ...top(), faceIndex: 1 } },
  { tool: 'sphere' }]) {
  error(command('orc_painting_stroke_sample', { ...handle(), strokeId: session.strokeId, settings: {}, event: top(), ...patch }));
  assert.deepEqual(read(), active);
}
cancel();
begin('triangle', { state: 0 }); assert.equal(finish().effective, false); cancel();
begin('eraseAll', {}, null); assert.equal(session.phase, 'finished'); assert.deepEqual(read().parts.map(p => p.facetCounts), initial); cancel();

preview('region', { state: 2 }, top());
const region = read(); assert.equal(region.candidate.parts[0].facetCounts[2], 2); assert.deepEqual(region.parts.map(p => p.facetCounts), initial);
error(command('orc_painting_stroke_begin', { ...handle(), tool: 'region', settings: { state: 2 }, event: top(), candidateRevision: session.revision - 1 }));
begin('region', { state: 2 }, top(), { candidateRevision: session.revision });
assert.deepEqual(read().parts[0].facetCounts, region.candidate.parts[0].facetCounts); cancel();
preview('region', { state: 2, angle: null }, top()); assert.equal(read().candidate.parts[0].facetCounts[2], 12);
preview('region', { state: 2 }, top(60,60)); assert.deepEqual(read().candidate.parts[0].facetCounts, initial[0]);
preview('region', { state: 0 }, top()); assert.equal(read().candidate.selectedFacetCount, 2);
assert.deepEqual(read().candidate.parts[0].facetCounts, initial[0]);
begin('triangle'); sample({}, { ...top(), pointer: [1e300, 0] }); assert.equal(session.phase, 'drawing'); cancel();
assert.deepEqual(observe(), committed);
ok(command('orc_painting_session_close', handle())); ok(command('orc_history_session_close', { sessionId: hs }));

load(fixture(true)); open();
const gap_initial = read().parts[0].facetCounts;
assert.equal(gap_initial[1], 1);
const gap_committed = observe();
preview('gap', { gapArea: 2 }); assert.equal(read().candidate.parts[0].facetCounts[1], 1);
preview('gap', { gapArea: 2.01 });
const gap_candidate = read().candidate.parts[0].facetCounts; assert.equal(gap_candidate[1], 0);
assert.equal(read().candidate.gapRegionCount, 1);
assert.deepEqual(read().parts[0].facetCounts, gap_initial);
error(command('orc_painting_stroke_begin', { ...handle(), tool: 'gap', settings: { gapArea: 3 }, candidateRevision: session.revision }));
begin('gap', { gapArea: 2.01 }, null, { candidateRevision: session.revision });
assert.equal(session.phase, 'finished'); assert.deepEqual(read().parts[0].facetCounts, gap_candidate);
assert.deepEqual(observe(), gap_committed); cancel(); assert.deepEqual(read().parts[0].facetCounts, gap_initial);
begin('eraseAll', {}, null); assert.equal(read().parts[0].facetCounts[1], 0); cancel();
ok(command('orc_painting_session_close', handle())); ok(command('orc_history_session_close', { sessionId: hs }));
for (const channel of ['support', 'seam', 'fuzzy']) {
  load(await buildPaintingChannelProject());
  const rack = ok(call('orc_get_filament_session_snapshot'));
  ok(command('orc_merge_filament_slots', { version: 1, revision: rack.revisions.session, source: 2, destination: 1 }));
  open(channel);
  const imported = read(), observed = observe();
  for (const tool of ['circle', 'sphere', ...(channel === 'fuzzy' ? ['triangle'] : [])]) {
    const begun = begin(tool, { state: channel === 'fuzzy' ? 1 : 2, radius: 1 }, top(92.013,105.027));
    assert.equal(begun.channel, channel); assert.ok(begun.hit, `${channel} ${tool} native hit`);
    const painted = sample({ state: channel === 'fuzzy' ? 1 : 2, radius: 2 }, top(108,95));
    assert.equal(painted.effective, true, `${channel} ${tool} native draft effect`);
    sample({ state: 1, radius: 2 }, top(97,105));
    sample({ erase: true, radius: .75 }, top(102,105));
    cancel();
    assert.deepEqual(read().parts.map(p => p.facetCounts), imported.parts.map(p => p.facetCounts));
    assert.deepEqual(read().parts.map(p => p.annotationTimestamp), imported.parts.map(p => p.annotationTimestamp));
  }
  assert.deepEqual(observe(), observed);
  ok(command('orc_painting_session_close', handle())); ok(command('orc_history_session_close', { sessionId: hs }));
}
console.log('Painting six-tool real-WASM engine smoke passed');
