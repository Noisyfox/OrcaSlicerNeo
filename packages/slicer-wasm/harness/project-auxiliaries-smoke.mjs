// Real native persistence: opaque project assets survive edits/history and replacement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { crc32, deflateSync } from 'node:zlib';
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
const readerIndex = process.argv.indexOf('--native-reader');
const nativeReader = readerIndex < 0 ? undefined : resolve(process.argv[readerIndex + 1]);
const readerDirectory = nativeReader ? mkdtempSync(resolve(tmpdir(), 'neo-cover-reader-')) : undefined;
if (readerDirectory) process.on('exit', () => rmSync(readerDirectory, { recursive: true, force: true }));
let nativeReads = 0;
const verifyDesktopCover = (bytes, png, label) => {
  if (!nativeReader) return;
  const projectPath = resolve(readerDirectory, `cover-${++nativeReads}.3mf`);
  const expectedPath = resolve(readerDirectory, 'expected.png');
  writeFileSync(projectPath, bytes); writeFileSync(expectedPath, png);
  const result = spawnSync(nativeReader, [projectPath, expectedPath], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${label}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS desktop Orca cover read and PNG decode: 16x16/);
};
const xmlEscape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const solidPng = rgba => {
  const chunk = (name, data) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length); bytes.write(name, 4, 'ascii'); bytes.set(data, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(16 * 65);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) rows.set(rgba, y * 65 + x * 4 + 1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
};
ok(call('orc_init', ['string'], [fixtureProfileOptions(Module)]));
ok(call('orc_add_shape', ['string','string'], ['Cube','Attachment test']));
const bare = exportProject();
const png = solidPng([255, 0, 255, 255]);
const aux = [
  { name:'Auxiliaries/说明/empty.txt', content: new Uint8Array() },
  { name:'Auxiliaries/说明/附件.bin', content: new Uint8Array([0,255,128,1,2,0]) },
  { name:'Auxiliaries/percent%20.bin', content: new Uint8Array([10,20,30]) },
  { name:'Auxiliaries/UPPER.TXT', content: enc('Case insensitive extension') },
  { name:'Auxiliaries/notes.txt', content: enc('Keep exactly\r\n<&>\r\n') },
  { name:'Auxiliaries/empty-directory/', content: new Uint8Array() },
  { name:'Auxiliaries/.thumbnails/custom cover.png', content: png },
  { name:'Auxiliaries/.thumbnails/thumbnail_3mf.png', content: png },
];
const parts = readZipEntries(bare);
const types = parts.find(e => e.name === '[Content_Types].xml');
types.content = enc(text(parts,types.name).replace('</Types>', '<Override PartName="/Auxiliaries/percent%2520.bin" ContentType="application/x-test-percent"/><Default Extension="txt" ContentType="text/plain"/><Override PartName="/Auxiliaries/说明/附件.bin" ContentType="application/x-test-opaque"/></Types>'));
const rels = parts.find(e => e.name === '_rels/.rels');
const prefix = 'http://schemas.';
const coverTypes = [
  `${prefix}openxmlformats.org/package/2006/relationships/metadata/thumbnail`,
  `${prefix}bambulab.com/package/2021/cover-thumbnail-middle`,
  `${prefix}bambulab.com/package/2021/cover-thumbnail-small`,
];
rels.content = enc(`<?xml version="1.0"?><Relationships xmlns="${prefix}openxmlformats.org/package/2006/relationships"><Relationship Id="model" Target="/3D/3dmodel.model" Type="${prefix}microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${[
  `${prefix}openxmlformats.org/package/2006/relationships/metadata/thumbnail`,
  `${prefix}bambulab.com/package/2021/cover-thumbnail-middle`,
  `${prefix}bambulab.com/package/2021/cover-thumbnail-small`,
].map((type,i)=>`<Relationship Id="cover${i}" Target="/Auxiliaries/.thumbnails/custom%20cover.png" Type="${type}"/>`).join('')}<Relationship Id="notes" Target="/Auxiliaries/notes.txt" Type="urn:test:notes"/></Relationships>`);
const fixture = writeStoredZip([...parts,...aux]);
const audit = (bytes,label) => {
  verifyDesktopCover(bytes, png, label);
  const entries = readZipEntries(bytes);
  assert.deepEqual(verifyNativeProjectArchive(bytes).derivedArtifacts, [], label);
  const actual = entries.filter(e => e.name.startsWith('Auxiliaries/'));
  assert.deepEqual(actual.map(e=>e.name).sort(), aux.map(e=>e.name).sort(),label);
  for (const expected of aux) assert.equal(sha(actual.find(e=>e.name===expected.name).content),sha(expected.content),`${label}: ${expected.name}`);
  const relationships = text(entries,'_rels/.rels');
  assert.equal((relationships.match(/Target="\/Auxiliaries\/.thumbnails\/custom cover.png"/g)??[]).length,3,label);
  assert.match(relationships,/urn:test:notes/);
  assert.match(text(entries,'[Content_Types].xml'),/application\/x-test-opaque/);
  assert.match(text(entries,'[Content_Types].xml'),/Default Extension="txt" ContentType="text\/plain"/);
  assert.match(text(entries,'[Content_Types].xml'),/PartName="\/Auxiliaries\/percent%2520.bin" ContentType="application\/x-test-percent"/);
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
const deleteTx = ok(call('orc_history_begin',['string','string','string','string'],['Delete model','project',context,'']));
const ids = ok(call('orc_get_model_structure')).objects.map(object => object.id);
ok(call('orc_delete_objects',['string'],[JSON.stringify(ids)]));
call('orc_history_commit',['string','string'],[deleteTx.transactionId,context]);
assert.equal(ok(call('orc_get_model_structure')).objects.length,0);
audit(exportProject(),'save after deleting all models');
ok(call('orc_history_undo'));
assert.equal(ok(call('orc_get_model_structure')).objects.length,ids.length);
audit(exportProject(),'save after model-reconstructing Undo');
ok(call('orc_history_redo'));
assert.equal(ok(call('orc_get_model_structure')).objects.length,0);
audit(exportProject(),'save after model-deleting Redo');
ok(load(saved));
audit(exportProject(),'reopen and save again');
ok(load(bare,true));
audit(exportProject(),'geometry-only import preserves current attachments');
const standardOnly = parts.map(entry => entry.name === '_rels/.rels'
  ? { ...entry, content: enc(text(parts,entry.name).replace(/<Relationship[^>]*Type="http:\/\/schemas.bambulab.com\/package\/2021\/cover-thumbnail-(?:middle|small)"\/>/g,'')) }
  : entry);
ok(load(writeStoredZip([...standardOnly,...aux])));
audit(exportProject(),'standard-only custom cover remains the display cover');
const coverNames = ['custom cover.png', '中文封面.png', 'literal%20.png', '100%.png', '中文 & 100%25 封面.png'];
const coverParts = readZipEntries(bare);
for (const [index, name] of coverNames.entries()) for (const escaped of [false, true]) {
  const path = `Auxiliaries/.thumbnails/${name}`;
  const target = escaped ? path.split('/').map(encodeURIComponent).join('/') : path;
  const image = solidPng([30 + index * 40, 255 - index * 30, 100, 255]);
  const assets = [{ name: path, content: image }];
  try {
    const decoded = decodeURIComponent(path);
    if (decoded !== path) assets.push({ name: decoded, content: solidPng([0, 0, 0, 255]) });
  } catch {}
  const relationshipXml = `<?xml version="1.0"?><Relationships xmlns="${prefix}openxmlformats.org/package/2006/relationships"><Relationship Id="model" Target="/3D/3dmodel.model" Type="${prefix}microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${coverTypes.map((type,i) => `<Relationship Id="cover${i}" Target="/${xmlEscape(target)}" Type="${type}"/>`).join('')}</Relationships>`;
  ok(load(writeStoredZip([...coverParts.map(entry => entry.name === '_rels/.rels' ? { ...entry, content: enc(relationshipXml) } : entry), ...assets])));
  for (const pass of ['save', 'reopen']) {
    const output = exportProject();
    const entries = readZipEntries(output);
    assert.equal(text(entries, '_rels/.rels').split(`Target="/${xmlEscape(path)}"`).length - 1, 3);
    assert.deepEqual(entries.filter(entry => entry.name.startsWith('Auxiliaries/')).map(entry => entry.name).sort(), assets.map(asset => asset.name).sort());
    for (const asset of assets) assert.equal(sha(entries.find(entry => entry.name === asset.name).content), sha(asset.content));
    verifyDesktopCover(output, image, `${name} escaped=${escaped} ${pass}`);
    ok(load(output));
  }
  console.log(`PASS custom cover ${name}, escaped=${escaped}: literal target, exact bytes and repeated save`);
}
const separateCovers = ['标准 封面%20.png', '中文 中图100%25.png', '小图 100%.png'].map((name, i) => ({
  name: `Auxiliaries/.thumbnails/${name}`, content: solidPng([i * 100, 255 - i * 100, 40, 255]),
}));
const separateRelationships = `<?xml version="1.0"?><Relationships xmlns="${prefix}openxmlformats.org/package/2006/relationships"><Relationship Id="model" Target="/3D/3dmodel.model" Type="${prefix}microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${coverTypes.map((type,i) => `<Relationship Id="cover${i}" Target="/${separateCovers[i].name.split('/').map(encodeURIComponent).join('/')}" Type="${type}"/>`).join('')}</Relationships>`;
ok(load(writeStoredZip([...coverParts.map(entry => entry.name === '_rels/.rels' ? { ...entry, content: enc(separateRelationships) } : entry), ...separateCovers])));
for (const pass of ['save', 'reopen']) {
  const output = exportProject();
  const entries = readZipEntries(output);
  for (const cover of separateCovers) {
    assert.ok(text(entries, '_rels/.rels').includes(`Target="/${cover.name}"`));
    assert.equal(sha(entries.find(entry => entry.name === cover.name).content), sha(cover.content));
  }
  verifyDesktopCover(output, separateCovers[1].content, `distinct cover sizes ${pass}`);
  ok(load(output));
}
console.log('PASS distinct standard/middle/small covers retain their paths and desktop selects middle');
if (nativeReader) console.log(`PASS ${nativeReads} desktop Orca cover reads and PNG decodes`);
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
