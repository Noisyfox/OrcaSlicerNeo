import { fixtureProfileOptions } from './profile-installer.mjs';
// Real native seam editing, native-format interoperability and seam placement.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { buildPaintingChannelProject, buildPaintedFacetProject } from './painted-facet-fixture-builder.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: seam-painting-smoke.mjs <orca_slice.js> [output-directory]');
const output = resolve(process.argv[3] ?? 'packages/slicer-wasm/.work/step15-seam');
await mkdir(output, { recursive: true });
const Module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
}
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
const command = (name, request) => call(name, ['string'], [JSON.stringify(request)]);
const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
let session, hs;
function load(bytes) {
  const pointer = Number(Module._malloc(bytes.length)); Module.HEAPU8.set(bytes, pointer);
  try { ok(call('orc_load_project', ['pointer','number','number','string'], [pointer, bytes.length, 0, 'seam-fixture.3mf'])); }
  finally { Module._free(pointer); }
  command('orc_history_reset', context);
}
function open() {
  hs = ok(command('orc_history_session_open', {})).sessionId;
  const object = ok(call('orc_get_model_structure')).objects[0];
  session = ok(command('orc_painting_session_open', { version: 1, channel: 'seam', historySessionId: hs, objectId: object.id, instanceId: object.instances[0].id })).session;
}
const handle = () => ({ version: 1, channel: 'seam', sessionId: session.id, revision: session.revision });
const refresh = () => session = ok(command('orc_painting_session_read', { ...handle(), latest: true })).session;
function stroke(name, request = {}) {
  const reply = ok(command(name, { ...handle(), ...request }));
  session = { ...session, revision: reply.revision, strokeId: reply.strokeId, phase: reply.phase };
  return reply;
}
const commit = request => stroke('orc_painting_stroke_commit', { strokeId: session.strokeId, ...request });
const cancel = () => stroke('orc_painting_stroke_cancel', { strokeId: session.strokeId });
function event(x, y, side = false) {
  const projection = [...identity]; projection[0] = .025; projection[5] = .025; projection[10] = -.005;
  const view = side ? [1,0,0,0, 0,0,-1,0, 0,1,0,0, -100,-10,0,1] : [...identity];
  if (!side) { view[12] = -100; view[13] = -100; view[14] = -100; }
  return { pointer: [(x - 60)*2.5, (side ? 50-y : 140-y)*2.5], viewport: [0,0,200,200], projection, view };
}
function paint(state, x = 98, y = 103, erase = false) {
  stroke('orc_painting_stroke_begin', { tool: 'circle', settings: { state, radius: 1, erase }, event: event(x,y) });
  assert.ok(session.strokeId); return commit();
}
function savedBytes() {
  const result = ok(call('orc_export_project'));
  try { return Module.HEAPU8.slice(result.bytes_ptr, result.bytes_ptr + result.bytes_length); } finally { Module._free(result.bytes_ptr); }
}
const modelXml = bytes => new TextDecoder().decode(readZipEntries(bytes).find(e => e.name === '3D/3dmodel.model').content);
const fields = bytes => [...modelXml(bytes).matchAll(/<triangle\b[^>]*\/>/g)].map(([triangle]) =>
  Object.fromEntries(['paint_color','paint_supports','paint_seam','paint_fuzzy_skin'].map(attr => [attr, triangle.match(new RegExp(`${attr}="([^"]*)"`))?.[1] ?? ''])));
