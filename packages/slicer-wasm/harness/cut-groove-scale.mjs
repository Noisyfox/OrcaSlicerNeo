// Exercise the deployed Cut implementation in an isolated Node Worker. The
// growing WASM memory cannot shrink, so its final capacity records its peak.
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';
import { meshBooleanSphereFixture } from './mesh-boolean-fixtures.mjs';

async function run() {
  const { createClient } = await import(workerData.client);
  const { default: factory } = await import(pathToFileURL(workerData.module).href);
  const m = await factory({ noInitialRun:true, locateFile:name=>resolve(dirname(workerData.module),name), print(){}, printErr(){} });
  await installProfilePackages(m,createNodeProfileSource(resolve(import.meta.dirname,'../../profile-resources/dist')));
  const ptr=Number(m.ccall('orc_init','number',['string'],[fixtureProfileOptions(m)]));
  try { assert.equal(JSON.parse(m.UTF8ToString(ptr)).ok,true); } finally { m._free(ptr); }
  const client=createClient(async()=>m);
  const sphere=meshBooleanSphereFixture(workerData.level);
  assert.equal((await client.addModel(sphere.bytes,'stl','Groove scale sphere')).ok,true);
  const object=(await client.getModelStructure()).objects[0];
  const context={ selection:{ mode:'object', objectIds:[], instanceIds:[], partIds:[] }, activePlateId:null,gizmo:null,nativeScopedConfig:{} };
  await client.resetHistory(context);
  const mesh=(await client.getModelMesh()).objects[0];
  const center=[0,1,2].map(axis=>mesh.instanceTransform.offset[axis]+mesh.volumeTransform.offset[axis]);
  const request={ objectId:object.id, instanceId:object.instances[0].id, revision:(await client.getHistoryStatus()).revision,
    center, rotation:[1,0,0,0,1,0,0,0,1], groove:{ count:2,depth:2,width:4,flankAngle:60,angle:3,widthTolerance:0.2,depthTolerance:0.1,gap:3 } };
  const before=m.HEAPU8.buffer.byteLength, start=performance.now();
  const preview=await client.getCutPieces(request);
  assert.equal(preview.ok,true,preview.error);
  const previewMs=Math.round(performance.now()-start), previewBytes=preview.positions.byteLength;
  const tx=await client.runProjectHistoryTransaction('Dovetail scale','project',context,()=>client.applyCut({
    ...request,upper:'keep',lower:'keep',asParts:false,keepPainting:false,openEdges:'apply',
  }),context);
  assert.equal(tx.result.ok,true,tx.result.error); assert.equal(tx.result.changed,true);
  const after=(await client.getRuntimeMemory()).wasmLinearMemoryBytes;
  return { module:workerData.module, triangles:sphere.triangles, previewBytes, previewMs, applyMs:Math.round(performance.now()-start)-previewMs,
    wasmCapacityBefore:before, wasmCapacityPeak:after, workerJsHeapAfter:process.memoryUsage().heapUsed };
}

if (!isMainThread && workerData?.cutScale) {
  try { parentPort.postMessage({ ok:true, report:await run() }); }
  catch (error) { parentPort.postMessage({ ok:false,error:String(error.stack ?? error) }); }
} else if (isMainThread && resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const artifact=process.argv[2], level=Number(process.argv[3] ?? 7);
  assert.ok(artifact && Number.isInteger(level) && level>=0 && level<=8,
    'Usage: node harness/cut-groove-scale.mjs path/to/orca_slice.js [sphere subdivision level]');
  const scratch=await mkdtemp(join(tmpdir(),'orca-cut-scale-'));
  try {
    const require=createRequire(new URL('../../slicer-app/package.json',import.meta.url));
    const { build }=createRequire(require.resolve('vite/package.json'))('esbuild');
    const client=join(scratch,'client.mjs');
    await build({ entryPoints:[resolve(import.meta.dirname,'../src/client/client.ts')], outfile:client, bundle:true,
      platform:'node', format:'esm', define:{ 'import.meta.env':'{}' }, logLevel:'silent' });
    const worker=new Worker(new URL(import.meta.url),{ workerData:{cutScale:true,module:resolve(artifact),level,client:pathToFileURL(client).href} });
    let peakRss=process.memoryUsage.rss();
    const sampler=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage.rss());},20);
    try {
      const report=await new Promise((res,rej)=>{
        worker.once('message',m=>m.ok?res(m.report):rej(new Error(m.error)));
        worker.once('error',rej); worker.once('exit',code=>rej(new Error('Worker exited before reporting: '+code)));
      });
      console.log(JSON.stringify({...report,processRssSampledPeak:Math.max(peakRss,process.memoryUsage.rss())}));
    } finally {clearInterval(sampler);await worker.terminate();}
  } finally {await rm(scratch,{recursive:true,force:true});}
}
