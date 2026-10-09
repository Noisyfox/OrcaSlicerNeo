import { fixtureProfileOptions } from './profile-installer.mjs';
// Real native support editing, native-format interoperability and support placement.
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
if (!modulePath) throw new Error('usage: support-painting-smoke.mjs <orca_slice.js> [output-directory]');
const output = resolve(process.argv[3] ?? 'packages/slicer-wasm/.work/step18-native');
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
  try { ok(call('orc_load_project', ['pointer','number','number','string'], [pointer, bytes.length, 0, 'support-fixture.3mf'])); }
  finally { Module._free(pointer); }
  command('orc_history_reset', context);
}
function open() {
  hs = ok(command('orc_history_session_open', {})).sessionId;
  const object = ok(call('orc_get_model_structure')).objects[0];
  session = ok(command('orc_painting_session_open', { version: 1, channel: 'support', historySessionId: hs, objectId: object.id, instanceId: object.instances[0].id })).session;
}
const handle = () => ({ version: 1, channel: 'support', sessionId: session.id, revision: session.revision });
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
const unrelated = bytes => fields(bytes).map(({ paint_supports, ...rest }) => rest);
function ordinary() {
  const result = ok(call('orc_get_model_mesh'));
  try { return result.renderables.map(r => [r.volume_id, r.paint_key]); }
  finally { for (const g of [...result.geometries,...result.paint_geometries]) { if (g.vertex_ptr) Module._free(g.vertex_ptr); if (g.index_ptr) Module._free(g.index_ptr); } }
}
ok(command('orc_init', JSON.parse(fixtureProfileOptions(Module))));
const imported = await buildPaintingChannelProject(); load(imported); open();
const before = savedBytes(), originalKeys = ordinary();
for(const attr of ['paint_color','paint_seam','paint_fuzzy_skin'])assert.ok(fields(before).some(f=>f[attr]),`nonempty independent ${attr} witness`);
assert.ok(refresh().parts[0].facetCounts[1] > 0 && session.parts[0].facetCounts[2] > 0);
stroke('orc_painting_stroke_begin', { tool: 'eraseAll', settings: {} }); commit();
assert.equal(refresh().parts[0].facetCounts.slice(1).reduce((a,b)=>a+b,0), 0);
paint(1, 94, 104); paint(2, 106, 96);
const painted = refresh().parts.map(p => p.facetCounts);
assert.ok(painted[0][0] > 0 && painted[0][1] > 0 && painted[0][2] > 0);
assert.deepEqual(unrelated(savedBytes()), unrelated(before), 'other three native trees survive support edits');
assert.deepEqual(ordinary(), originalKeys, 'ordinary MMU material resources survive support edits');
const savedPaint = savedBytes();
stroke('orc_painting_stroke_begin', { tool: 'sphere', settings: { state: 2, radius: 5 }, event: event(94,104) }); cancel();
assert.deepEqual(fields(savedBytes()), fields(savedPaint), 'cancel discards subdivision/state edits');
paint(1, 94,104,true); const erased = refresh().parts.map(p => p.facetCounts); assert.notDeepEqual(erased,painted);
ok(call('orc_history_undo')); assert.deepEqual(refresh().parts.map(p=>p.facetCounts),painted);
ok(call('orc_history_redo')); assert.deepEqual(refresh().parts.map(p=>p.facetCounts),erased);
ok(call('orc_history_undo')); refresh();
ok(command('orc_history_session_close', { sessionId: hs }));
const roundtrip = savedBytes(); await writeFile(resolve(output,'independent-support-saved.3mf'),roundtrip);
load(roundtrip); open(); assert.deepEqual(session.parts.map(p=>p.facetCounts),painted);
assert.deepEqual(fields(savedBytes()),fields(roundtrip),'exact native four-channel subdivision and state streams reopen');
assert.deepEqual(unrelated(savedBytes()),unrelated(before));
ok(command('orc_history_session_close', { sessionId: hs }));
console.log('support native0/1/2, split-tree save/reopen, independent fields, erase/cancel/Undo/Redo PASS');
const singleRack=ok(call('orc_get_filament_session_snapshot'));ok(command('orc_merge_filament_slots',{version:1,revision:singleRack.revisions.session,source:2,destination:1}));command('orc_history_reset',context);open();assert.equal(ok(call('orc_get_filament_session_snapshot')).slots.length,1);paint(1,100,100);assert.ok(refresh().parts[0].facetCounts[1]>0);ok(command('orc_history_session_close',{sessionId:hs}));console.log('single-filament native Support editing PASS');