const unrelated = bytes => fields(bytes).map(({ paint_seam, ...rest }) => rest);
function ordinary() {
  const result = ok(call('orc_get_model_mesh'));
  try { return result.renderables.map(r => [r.volume_id, r.paint_key]); }
  finally { for (const g of [...result.geometries,...result.paint_geometries]) { if (g.vertex_ptr) Module._free(g.vertex_ptr); if (g.index_ptr) Module._free(g.index_ptr); } }
}
ok(command('orc_init', JSON.parse(fixtureProfileOptions(Module))));
const imported = await buildPaintingChannelProject(); load(imported); open();
const before = savedBytes(), originalKeys = ordinary();
assert.ok(refresh().parts[0].facetCounts[1] > 0 && session.parts[0].facetCounts[2] > 0);
stroke('orc_painting_stroke_begin', { tool: 'eraseAll', settings: {} }); commit();
assert.equal(refresh().parts[0].facetCounts.slice(1).reduce((a,b)=>a+b,0), 0);
paint(1, 94, 104); paint(2, 106, 96);
const painted = refresh().parts.map(p => p.facetCounts);
assert.ok(painted[0][0] > 0 && painted[0][1] > 0 && painted[0][2] > 0);
assert.deepEqual(unrelated(savedBytes()), unrelated(before), 'other three native trees survive seam edits');
assert.deepEqual(ordinary(), originalKeys, 'ordinary MMU material resources survive seam edits');
const savedPaint = savedBytes();
stroke('orc_painting_stroke_begin', { tool: 'sphere', settings: { state: 2, radius: 5 }, event: event(94,104) }); cancel();
assert.deepEqual(fields(savedBytes()), fields(savedPaint), 'cancel discards subdivision/state edits');
paint(1, 94,104,true); const erased = refresh().parts.map(p => p.facetCounts); assert.notDeepEqual(erased,painted);
ok(call('orc_history_undo')); assert.deepEqual(refresh().parts.map(p=>p.facetCounts),painted);
ok(call('orc_history_redo')); assert.deepEqual(refresh().parts.map(p=>p.facetCounts),erased);
ok(call('orc_history_undo')); refresh();
ok(command('orc_history_session_close', { sessionId: hs }));
const roundtrip = savedBytes(); await writeFile(resolve(output,'independent-seam-saved.3mf'),roundtrip);
load(roundtrip); open(); assert.deepEqual(session.parts.map(p=>p.facetCounts),painted);
assert.deepEqual(fields(savedBytes()),fields(roundtrip),'exact native four-channel subdivision and state streams reopen');
assert.deepEqual(unrelated(savedBytes()),unrelated(before));
ok(command('orc_history_session_close', { sessionId: hs }));
console.log('seam native0/1/2, split-tree save/reopen, independent fields, erase/cancel/Undo/Redo PASS');

