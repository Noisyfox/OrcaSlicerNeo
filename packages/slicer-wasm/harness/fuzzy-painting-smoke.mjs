// Real native fuzzy editing, native-format interoperability and fuzzy placement.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { buildPaintingChannelProject, buildPaintedFacetProject } from './painted-facet-fixture-builder.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { awaitAsyncTask, exportGcode } from './async-task-mailbox.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: fuzzy-painting-smoke.mjs <orca_slice.js> [output-directory]');
const output = resolve(process.argv[3] ?? 'packages/slicer-wasm/.work/step17-native');
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
  try { ok(call('orc_load_project', ['pointer','number','number','string'], [pointer, bytes.length, 0, 'fuzzy-fixture.3mf'])); }
  finally { Module._free(pointer); }
  command('orc_history_reset', context);
}
function open() {
  hs = ok(command('orc_history_session_open', {})).sessionId;
  const object = ok(call('orc_get_model_structure')).objects[0];
  session = ok(command('orc_painting_session_open', { version: 1, channel: 'fuzzy', historySessionId: hs, objectId: object.id, instanceId: object.instances[0].id })).session;
}
const handle = () => ({ version: 1, channel: 'fuzzy', sessionId: session.id, revision: session.revision });
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
const unrelated = bytes => fields(bytes).map(({ paint_fuzzy_skin, ...rest }) => rest);
function ordinary() {
  const result = ok(call('orc_get_model_mesh'));
  try { return result.renderables.map(r => [r.volume_id, r.paint_key]); }
  finally { for (const g of [...result.geometries,...result.paint_geometries]) { if (g.vertex_ptr) Module._free(g.vertex_ptr); if (g.index_ptr) Module._free(g.index_ptr); } }
}
ok(command('orc_init', { log_level: 'error' }));
const imported = await buildPaintingChannelProject(); load(imported); open();
const before = savedBytes(), originalKeys = ordinary();
assert.ok(refresh().parts[0].facetCounts[1] > 0 );
stroke('orc_painting_stroke_begin', { tool: 'eraseAll', settings: {} }); commit();
assert.equal(refresh().parts[0].facetCounts.slice(1).reduce((a,b)=>a+b,0), 0);
for(const tool of ['sphere','triangle','smartFill']){
  const trees=unrelated(savedBytes());stroke('orc_painting_stroke_begin',{tool,settings:{state:1,radius:5,angle:90},event:event(100,100)});commit();assert.ok(refresh().parts[0].facetCounts[1]>0,`${tool} changes fuzzy0 to1`);assert.deepEqual(unrelated(savedBytes()),trees);
  stroke('orc_painting_stroke_begin',{tool:'eraseAll',settings:{}});commit();assert.equal(refresh().parts[0].facetCounts[1],0);
}
paint(1, 94, 104); paint(1, 106, 96);
const painted = refresh().parts.map(p => p.facetCounts);
assert.ok(painted[0][0] > 0 && painted[0][1] > 0);
assert.deepEqual(unrelated(savedBytes()), unrelated(before), 'other three native trees survive fuzzy edits');
assert.deepEqual(ordinary(), originalKeys, 'ordinary MMU material resources survive fuzzy edits');
const savedPaint = savedBytes();
stroke('orc_painting_stroke_begin', { tool: 'sphere', settings: { state: 1, radius: 5 }, event: event(94,104) }); cancel();
assert.deepEqual(fields(savedBytes()), fields(savedPaint), 'cancel discards subdivision/state edits');
paint(1, 94,104,true); const erased = refresh().parts.map(p => p.facetCounts); assert.notDeepEqual(erased,painted);
ok(call('orc_history_undo')); assert.deepEqual(refresh().parts.map(p=>p.facetCounts),painted);
ok(call('orc_history_redo')); assert.deepEqual(refresh().parts.map(p=>p.facetCounts),erased);
ok(call('orc_history_undo')); refresh();
ok(command('orc_history_session_close', { sessionId: hs }));
const roundtrip = savedBytes(); await writeFile(resolve(output,'independent-fuzzy-saved.3mf'),roundtrip);
load(roundtrip); open(); assert.deepEqual(session.parts.map(p=>p.facetCounts),painted);
assert.deepEqual(fields(savedBytes()),fields(roundtrip),'exact native four-channel subdivision and state streams reopen');
assert.deepEqual(unrelated(savedBytes()),unrelated(before));
ok(command('orc_history_session_close', { sessionId: hs }));
console.log('fuzzy native0/1, split-tree save/reopen, independent fields, erase/cancel/Undo/Redo PASS');


