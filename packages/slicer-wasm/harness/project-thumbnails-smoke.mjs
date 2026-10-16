// Real PNG bytes, native plate binding, freshness checks, and package relationships.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fixtureProfileOptions, createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { readZipEntries, verifyNativeProjectArchive } from './native-3mf-parser.mjs';
const Module = await (await loadModuleFactory(process.argv[2]))({ noInitialRun: true, print: () => {}, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
const call = (name, types = [], args = []) => {
  const p = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(p)); } finally { Module._free(p); }
};
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
ok(call('orc_init',['string'],[fixtureProfileOptions(Module)]));
ok(call('orc_add_shape',['string','string'],['Cube','Thumbnail test']));
ok(call('orc_add_plate'));
const plates = ok(call('orc_get_plate_session_snapshot')).plates;
const rgba = new Uint8Array(512 * 512 * 4);
for (let y=0; y<512; y++) for (let x=0; x<512; x++) rgba.set(y < 256 ? [255,0,0,255] : [0,0,255,255], (y*512+x)*4);
const pointers = plates.map((_,index) => {
  const bytes = rgba.slice();
  if (index) for (let offset=0;offset<bytes.length;offset+=4) {
    bytes[offset+1]=255; bytes[offset+2]=0;
  }
  const pointer=Number(Module._malloc(bytes.length)); Module.HEAPU8.set(bytes,pointer); return pointer;
});
const request = { expected_revision: call('orc_history_status').revision, thumbnails: plates.map((p,index) => ({
  plate_id: p.plate_id, width:512,height:512,pixels_ptr:pointers[index],pixels_length:rgba.length,
})).reverse() };
const exportRequest = r => call('orc_export_project',['string'],[JSON.stringify(r)]);
assert.notEqual(exportRequest({...request,expected_revision:request.expected_revision+1}).ok,true);
assert.notEqual(exportRequest({...request,thumbnails:request.thumbnails.slice(1)}).ok,true);
assert.notEqual(exportRequest({...request,thumbnails:[request.thumbnails[0],request.thumbnails[0]]}).ok,true);
assert.notEqual(exportRequest({...request,thumbnails:request.thumbnails.map(t=>({...t,pixels_length:4}))}).ok,true);
const exported = ok(exportRequest(request));
const bytes = Module.HEAPU8.slice(exported.bytes_ptr,exported.bytes_ptr+exported.bytes_length);
Module._free(exported.bytes_ptr); pointers.forEach(pointer=>Module._free(pointer));
const entries = readZipEntries(bytes);
assert.deepEqual(verifyNativeProjectArchive(bytes).derivedArtifacts,[]);
const read = name => { const entry=entries.find(e=>e.name===name); assert.ok(entry,name); return Buffer.from(entry.content); };
function decodePng(bytes) {
  assert.equal(bytes.subarray(1,4).toString(),'PNG');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20), data=[];
  assert.equal(bytes[24],8); assert.equal(bytes[25],6);
  for(let offset=8;offset<bytes.length;) {
    const size=bytes.readUInt32BE(offset); if(bytes.toString('ascii',offset+4,offset+8)==='IDAT') data.push(bytes.subarray(offset+8,offset+8+size)); offset+=size+12;
  }
  const raw=inflateSync(Buffer.concat(data)), stride=width*4, pixels=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++) for(let x=0;x<stride;x++) {
    const a=x>=4?pixels[y*stride+x-4]:0,b=y?pixels[(y-1)*stride+x]:0,c=y&&x>=4?pixels[(y-1)*stride+x-4]:0;
    const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
    const predictors=[0,a,b,Math.floor((a+b)/2),pa<=pb&&pa<=pc?a:pb<=pc?b:c];
    pixels[y*stride+x]=(raw[y*(stride+1)+x+1]+predictors[raw[y*(stride+1)]])&255;
  }
  return {width,height,pixels};
}
for(let index=1;index<=plates.length;index++) for(const [suffix,size] of [['',512],['_small',128]]) {
  const png=decodePng(read(`Metadata/plate_${index}${suffix}.png`));
  assert.equal(png.width,size); assert.equal(png.height,size);
  assert.deepEqual([...png.pixels.subarray(0,4)],index===1?[0,0,255,255]:[0,255,0,255],'WebGL bottom-up rows flipped to PNG');
  assert.deepEqual([...png.pixels.subarray(-4)],[255,index===1?0:255,0,255]);
}
assert.match(read('Metadata/model_settings.config').toString(),/Metadata\/plate_1.png/);
assert.match(read('_rels/.rels').toString(),/Metadata\/plate_1.png/);
console.log('PASS 512/128 PNG dimensions, row orientation, all plates, native references, invalid/stale requests');
process.exit(0);