// A small single-material, single-instance cube provides a real G-code witness:
// enforce a narrow strip on the front face, then block that same strip.
const source = await buildPaintedFacetProject();
const sliceFixture = writeStoredZip(readZipEntries(source).map(entry => {
  if (entry.name === '3D/3dmodel.model') return { ...entry, content: new TextEncoder().encode(modelXml(source).replace(/ paint_color="[^"]*"/g,'').replace(/<item objectid="1" transform="1 0 0 0 1 0 0 0 1 130 100 10"[^>]*\/>/,'')) };
  if (entry.name === 'Metadata/project_settings.config') {
    const config = JSON.parse(new TextDecoder().decode(entry.content));
    Object.assign(config,{ enable_prime_tower:'0', enable_support:'0', seam_position:'aligned', layer_height:'0.3', initial_layer_print_height:'0.2', wall_loops:'1', top_shell_layers:'0', bottom_shell_layers:'0', sparse_infill_density:'0%', seam_slope_type:'none' });
    return { ...entry, content: new TextEncoder().encode(JSON.stringify(config)) };
  }
  return entry;
}));
load(sliceFixture);
let rack = ok(call('orc_get_filament_session_snapshot'));
ok(command('orc_merge_filament_slots',{version:1,revision:rack.revisions.session,source:2,destination:1}));
command('orc_history_reset',context); open();
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots.length,1,'single-filament seam entry');
function outerStarts(gcode) {
  let x=0,y=0,z=0,feature='',pending=false;
  const starts=[];
  for (const line of gcode.split('\n')) {
    if (line.startsWith(';TYPE:')) { feature=line.slice(6).trim(); pending=feature==='Outer wall'; }
    if (line === ';LAYER_CHANGE') pending = feature === 'Outer wall';
    if (!/^G[0123] /.test(line)) continue;
    const values=Object.fromEntries([...line.matchAll(/\b([XYZEF])(-?(?:\d+(?:\.\d*)?|\.\d+))/g)].map(([,key,n])=>[key,Number(n)]));
    if (pending && values.E > 0 && (values.X!==undefined || values.Y!==undefined)) { starts.push({x,y,z}); pending=false; }
    x=values.X??x; y=values.Y??y; z=values.Z??z;
  }
  return starts.filter(p=>p.z>2 && p.z<18);
}
async function slice(label) {
  const plates=ok(call('orc_get_plate_session_snapshot')), id=plates.current_plate_id;
  const result=ok(await callAsyncTask(call,'orc_slice_plate',['string','string','number'],['{}',id,plates.input_revisions[id]]));
  const exported=ok(exportGcode(call, { receipt: result.receipt, filenameBase: '' }));
  const gcode=Module.FS.readFile(exported.path,{encoding:'utf8'}); if(exported.bytes_ptr)Module._free(exported.bytes_ptr);
  await writeFile(resolve(output,`${label}.gcode`),gcode);
  const starts=outerStarts(gcode); assert.ok(starts.length>=10,`real outer-wall loop starts: ${label}`);
  return starts;
}
const baseline=await slice('baseline');
function strip(state) {
  const settings={state,radius:2,vertical:true};
  const first=event(100,1,true), last=event(100,19,true);
  stroke('orc_painting_stroke_begin',{tool:'sphere',settings,event:first});
  assert.ok(session.strokeId);
  const endpoint=commit({settings,event:last}); assert.equal(endpoint.committed,true);
}
strip(1); const enforced=await slice('enforced');
const front = starts => starts.filter(p=>Math.abs(p.y-90)<.6 && Math.abs(p.x-100)<2.5).length;
assert.equal(front(baseline),0,'unpainted seam does not choose front-face strip');
assert.ok(front(enforced)>=10,'native seam placement chooses enforced strip');
strip(2); const blocked=await slice('blocked'); assert.equal(front(blocked),0,'block suppresses former enforced strip');
ok(call('orc_history_undo')); refresh(); const undo=await slice('undo-enforced'); assert.deepEqual(undo,enforced);
ok(call('orc_history_redo')); refresh(); const redo=await slice('redo-blocked'); assert.deepEqual(redo,blocked);
ok(call('orc_history_undo')); refresh();
stroke('orc_painting_stroke_begin',{tool:'eraseAll',settings:{}}); commit();
const erasedPlacement=await slice('erased-baseline'); assert.deepEqual(erasedPlacement,baseline,'erase restores actual native baseline seam placement');
ok(call('orc_history_undo')); refresh(); const undoErase=await slice('undo-erase-enforced'); assert.deepEqual(undoErase,enforced);
ok(command('orc_history_session_close',{sessionId:hs}));
const downstream=savedBytes(); await writeFile(resolve(output,'seam-placement-saved.3mf'),downstream);
load(downstream); open(); const reopened=await slice('reopened-enforced'); assert.deepEqual(reopened,enforced,'save/reopen retains actual seam-placement effect');
ok(command('orc_history_session_close',{sessionId:hs}));
const evidence={fixtureSha256:createHash('sha256').update(sliceFixture).digest('hex'),savedSha256:createHash('sha256').update(downstream).digest('hex'),baseline,enforced,blocked,undo,redo,erasedPlacement,undoErase,reopened};
await writeFile(resolve(output,'seam-placement-evidence.json'),JSON.stringify(evidence,null,2));
console.log('seam single-filament native seam placement, block, Undo/Redo and save/reopen downstream PASS', JSON.stringify({baseline:front(baseline),enforced:front(enforced),blocked:front(blocked)}));
