// Real native persistence: opaque project assets survive edits/history and replacement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fixtureProfileOptions, createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { readZipEntries, writeStoredZip, verifyNativeProjectArchive } from './native-3mf-parser.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
const Module = await (await loadModuleFactory(process.argv[2]))({ noInitialRun: true, print: () => {}, printErr: console.error });
const nativeTmp = process.argv.includes('--native-tmp') ? mkdtempSync(resolve(tmpdir(), 'neo-aux-')) : undefined;
if (nativeTmp) {
  assert.ok(Module.FS.filesystems.NODEFS, 'threaded Electron filesystem backend');
  Module.FS.mount(Module.FS.filesystems.NODEFS, { root: nativeTmp }, '/tmp');
  process.on('exit', () => rmSync(nativeTmp, { recursive: true, force: true }));
}
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
const call = (name, types = [], args = []) => {
  const p = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(p)); } finally { Module._free(p); }
};
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const exportProject = () => {
  let r;
  if (process.argv.includes('--thumbnails')) {
    const rgba = new Uint8Array(512 * 512 * 4);
    const pointer = Number(Module._malloc(rgba.length)); Module.HEAPU8.set(rgba, pointer);
    try {
      const session = ok(call('orc_get_plate_session_snapshot'));
      r = ok(call('orc_export_project', ['string'], [JSON.stringify({
        expected_revision: call('orc_history_status').revision,
        thumbnails: session.plates.map(plate => ({ plate_id: plate.plate_id,
          width: 512, height: 512, pixels_ptr: pointer, pixels_length: rgba.length })),
      })]));
    } finally { Module._free(pointer); }
  } else r = ok(call('orc_export_project', ['string'], ['{}']));
  try { return Module.HEAPU8.slice(Number(r.bytes_ptr), Number(r.bytes_ptr) + r.bytes_length); }
  finally { Module._free(Number(r.bytes_ptr)); }
};
const load = (bytes, geometryOnly = false) => {
  const p = Number(Module._malloc(bytes.length)); Module.HEAPU8.set(bytes, p);
  try { return call('orc_load_project', ['pointer','number','number','string'], [p,bytes.length,Number(geometryOnly),'Assets.3mf']); }
  finally { Module._free(p); }
};
const enc = s => new TextEncoder().encode(s);
const text = (entries, name) => new TextDecoder().decode(entries.find(e => e.name === name)?.content);
const sha = b => createHash('sha256').update(b).digest('hex');
ok(call('orc_init', ['string'], [fixtureProfileOptions(Module)]));
ok(call('orc_add_shape', ['string','string'], ['Cube','Attachment test']));
const bare = exportProject();
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64'));
const aux = [
  { name:'Auxiliaries/说明/empty.txt', content: new Uint8Array() },
  { name:'Auxiliaries/说明/附件.bin', content: new Uint8Array([0,255,128,1,2,0]) },
  { name:'Auxiliaries/notes.txt', content: enc('Keep exactly\r\n<&>\r\n') },
  { name:'Auxiliaries/empty-directory/', content: new Uint8Array() },
  { name:'Auxiliaries/.thumbnails/custom cover.png', content: png },
  { name:'Auxiliaries/.thumbnails/thumbnail_3mf.png', content: png },
];
const parts = readZipEntries(bare);
const types = parts.find(e => e.name === '[Content_Types].xml');
types.content = enc(text(parts,types.name).replace('</Types>', '<Default Extension="txt" ContentType="text/plain"/><Override PartName="/Auxiliaries/说明/附件.bin" ContentType="application/x-test-opaque"/></Types>'));
const rels = parts.find(e => e.name === '_rels/.rels');
const prefix = 'http://schemas.';
rels.content = enc(`<?xml version="1.0"?><Relationships xmlns="${prefix}openxmlformats.org/package/2006/relationships"><Relationship Id="model" Target="/3D/3dmodel.model" Type="${prefix}microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${[
  `${prefix}openxmlformats.org/package/2006/relationships/metadata/thumbnail`,
  `${prefix}bambulab.com/package/2021/cover-thumbnail-middle`,
  `${prefix}bambulab.com/package/2021/cover-thumbnail-small`,
].map((type,i)=>`<Relationship Id="cover${i}" Target="/Auxiliaries/.thumbnails/custom%20cover.png" Type="${type}"/>`).join('')}<Relationship Id="notes" Target="/Auxiliaries/notes.txt" Type="urn:test:notes"/></Relationships>`);
const fixture = writeStoredZip([...parts,...aux]);
const audit = (bytes,label) => {
  const entries = readZipEntries(bytes);
  assert.deepEqual(verifyNativeProjectArchive(bytes).derivedArtifacts, [], label);
  const actual = entries.filter(e => e.name.startsWith('Auxiliaries/'));
  assert.deepEqual(actual.map(e=>e.name).sort(), aux.map(e=>e.name).sort(),label);
  for (const expected of aux) assert.equal(sha(actual.find(e=>e.name===expected.name).content),sha(expected.content),`${label}: ${expected.name}`);
  const relationships = text(entries,'_rels/.rels');
  assert.equal((relationships.match(/Target="\/Auxiliaries\/.thumbnails\/custom%20cover.png"/g)??[]).length,3,label);
  assert.match(relationships,/urn:test:notes/);
  assert.match(text(entries,'[Content_Types].xml'),/application\/x-test-opaque/);
  assert.match(text(entries,'[Content_Types].xml'),/text\/plain/);
  console.log(`PASS ${label}: ${aux.length} exact attachment paths and SHA-256 hashes, custom cover relationships`);
  return bytes;
};
ok(load(fixture));
assert.equal(Module.FS.readdir('/tmp').filter(n=>n.endsWith('.aux.zip')).length,1);
if (nativeTmp) {
  const diskFile = readdirSync(nativeTmp).find(name => name.endsWith('.aux.zip'));
  assert.ok(diskFile); assert.ok(statSync(resolve(nativeTmp,diskFile)).size > 0);
  console.log('PASS attachment storage is backed by the host temporary directory');
}
audit(exportProject(),'immediate save (including zero-byte file)');
const context = JSON.stringify({ selection:{mode:'object',objectIds:[],partIds:[],instanceIds:[]},activePlateId:null,gizmo:null,nativeScopedConfig:{} });
const tx = ok(call('orc_history_begin',['string','string','string','string'],['Edit project','project',context,'']));
ok(setNativeScopedConfig(call,'project',undefined,'layer_height','0.24'));
assert.equal(call('orc_history_commit',['string','string'],[tx.transactionId,context]).status.canUndo,true);
audit(exportProject(),'save after edit');
ok(call('orc_history_undo'));
audit(exportProject(),'save after Undo');
ok(call('orc_history_redo'));
const saved = audit(exportProject(),'save after Redo');
ok(load(saved));
audit(exportProject(),'reopen and save again');
ok(load(bare,true));
audit(exportProject(),'geometry-only import preserves current attachments');
const assetFile = Module.FS.readdir('/tmp').find(n=>n.endsWith('.aux.zip'));
Module.FS.unlink(`/tmp/${assetFile}`);
assert.notEqual(call('orc_export_project', ['string'], ['{}']).ok,true,'missing attachment storage must fail save');
ok(call('orc_close_project'));
assert.equal(readZipEntries(exportProject()).filter(e=>e.name.startsWith('Auxiliaries/')).length,0);
ok(load(bare));
assert.equal(readZipEntries(exportProject()).filter(e=>e.name.startsWith('Auxiliaries/')).length,0);
ok(load(fixture));
ok(call('orc_test_inject_project_commit_failure'));
assert.notEqual(load(fixture).ok,true);
assert.equal(readZipEntries(exportProject()).filter(e=>e.name.startsWith('Auxiliaries/')).length,0);
assert.equal(Module.FS.readdir('/tmp').filter(n=>n.endsWith('.aux.zip')).length,0);
if (nativeTmp) assert.equal(readdirSync(nativeTmp).filter(name=>name.endsWith('.aux.zip')).length,0);
console.log('PASS New/replacement/failed-load release attachment storage');
process.exit(0);