const source = await buildPaintedFacetProject();
const sliceFixture = writeStoredZip(readZipEntries(source).map(entry => {
  if (entry.name === '3D/3dmodel.model') return { ...entry, content: new TextEncoder().encode(modelXml(source).replace(/ paint_color="[^"]*"/g,'').replace(/<item objectid="1" transform="1 0 0 0 1 0 0 0 1 130 100 10"[^>]*\/>/,'')) };
  if (entry.name === 'Metadata/project_settings.config') {
    const config = JSON.parse(new TextDecoder().decode(entry.content));
    Object.assign(config,{ enable_prime_tower:'0', enable_support:'0', fuzzy_skin:'disabled_fuzzy', fuzzy_skin_thickness:'0.3', fuzzy_skin_point_distance:'0.5', layer_height:'0.3', initial_layer_print_height:'0.2', wall_loops:'1', top_shell_layers:'0', bottom_shell_layers:'0', sparse_infill_density:'0%' });
    return { ...entry, content: new TextEncoder().encode(JSON.stringify(config)) };
  }
  return entry;
}));
await writeFile(resolve(output,'fuzzy-slice-fixture.3mf'),sliceFixture);
load(sliceFixture);
let rack = ok(call('orc_get_filament_session_snapshot'));
ok(command('orc_merge_filament_slots',{version:1,revision:rack.revisions.session,source:2,destination:1}));
command('orc_history_reset',context); open();
assert.equal(ok(call('orc_get_filament_session_snapshot')).slots.length,1);
function configure(scope,value,operation='set') {
  const tx=ok(call('orc_history_begin',['string','string','string','string'],['Change Scoped Configuration','project',JSON.stringify(context),'']));
  const result=ok(command('orc_mutate_native_scoped_config',{version:1,operation,targets:[{scope,...(scope==='object'?{id:String(session.objectId)}:scope==='part'?{id:String(session.parts[0].volumeId)}:{})}],...(operation==='set'?{values:{fuzzy_skin:value}}:{key:'fuzzy_skin'})}));
  const committed=call('orc_history_commit',['string','string'],[tx.transactionId,JSON.stringify(context)]); assert.ok(committed.status && !committed.error); 
  refresh(); return result;
}
function extrusion(gcode) { return gcode.split('\n').filter(line=>/^G[0123] /.test(line)&&/\bE-?[\d.]+/.test(line)); }
async function slice(label) {
  const plates=ok(call('orc_get_plate_session_snapshot')), id=plates.current_plate_id;
  const messages=[]; const result=ok(await awaitAsyncTask(call,call('orc_slice_plate',['string','string','number'],['{}',id,plates.input_revisions[id]]),120000,batch=>messages.push(...batch))); 
  const exported=ok(exportGcode(call, { receipt: result.receipt, filenameBase: '' }));
  const gcode=Module.FS.readFile(exported.path,{encoding:'utf8'}); if(exported.bytes_ptr)Module._free(exported.bytes_ptr);
  await writeFile(resolve(output,`${label}.gcode`),gcode);
  const lines=extrusion(gcode); assert.ok(lines.length>10); return {gcode,lines,warnings:result.warnings??[],progress:messages.filter(m=>m.type==='task-progress').map(m=>m.text),receipt:result.receipt};
}
const baseline=await slice('baseline-disabled');
stroke('orc_painting_stroke_begin',{tool:'sphere',settings:{state:1,radius:50},event:event(100,100)}); commit();
assert.ok(refresh().parts[0].facetCounts[1]>0);
const disabled=await slice('painted-disabled'); assert.deepEqual(disabled.lines,baseline.lines,'disabled annotations do not jitter native toolpaths');
const annotated=fields(savedBytes());
configure('object','none'); const enabled=await slice('object-painted-only');
assert.ok(enabled.lines.length>baseline.lines.length*2,'native fuzzy segmentation creates dense jittered toolpaths');
assert.deepEqual(fields(savedBytes()),annotated,'explicit configuration never mutates annotation trees');
ok(call('orc_history_undo')); refresh(); assert.deepEqual(fields(savedBytes()),annotated); const configUndo=await slice('config-undo-disabled'); assert.deepEqual(configUndo.lines,baseline.lines);
ok(call('orc_history_undo'));refresh();assert.equal(session.parts[0].facetCounts[1],0,'paint Undo is independently reversible below config separator');const paintUndo=await slice('paint-undo-disabled');assert.deepEqual(paintUndo.lines,baseline.lines);ok(call('orc_history_redo'));refresh();assert.deepEqual(fields(savedBytes()),annotated);const paintRedo=await slice('paint-redo-still-disabled');assert.deepEqual(paintRedo.lines,baseline.lines);
ok(call('orc_history_redo')); refresh(); assert.deepEqual(fields(savedBytes()),annotated); const configRedo=await slice('config-redo-enabled'); assert.ok(configRedo.lines.length>baseline.lines.length*2);
configure('part','disabled_fuzzy'); const partDisabled=await slice('part-disabled-override'); assert.deepEqual(partDisabled.lines,baseline.lines);
configure('object','none'); const stillDisabled=await slice('object-enable-retains-part'); assert.deepEqual(stillDisabled.lines,baseline.lines);
configure('part','none','reset'); const inheritedObject=await slice('inherited-object'); assert.ok(inheritedObject.lines.length>baseline.lines.length*2);
configure('project','none'); configure('object','none','reset'); const inheritedProject=await slice('inherited-project'); assert.ok(inheritedProject.lines.length>baseline.lines.length*2);
const wholeModes={}; for(const mode of ['external','hole','all','allwalls']) { configure('object',mode); const paintedMode=await slice(`whole-surface-${mode}-painted`); assert.ok(paintedMode.lines.length>baseline.lines.length*2); stroke('orc_painting_stroke_begin',{tool:'eraseAll',settings:{}});commit();const erasedMode=await slice(`whole-surface-${mode}-erased`);if(mode==='hole') assert.deepEqual(erasedMode.lines,baseline.lines,'cube has no holes; erase in Hole mode leaves baseline contour');else assert.ok(erasedMode.lines.length>baseline.lines.length*2);wholeModes[mode]={painted:paintedMode.lines.length,erased:erasedMode.lines.length};ok(call('orc_history_undo'));refresh(); }
configure('object','all'); stroke('orc_painting_stroke_begin',{tool:'eraseAll',settings:{}}); commit();
assert.equal(refresh().parts[0].facetCounts[1],0);
const wholeErased=await slice('whole-surface-erased'); assert.ok(wholeErased.lines.length>baseline.lines.length*2,'erase does not suppress whole-surface fuzzy mode');
ok(call('orc_history_undo')); refresh();configure('object','none');
ok(command('orc_history_session_close',{sessionId:hs})); const downstream=savedBytes(); await writeFile(resolve(output,'fuzzy-downstream-saved.3mf'),downstream);
load(downstream); open(); assert.deepEqual(fields(savedBytes()),fields(downstream)); const reopened=await slice('reopened-fuzzy'); assert.ok(reopened.lines.length>baseline.lines.length*2);
ok(command('orc_history_session_close',{sessionId:hs}));
const evidence={fixtureSha256:createHash('sha256').update(sliceFixture).digest('hex'),savedSha256:createHash('sha256').update(downstream).digest('hex'),wholeModes,holeFixtureLimitation:'Solid cube has no holes; proves Hole mode config/paint and erased contour baseline, not hole surface jitter.',extrusionCounts:Object.fromEntries(Object.entries({baseline,disabled,enabled,configUndo,paintUndo,paintRedo,configRedo,partDisabled,stillDisabled,inheritedObject,inheritedProject,wholeErased,reopened}).map(([key,result])=>[key,result.lines.length]))};
await writeFile(resolve(output,'fuzzy-native-evidence.json'),JSON.stringify(evidence,null,2)); console.log('fuzzy native downstream/config/history PASS',JSON.stringify(evidence));

// Preserve native fuzzy+MMU segmentation and the annotation-based XY warning.
let mixedTriangle=0;
const mixedFixture=writeStoredZip(readZipEntries(sliceFixture).map(entry=>entry.name==='3D/3dmodel.model'?{...entry,content:new TextEncoder().encode(modelXml(sliceFixture).replace(/<triangle\b[^>]*\/>/g,tr=>tr.replace('/>',` paint_color="${mixedTriangle++%2?'8':'4'}" paint_fuzzy_skin="4"/>`)))}:entry));
await writeFile(resolve(output,'fuzzy-MMU-fixture.3mf'),mixedFixture);
load(mixedFixture);command('orc_history_reset',context);open();
configure('object','none');
const mixed=await slice('fuzzy-plus-MMU'); assert.ok(mixed.lines.length>baseline.lines.length*2);
const mixedGcode=await import('node:fs/promises').then(fs=>fs.readFile(resolve(output,'fuzzy-plus-MMU.gcode'),'utf8'));
assert.match(mixedGcode,/^T0$/m);assert.match(mixedGcode,/^T1$/m);
const xy=ok(command('orc_mutate_native_scoped_config',{version:1,operation:'set',targets:[{scope:'object',id:String(session.objectId)}],values:{xy_contour_compensation:'0.1'}}));refresh();
const xyEnabled=await slice('xy-fuzzy-enabled');assert.ok(xyEnabled.warnings.some(w=>w.includes('XY Size compensation cannot be combined with fuzzy skin painting')));
configure('object','disabled_fuzzy');const xyDisabled=await slice('xy-fuzzy-disabled');assert.ok(xyDisabled.warnings.some(w=>w.includes('XY Size compensation cannot be combined with fuzzy skin painting')),'native annotation warning remains even while disabled');
ok(command('orc_history_session_close',{sessionId:hs}));
const addedPlate=ok(call('orc_add_plate'));const cleanPlateId=addedPlate.plates.at(-1).plate_id;ok(call('orc_select_plate',['string'],[cleanPlateId]));ok(call('orc_add_shape',['string','string'],['Cube','Unrelated clean object']));const liveClean=await slice('live-unrelated-plate');assert.ok(liveClean.warnings.every(w=>!w.includes('fuzzy skin painting')));
const warningPlate=xyEnabled.receipt.plate_id;ok(call('orc_select_plate',['string'],[warningPlate]));open();
stroke('orc_painting_stroke_begin',{tool:'eraseAll',settings:{}});commit();const xyErased=await slice('xy-erased');assert.ok(xyErased.warnings.every(w=>!w.includes('fuzzy skin painting')),'erase removes current native annotation warning');
const xyRepeated=await slice('xy-erased-cached');assert.ok(xyRepeated.warnings.every(w=>!w.includes('fuzzy skin painting')));
ok(command('orc_history_session_close',{sessionId:hs}));load(sliceFixture);open();const unrelatedPlate=await slice('unrelated-clean-plate');assert.ok(unrelatedPlate.warnings.every(w=>!w.includes('fuzzy skin painting')),'warnings remain scoped to current native plate/object');
await writeFile(resolve(output,'fuzzy-MMU-XY-evidence.json'),JSON.stringify({fixtureSha256:createHash('sha256').update(mixedFixture).digest('hex'),mixedCount:mixed.lines.length,enabledWarnings:xyEnabled.warnings,disabledWarnings:xyDisabled.warnings,erasedWarnings:xyErased.warnings,cleanPlateWarnings:unrelatedPlate.warnings,liveUnrelatedWarnings:liveClean.warnings},null,2));
ok(command('orc_history_session_close',{sessionId:hs}));console.log('native Fuzzy+MMU and XY warning retention PASS');

// Native multipart/modifier precedence with coincident full-size modifier.
load(sliceFixture);ok(call('orc_add_shape',['string','string'],['Cube','Fuzzy modifier']));
const mesh=ok(call('orc_get_model_mesh'));
try { const added=mesh.renderables.find(r=>r.object_idx===1);const transform={...added.instance_transform,offset:[100,100,10]};delete transform.matrix;ok(call('orc_set_model_transform',['number','number','number','string','string'],[1,0,0,JSON.stringify(transform),JSON.stringify(added.volume_transform)])); }
finally {for(const g of [...mesh.geometries,...mesh.paint_geometries]){if(g.vertex_ptr)Module._free(g.vertex_ptr);if(g.index_ptr)Module._free(g.index_ptr);}}
const ids=ok(call('orc_get_model_structure')).objects.map(o=>o.id);ok(call('orc_merge_objects_to_multipart',['string','string'],[JSON.stringify(ids),'Fuzzy multipart modifier']));
const multipart=ok(call('orc_get_model_structure')).objects[0];const modifier=multipart.volumes[1];ok(call('orc_set_volume_type',['number','string'],[modifier.id,'parameter_modifier']));
command('orc_history_reset',context);open();configure('object','none');
stroke('orc_painting_stroke_begin',{tool:'sphere',settings:{state:1,radius:50},event:event(100,100)});commit();
const modifierEnabled=await slice('modifier-inherited-painted');assert.ok(modifierEnabled.lines.length>baseline.lines.length*2);
ok(command('orc_mutate_native_scoped_config',{version:1,operation:'set',targets:[{scope:'part',id:String(modifier.id)}],values:{fuzzy_skin:'disabled_fuzzy'}}));refresh();
configure('object','none');const modifierDisabled=await slice('modifier-disabled-retained');assert.ok(modifierDisabled.lines.length<modifierEnabled.lines.length/2,'more-specific coincident modifier disables jitter after object enable');
const modifierSaved=savedBytes();await writeFile(resolve(output,'fuzzy-modifier-saved.3mf'),modifierSaved);ok(command('orc_history_session_close',{sessionId:hs}));load(modifierSaved);open();const modifierReloaded=await slice('modifier-disabled-reopened');assert.ok(modifierReloaded.lines.length<modifierEnabled.lines.length/2);
await writeFile(resolve(output,'fuzzy-modifier-evidence.json'),JSON.stringify({sha256:createHash('sha256').update(modifierSaved).digest('hex'),enabledCount:modifierEnabled.lines.length,disabledCount:modifierDisabled.lines.length,reopenedCount:modifierReloaded.lines.length},null,2));ok(command('orc_history_session_close',{sessionId:hs}));console.log('native multipart/modifier inherited override PASS');


// A closed square prism with a real through-hole separates Hole mode from the
// solid-cube baseline. Winding is outward on exterior and inward on hole walls.
const ringCorners = [[-10,-10],[10,-10],[10,10],[-10,10]];
const holeCorners = [[-4,-4],[4,-4],[4,4],[-4,4]];
const ringVertices = [-10,10].flatMap(z => [...ringCorners,...holeCorners].map(([x,y]) => [x,y,z]));
const ringTriangles = [];
const quad = (a,b,c,d) => ringTriangles.push([a,b,c],[a,c,d]);
for (let i=0;i<4;i++) {
  const n=(i+1)%4;
  quad(i,n,n+8,i+8); // outer wall
  quad(i+4,i+12,n+12,n+4); // hole wall
  quad(i+8,n+8,n+12,i+12); // top ring
  quad(i,i+4,n+4,n); // bottom ring
}
const ringMesh = `<mesh><vertices>${ringVertices.map(([x,y,z])=>`<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${ringTriangles.map(([a,b,c])=>`<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`;
const ringFixture = writeStoredZip(readZipEntries(sliceFixture).map(entry => entry.name === '3D/3dmodel.model'
  ? {...entry,content:new TextEncoder().encode(modelXml(sliceFixture).replace(/<mesh>[\s\S]*?<\/mesh>/,ringMesh))} : entry));
await writeFile(resolve(output,'fuzzy-through-hole-fixture.3mf'),ringFixture);
load(ringFixture);open();
const holeDisabled = await slice('through-hole-disabled');
configure('object','hole');
stroke('orc_painting_stroke_begin',{tool:'sphere',settings:{state:1,radius:50},event:event(106,100)});commit();
assert.ok(refresh().parts[0].facetCounts[1]>0);
const holePainted = await slice('through-hole-painted');
stroke('orc_painting_stroke_begin',{tool:'eraseAll',settings:{}});commit();
assert.equal(refresh().parts[0].facetCounts[1],0);
const holeErased = await slice('through-hole-erased');
assert.ok(holeErased.lines.length > holeDisabled.lines.length * 1.5,
  'Hole mode still jitters real inner walls after all annotations are erased');
assert.notDeepEqual(holeErased.lines,holeDisabled.lines);
function innerSegments(gcode) {
  let x=0,y=0,z=0,e=0,relativeE=false,relativeXYZ=false;
  const selected=[];
  for(const raw of gcode.split('\n')) {
    const line=raw.split(';')[0].trim();
    if(/^M83\b/.test(line)) {relativeE=true;continue;}
    if(/^M82\b/.test(line)) {relativeE=false;continue;}
    if(/^G91\b/.test(line)) {relativeXYZ=true;continue;}
    if(/^G90\b/.test(line)) {relativeXYZ=false;continue;}
    const values=Object.fromEntries([...line.matchAll(/([XYZE])(-?(?:\d+(?:\.\d*)?|\.\d+))/g)].map(([,k,v])=>[k,Number(v)]));
    if(/^G92\b/.test(line)) {if(values.E!==undefined)e=values.E;continue;}
    if(!/^G[01]\b/.test(line))continue;
    const nx=values.X===undefined?x:values.X+(relativeXYZ?x:0),ny=values.Y===undefined?y:values.Y+(relativeXYZ?y:0),nz=values.Z===undefined?z:values.Z+(relativeXYZ?z:0);
    const de=values.E===undefined?0:relativeE?values.E:values.E-e;
    if(values.E!==undefined)e=relativeE?e+values.E:values.E;
    const inHole=(px,py)=>px>=95.1&&px<=104.9&&py>=95.1&&py<=104.9&&Math.max(Math.abs(px-100),Math.abs(py-100))>=3.5;
    if(de>0 && Math.hypot(nx-x,ny-y)>1e-6 && nz>0 && nz<=20.1 && inHole(x,y)&&inHole(nx,ny))
      selected.push({from:[x,y,z],to:[nx,ny,nz],extrusion:de});
    x=nx;y=ny;z=nz;
  }
  return selected;
}
const innerDisabled=innerSegments(holeDisabled.gcode),innerErased=innerSegments(holeErased.gcode);
assert.ok(innerDisabled.length>100,'disabled baseline contains actual positive-extrusion inner perimeters');
assert.ok(innerErased.length>innerDisabled.length*2,'Hole mode textures the same inner perimeter band after erasing annotations');
const innerBounds=segments=>({min:[0,1].map(i=>Math.min(...segments.flatMap(s=>[s.from[i],s.to[i]]))),max:[0,1].map(i=>Math.max(...segments.flatMap(s=>[s.from[i],s.to[i]])))});
const disabledBounds=innerBounds(innerDisabled),erasedBounds=innerBounds(innerErased);
assert.ok(erasedBounds.min.every((v,i)=>Math.abs(v-disabledBounds.min[i])<0.5)&&erasedBounds.max.every((v,i)=>Math.abs(v-disabledBounds.max[i])<0.5),'textured segments retain actual through-hole bounds');
configure('object','disabled_fuzzy');
const holeDisabledAgain = await slice('through-hole-disabled-again');
assert.deepEqual(holeDisabledAgain.lines,holeDisabled.lines,'disabling restores exact untextured through-hole paths');
await writeFile(resolve(output,'fuzzy-through-hole-evidence.json'),JSON.stringify({
  fixtureSha256:createHash('sha256').update(ringFixture).digest('hex'),vertices:ringVertices.length,triangles:ringTriangles.length,
  disabledCount:holeDisabled.lines.length,paintedCount:holePainted.lines.length,erasedCount:holeErased.lines.length,
  innerDisabled:innerDisabled.length,innerErased:innerErased.length,disabledBounds,erasedBounds,
  semantics:'Modal G0/G1 XYZ/E with G90/G91, M82/M83 and G92 E; positive extrusion and nonzero XY moves whose endpoints lie in the actual inner-wall band, excluding travel, priming/retraction and exterior contours.',
},null,2));
ok(command('orc_history_session_close',{sessionId:hs}));
console.log('native Hole mode real through-hole after erase PASS');