// Explicit native support configuration: manual support does not automatically
// generate support. Painting never mutates enable_support or routing options.
const source = await buildPaintedFacetProject();
// Grounded mushroom: two closed boxes with a shared contact plane. Native
// slicing unions their cross sections; the cap overhang remains paintable.
const boxFaces=[[0,1,2],[0,2,3],[4,5,6],[4,6,7],[0,3,5],[0,5,4],[3,2,6],[3,6,5],[2,1,7],[2,7,6],[1,0,4],[1,4,7]];
const boxes=[[-3,3,-3,3,-10,5],[-10,10,-10,10,5,10]];
const meshVertices=boxes.flatMap(([x0,x1,y0,y1,z0,z1])=>[[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[x1,y0,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]]).map(([x,y,z])=>`<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
const meshTriangles=boxes.flatMap((_,box)=>boxFaces.map(face=>`<triangle v1="${face[0]+box*8}" v2="${face[1]+box*8}" v3="${face[2]+box*8}"/>`)).join('');
const fixture = writeStoredZip(readZipEntries(source).map(entry => {
  if(entry.name==='3D/3dmodel.model')return {...entry,content:new TextEncoder().encode(modelXml(source).replace(/ paint_color="[^"]*"/g,'').replace(/<item objectid="1" transform="1 0 0 0 1 0 0 0 1 130 100 10"[^>]*\/>/,'').replace(/<vertices>[\s\S]*?<\/vertices>/,`<vertices>${meshVertices}</vertices>`).replace(/<triangles>[\s\S]*?<\/triangles>/,`<triangles>${meshTriangles}</triangles>`))};
  if(entry.name==='Metadata/model_settings.config')return {...entry,content:new TextEncoder().encode(new TextDecoder().decode(entry.content).replaceAll('key="extruder" value="2"','key="extruder" value="1"'))};
  if(entry.name==='Metadata/project_settings.config'){
    const config=JSON.parse(new TextDecoder().decode(entry.content));
    Object.assign(config,{enable_prime_tower:'1',enable_support:'1',support_type:'normal(manual)',support_filament:'2',support_interface_filament:'2',support_on_build_plate_only:'1',support_threshold_angle:'0',layer_height:'0.3',initial_layer_print_height:'0.2',wall_loops:'1',top_shell_layers:'1',bottom_shell_layers:'1',sparse_infill_density:'0%'});
    return {...entry,content:new TextEncoder().encode(JSON.stringify(config))};
  }
  return entry;
}));
await writeFile(resolve(output,'support-generation-fixture.3mf'),fixture);load(fixture);
const originalPlate=ok(call('orc_get_plate_session_snapshot')).current_plate_id;
const added=ok(call('orc_add_plate'));const unaffectedPlate=added.plates.at(-1).plate_id;ok(call('orc_select_plate',['string'],[unaffectedPlate]));ok(call('orc_add_shape',['string','string'],['Cube','Unrelated support freshness witness']));
ok(call('orc_select_plate',['string'],[originalPlate]));command('orc_history_reset',context);open();
const fieldsBefore=unrelated(savedBytes());
const savedConfig=()=>JSON.parse(new TextDecoder().decode(readZipEntries(savedBytes()).find(e=>e.name==='Metadata/project_settings.config').content));
const configBefore=savedConfig();
const bottomEvent=()=>{
  const e=event(106,100);e.view=[1,0,0,0, 0,-1,0,0, 0,0,-1,0, -100,100,-100,1];return e;
};
const plates=()=>ok(call('orc_get_plate_session_snapshot'));
const towers=()=>ok(call('orc_get_prime_tower_projection'));
const settle=()=>ok(command('orc_painting_settle',{version:1}));
async function slice(label){
  const p=plates(),id=p.current_plate_id;
  const result=ok(await callAsyncTask(call,'orc_slice_plate',['string','string','number'],['{}',id,p.input_revisions[id]]));
  const exported=ok(exportGcode(call, { receipt: result.receipt, filenameBase: '' }));const gcode=Module.FS.readFile(exported.path,{encoding:'utf8'});if(exported.bytes_ptr)Module._free(exported.bytes_ptr);
  await writeFile(resolve(output,label+'.gcode'),gcode);
  let feature='',count=0,tool=0;const supportTools=new Set();for(const line of gcode.split('\n')){if(/^T\d+$/.test(line))tool=Number(line.slice(1));if(line.startsWith(';TYPE:'))feature=line.slice(6);if(feature.includes('Support')&&/^G[0123] /.test(line)&&/\bE[\d.]+/.test(line)){count++;supportTools.add(tool);}}
  return {count,supportTools:[...supportTools],receipt:result.receipt,warnings:result.warnings};
}
ok(call('orc_select_plate',['string'],[unaffectedPlate]));const unaffected=await slice('support-unaffected-baseline');ok(call('orc_select_plate',['string'],[originalPlate]));
const baseline=await slice('support-manual-baseline');assert.equal(baseline.count,0);
const initialTower=towers();const initialSettlement=settle();
for(const p of initialTower.plates)assert.deepEqual(p.used_slots,[1,2],'native model1/support2 usage routing');const beforePlate=plates();
stroke('orc_painting_stroke_begin',{tool:'sphere',settings:{state:1,radius:50},event:bottomEvent()});const enforcedCommit=commit();
assert.ok(refresh().parts[0].facetCounts[1]>0);assert.equal(enforcedCommit.committed,true);
const afterPlate=plates();for(const id of enforcedCommit.affectedPlateIds)assert.ok(afterPlate.input_revisions[id]>beforePlate.input_revisions[id]);
assert.equal(afterPlate.input_revisions[unaffectedPlate],beforePlate.input_revisions[unaffectedPlate]);assert.equal(exportGcode(call, { receipt: baseline.receipt, filenameBase: '' }).ok,false,'affected old receipt is stale');ok(call('orc_select_plate',['string'],[unaffectedPlate]));const retainedExport=ok(exportGcode(call, { receipt: unaffected.receipt, filenameBase: '' }));if(retainedExport.bytes_ptr)Module._free(retainedExport.bytes_ptr);ok(call('orc_select_plate',['string'],[originalPlate]));
assert.deepEqual(unrelated(savedBytes()),fieldsBefore);assert.deepEqual(savedConfig(),configBefore,'brush does not mutate native support configuration/routing');
const enforcedTower=towers();for(const p of enforcedTower.plates)assert.deepEqual(p.used_slots,[1,2]);const enforcedSettlement=settle();
assert.deepEqual(enforcedSettlement.projections.materials.revisions.plates,afterPlate.input_revisions);assert.equal(enforcedSettlement.projections.materials.revisions.session,enforcedCommit.history.revision);assert.deepEqual(enforcedSettlement.projections.primeTower,enforcedTower);
assert.deepEqual(enforcedTower.plates.find(p=>p.plate_id===unaffectedPlate),initialTower.plates.find(p=>p.plate_id===unaffectedPlate),'unaffected native tower stays identical');
for(const p of enforcedTower.plates)assert.equal(p.eligible,true);
const supportSelectors=enforcedSettlement.projections.materials.routing.filter(s=>s.selector==='support-base'||s.selector==='support-interface');assert.ok(supportSelectors.length>0);assert.deepEqual(supportSelectors,initialSettlement.projections.materials.routing.filter(s=>s.selector==='support-base'||s.selector==='support-interface'),'settlement preserves authoritative native routing projection');assert.ok(enforcedSettlement.settledVersion>initialSettlement.settledVersion);
const enforced=await slice('support-enforced');assert.ok(enforced.count>10,'actual native Support G-code after Enforce');assert.deepEqual(enforced.supportTools,[1],'all actual Support extrusion uses configured native slot2');
const enforcedFacets=fields(savedBytes());
stroke('orc_painting_stroke_begin',{tool:'sphere',settings:{state:2,radius:50},event:bottomEvent()});commit();
const blocked=await slice('support-blocked');assert.equal(blocked.count,0,'Block suppresses generated supports');
ok(call('orc_history_undo'));refresh();const undoBlock=await slice('support-block-undo');assert.equal(undoBlock.count,enforced.count);
ok(call('orc_history_redo'));refresh();const redoBlock=await slice('support-block-redo');assert.equal(redoBlock.count,0);
stroke('orc_painting_stroke_begin',{tool:'sphere',settings:{state:1,erase:true,radius:50},event:bottomEvent()});commit();
assert.equal(refresh().parts[0].facetCounts.slice(1).reduce((a,b)=>a+b,0),0);
const erasedGeneration=await slice('support-erased');assert.equal(erasedGeneration.count,0,'Erase restores native manual default');
ok(call('orc_history_undo'));refresh();assert.ok(session.parts[0].facetCounts[2]>0);
ok(call('orc_history_undo'));refresh();assert.deepEqual(fields(savedBytes()),enforcedFacets);
ok(command('orc_history_session_close',{sessionId:hs}));const saved=savedBytes();await writeFile(resolve(output,'support-generation-saved.3mf'),saved);
load(saved);open();const reopened=await slice('support-reopened');assert.equal(reopened.count,enforced.count);assert.deepEqual(fields(savedBytes()),enforcedFacets);
const evidence={fixtureSha256:createHash('sha256').update(fixture).digest('hex'),savedSha256:createHash('sha256').update(saved).digest('hex'),counts:{baseline:baseline.count,enforced:enforced.count,blocked:blocked.count,undoBlock:undoBlock.count,redoBlock:redoBlock.count,erased:erasedGeneration.count,reopened:reopened.count},initialTower,enforcedTower,initialSettlement,enforcedSettlement,beforePlate,afterPlate,supportTools:enforced.supportTools,unaffectedReceipt:unaffected.receipt};
await writeFile(resolve(output,'support-generation-evidence.json'),JSON.stringify(evidence,null,2));ok(command('orc_history_session_close',{sessionId:hs}));console.log('Support real generation Enforce/Block/Erase/UndoRedo/save/reopen and deferred settlement PASS',JSON.stringify(evidence.counts));

const automaticFixture=writeStoredZip(readZipEntries(fixture).map(e=>e.name==='Metadata/project_settings.config'?{...e,content:new TextEncoder().encode(JSON.stringify({...JSON.parse(new TextDecoder().decode(e.content)),support_type:'normal(auto)',support_threshold_angle:'45'}))}:e));
await writeFile(resolve(output,'support-automatic-fixture.3mf'),automaticFixture);load(automaticFixture);open();
const automatic=await slice('support-automatic-baseline');assert.ok(automatic.count>10);
stroke('orc_painting_stroke_begin',{tool:'sphere',settings:{state:2,radius:50},event:bottomEvent()});commit();const automaticBlock=await slice('support-automatic-blocked');assert.equal(automaticBlock.count,0);
stroke('orc_painting_stroke_begin',{tool:'sphere',settings:{state:1,erase:true,radius:50},event:bottomEvent()});commit();const automaticErase=await slice('support-automatic-erased');assert.equal(automaticErase.count,automatic.count,'Auto/Default restores actual automatic support, not forced no-support');
await writeFile(resolve(output,'support-automatic-evidence.json'),JSON.stringify({counts:{baseline:automatic.count,blocked:automaticBlock.count,erased:automaticErase.count}},null,2));ok(command('orc_history_session_close',{sessionId:hs}));console.log('Support automatic default generation restoration PASS');
