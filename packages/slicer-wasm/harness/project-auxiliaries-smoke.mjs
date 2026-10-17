// Native Orca attachment behavior across history, rollback and project replacement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const roundtripIndex = process.argv.indexOf('--native-roundtrip');
const nativeRoundtrip = roundtripIndex < 0 ? undefined : resolve(process.argv[roundtripIndex + 1]);
const readerDirectory = nativeReader || nativeRoundtrip ? mkdtempSync(resolve(tmpdir(), 'neo-cover-reader-')) : undefined;
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
const auxiliaryEntries = bytes => readZipEntries(bytes).filter(entry => entry.name.startsWith('Auxiliaries/'));
const xmlAttributes = attributes => Object.fromEntries([...attributes.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
const coverRelations = entries => [...text(entries, '_rels/.rels').matchAll(/<Relationship\b([^>]*)\/>/g)]
  .map(([, attributes]) => xmlAttributes(attributes))
  .filter(relation => /thumbnail/.test(relation.Type)).map(({ Type, Target }) => [Type, Target]).sort();
const contentTypes = (entries, assets) => [...text(entries, '[Content_Types].xml').matchAll(/<(Default|Override)\b([^>]*)\/>/g)]
  .map(([, kind, attributes]) => {
    const value = xmlAttributes(attributes);
    return [kind, value.Extension ?? value.PartName, value.ContentType];
  }).filter(([kind, name]) => assets.some(asset => kind === 'Default'
    ? asset.name.split('.').at(-1).toLowerCase() === name.toLowerCase()
    : asset.name === name.replace(/^\//, ''))).sort();
const nativeReference = (bytes, label) => {
  if (!nativeRoundtrip) return undefined;
  const input = resolve(readerDirectory, 'input.3mf'), output = resolve(readerDirectory, 'native.3mf');
  writeFileSync(input, bytes);
  const result = spawnSync(nativeRoundtrip, [input, output, readerDirectory,
    ...(process.argv.includes('--thumbnails') ? ['--thumbnails'] : [])], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${label}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return readZipEntries(readFileSync(output));
};
const auxiliaryDirectories = (path = '/tmp/orcaslicer_model') => {
  if (!Module.FS.analyzePath(path).exists) return [];
  return Module.FS.readdir(path).filter(name => name !== '.' && name !== '..').flatMap(name => {
    const child = `${path}/${name}`;
    if (!Module.FS.isDir(Module.FS.stat(child).mode)) return [];
    return name === 'Auxiliaries' ? [child] : auxiliaryDirectories(child);
  });
};
const auxiliaryDirectory = () => {
  const directories = auxiliaryDirectories();
  assert.equal(directories.length, 1, `one live native attachment directory: ${directories}`);
  return directories[0];
};
const noSidecar = () => assert.equal(Module.FS.readdir('/tmp').filter(name => name.endsWith('.aux.zip')).length, 0);
const assertReleased = directory => assert.equal(Module.FS.analyzePath(directory.slice(0, -'/Auxiliaries'.length)).exists, false);
const initOptions = fixtureProfileOptions(Module);
ok(call('orc_init', ['string'], [initOptions]));
ok(call('orc_add_shape', ['string','string'], ['Cube','Attachment test']));
const bare = exportProject();
const png = solidPng([255, 0, 255, 255]);
const aux = [
  { name:'Auxiliaries/说明/empty.txt', content: new Uint8Array() },
  { name:'Auxiliaries/说明/附件.bin', content: new Uint8Array([0,255,128,1,2,0]) },
  { name:'Auxiliaries/percent%20.bin', content: new Uint8Array([10,20,30]) },
  { name:'Auxiliaries/UPPER.TXT', content: enc('Case insensitive extension') },
  { name:'Auxiliaries/notes.txt', content: enc('Native attachment\r\n<&>\r\n') },
  { name:'Auxiliaries/empty-directory/', content: new Uint8Array() },
  { name:'Auxiliaries/.thumbnails/custom cover.png', content: png },
  { name:'Auxiliaries/.thumbnails/thumbnail_3mf.png', content: png },
];
const prefix = 'http://schemas.';
const coverTypes = [
  `${prefix}openxmlformats.org/package/2006/relationships/metadata/thumbnail`,
  `${prefix}bambulab.com/package/2021/cover-thumbnail-middle`,
  `${prefix}bambulab.com/package/2021/cover-thumbnail-small`,
];
const fixtureFor = (assets, targets, escaped = false) => {
  const parts = readZipEntries(bare);
  const types = parts.find(entry => entry.name === '[Content_Types].xml');
  types.content = enc(text(parts, types.name).replace('</Types>', '<Override PartName="/Auxiliaries/percent%2520.bin" ContentType="application/x-test-percent"/><Default Extension="txt" ContentType="text/plain"/><Override PartName="/Auxiliaries/说明/附件.bin" ContentType="application/x-test-opaque"/></Types>'));
  parts.find(entry => entry.name === '_rels/.rels').content = enc(`<?xml version="1.0"?><Relationships xmlns="${prefix}openxmlformats.org/package/2006/relationships"><Relationship Id="model" Target="/3D/3dmodel.model" Type="${prefix}microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${targets.map((target, i) => `<Relationship Id="cover${i}" Target="/${xmlEscape(escaped ? target.split('/').map(encodeURIComponent).join('/') : target)}" Type="${coverTypes[i]}"/>`).join('')}<Relationship Id="notes" Target="/Auxiliaries/notes.txt" Type="urn:test:notes"/></Relationships>`);
  return writeStoredZip([...parts, ...assets]);
};
const customPath = 'Auxiliaries/.thumbnails/custom cover.png';
const fixture = fixtureFor(aux, [customPath, customPath, customPath]);
const reference = nativeReference(fixture, 'main fixture');
const expectedAux = aux.filter(entry => entry.content.length > 0);
const audit = (bytes, label, directory) => {
  noSidecar();
  if (directory) assert.equal(auxiliaryDirectory(), directory, 'history retains the same native directory');
  verifyDesktopCover(bytes, png, label);
  const entries = readZipEntries(bytes);
  assert.deepEqual(verifyNativeProjectArchive(bytes).derivedArtifacts, [], label);
  const actual = auxiliaryEntries(bytes);
  assert.deepEqual(actual.map(entry => entry.name).sort(), expectedAux.map(entry => entry.name).sort(), label);
  for (const expected of expectedAux) assert.equal(sha(actual.find(entry => entry.name === expected.name).content), sha(expected.content), `${label}: ${expected.name}`);
  const relationships = text(entries, '_rels/.rels');
  assert.ok(!relationships.includes('urn:test:notes'));
  assert.ok(relationships.includes('Target="/Auxiliaries/.thumbnails/thumbnail_3mf.png"'));
  assert.equal(relationships.split(`Target="/${customPath}"`).length - 1, 2);
  assert.ok(!text(entries, '[Content_Types].xml').includes('application/x-test-'));
  assert.ok(!text(entries, '[Content_Types].xml').includes('text/plain'));
  if (reference) {
    assert.deepEqual(actual.map(entry => [entry.name, sha(entry.content)]).sort(), reference.filter(entry => entry.name.startsWith('Auxiliaries/')).map(entry => [entry.name, sha(entry.content)]).sort());
    assert.deepEqual(coverRelations(entries), coverRelations(reference));
    assert.deepEqual(contentTypes(entries, expectedAux), contentTypes(reference, expectedAux));
  }
  console.log(`PASS ${label}: native attachment files, cover and package metadata`);
  return bytes;
};
ok(load(fixture));
const directory = auxiliaryDirectory();
noSidecar();
assert.ok(!Module.FS.analyzePath(`${directory}/说明/empty.txt`).exists, 'native reader skips zero-byte files');
if (nativeTmp) {
  const diskPath = resolve(nativeTmp, directory.slice('/tmp/'.length), '说明/附件.bin');
  assert.equal(statSync(diskPath).size, 6);
  console.log('PASS native attachment directory is backed by the host temporary directory');
}
audit(exportProject(), 'immediate native save', directory);
const context = JSON.stringify({ selection:{mode:'object',objectIds:[],partIds:[],instanceIds:[]},activePlateId:null,gizmo:null,nativeScopedConfig:{} });
const begin = label => ok(call('orc_history_begin', ['string','string','string','string'], [label,'project',context,'']));
const commit = tx => call('orc_history_commit', ['string','string'], [tx.transactionId,context]);
const tx = begin('Edit project');
ok(setNativeScopedConfig(call, 'project', undefined, 'layer_height', '0.24'));
assert.equal(commit(tx).status.canUndo, true);
audit(exportProject(), 'save after parameter edit', directory);
ok(call('orc_history_undo'));
audit(exportProject(), 'save after parameter Undo', directory);
ok(call('orc_history_redo'));
const saved = audit(exportProject(), 'save after parameter Redo', directory);
const abort = begin('Abort scene clear');
ok(call('orc_clear_model'));
audit(exportProject(), 'save after Clear Scene', directory);
ok(call('orc_history_abort', ['string'], [abort.transactionId]));
audit(exportProject(), 'save after aborted scene clear', directory);
const deleteTx = begin('Delete model');
const ids = ok(call('orc_get_model_structure')).objects.map(object => object.id);
ok(call('orc_delete_objects', ['string'], [JSON.stringify(ids)]));
commit(deleteTx);
assert.equal(ok(call('orc_get_model_structure')).objects.length, 0);
audit(exportProject(), 'save after deleting all models', directory);
if (process.argv.includes('--history-failures')) assert.equal(typeof Module._orc_history_test_fail_next_restore, 'function');
for (const direction of ['undo','redo']) {
  if (process.argv.includes('--history-failures')) for (const stage of [1,2]) {
    const before = ok(call('orc_get_model_structure'));
    const history = call('orc_history_status');
    Module.ccall('orc_history_test_fail_next_restore', null, ['number'], [stage]);
    const failed = call(`orc_history_${direction}`);
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'restore-failed');
    assert.match(failed.error.message, /injected history (reconciliation|publication) failure/);
    assert.deepEqual(ok(call('orc_get_model_structure')), before);
    assert.deepEqual(call('orc_history_status'), history);
    audit(exportProject(), `save after failed ${direction} stage ${stage}`, directory);
  }
  ok(call(`orc_history_${direction}`));
  assert.equal(ok(call('orc_get_model_structure')).objects.length, direction === 'undo' ? ids.length : 0);
  audit(exportProject(), `save after model-reconstructing ${direction}`, directory);
}
ok(load(saved));
assertReleased(directory);
const reopenedDirectory = auxiliaryDirectory();
audit(exportProject(), 'reopen and save again', reopenedDirectory);
ok(load(fixtureFor([{ name: 'Auxiliaries/foreign.txt', content: enc('another project') }], []), true));
audit(exportProject(), 'geometry-only import retains project attachments', reopenedDirectory);
const route = (slot, inject_failure_stage) => call('orc_set_filament_routing', ['string'], [JSON.stringify({
  version: 1, revision: call('orc_get_filament_session_snapshot').revisions.session,
  selector: 'support-base', slot, targets: [{ kind: 'project', id: 0 }], inject_failure_stage,
})]);
ok(route(1));
audit(exportProject(), 'save after filament routing replaces Model', reopenedDirectory);
const routedModel = ok(call('orc_get_model_structure'));
const failedRouting = route(0, 'during-history');
assert.equal(failedRouting.ok, false);
assert.match(failedRouting.error, /injected history commit failure/);
assert.deepEqual(ok(call('orc_get_model_structure')), routedModel);
audit(exportProject(), 'save after failed filament routing publication', reopenedDirectory);
ok(call('orc_history_undo'));
audit(exportProject(), 'save after routing Undo', reopenedDirectory);
ok(call('orc_history_redo'));
audit(exportProject(), 'save after routing Redo', reopenedDirectory);
if (process.argv.includes('--history-failures')) {
  ok(call('orc_open_setup_wizard_catalogue'));
  ok(call('orc_prepare_profile_activation', ['string'], [JSON.stringify({
    activation: JSON.parse(initOptions).profile_activation,
    remembered_filament_racks: {}, remembered_bed_types: {},
  })]));
  ok(call('orc_test_inject_profile_activation_failure'));
  const failed = call('orc_apply_profile_activation');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /injected activation publication failure/);
  audit(exportProject(), 'save after failed profile activation publication', reopenedDirectory);
  ok(call('orc_close_setup_wizard_catalogue'));
}
if (!process.argv.includes('--lifecycle-only')) {
  for (const name of ['custom cover.png', '中文封面.png', 'literal%20.png', '100%.png', '中文 & 100%25 封面.png']) {
    const path = `Auxiliaries/.thumbnails/${name}`;
    const assets = [{ name: path, content: png }];
    for (const escaped of [false, true]) {
      const fixture = fixtureFor(assets, [path, path, path], escaped);
      const native = nativeReference(fixture, name);
      const previous = auxiliaryDirectory();
      ok(load(fixture));
      assertReleased(previous);
      for (const pass of ['save','reopen']) {
        const output = exportProject();
        const entries = readZipEntries(output);
        assert.deepEqual(auxiliaryEntries(output).map(entry => [entry.name, sha(entry.content)]), [[path, sha(png)]]);
        if (native) assert.deepEqual(coverRelations(entries), coverRelations(native), `${name} escaped=${escaped} ${pass}`);
        if (!escaped) verifyDesktopCover(output, png, name);
        const previous = auxiliaryDirectory();
        ok(load(output));
        assertReleased(previous);
      }
      console.log(`PASS ${name} escaped=${escaped}: native cover behavior after repeated saves`);
    }
  }
  const standardOnly = fixtureFor(aux, [customPath]);
  const standardNative = nativeReference(standardOnly, 'standard-only cover');
  ok(load(standardOnly));
  const standardOutput = exportProject();
  if (standardNative) assert.deepEqual(coverRelations(readZipEntries(standardOutput)), coverRelations(standardNative));
  console.log('PASS standard-only cover follows native relationship regeneration');
}
const second = fixtureFor([{ name: 'Auxiliaries/project-B.txt', content: enc('Project B') }], []);
const previous = auxiliaryDirectory();
ok(load(second));
assertReleased(previous);
assert.deepEqual(auxiliaryEntries(exportProject()).map(entry => entry.name), ['Auxiliaries/project-B.txt']);
const secondDirectory = auxiliaryDirectory();
ok(load(bare));
assertReleased(secondDirectory);
assert.equal(auxiliaryEntries(exportProject()).length, 0);
ok(load(fixture));
const closing = auxiliaryDirectory();
ok(call('orc_close_project'));
assertReleased(closing);
assert.equal(auxiliaryEntries(exportProject()).length, 0);
ok(load(fixture));
const failing = auxiliaryDirectory();
ok(call('orc_test_inject_project_commit_failure'));
const failedProject = load(second);
assert.deepEqual(failedProject, { error: 'injected project commit failure after publication' });
assertReleased(failing);
assert.equal(auxiliaryDirectories().length, 0, 'failed publication releases the incoming attachment directory');
assert.equal(auxiliaryEntries(exportProject()).length, 0);
ok(load(fixture));
const invalidated = auxiliaryDirectory();
assert.notEqual(load(enc('invalid 3mf')).ok, true);
assertReleased(invalidated);
assert.equal(auxiliaryDirectories().length, 0);
assert.equal(auxiliaryEntries(exportProject()).length, 0);
ok(call('orc_close_project'));
assert.equal(auxiliaryDirectories().length, 0);
noSidecar();
if (nativeTmp) assert.equal(readdirSync(nativeTmp).filter(name => name.endsWith('.aux.zip')).length, 0);
if (nativeReader) console.log(`PASS ${nativeReads} desktop Orca cover reads and PNG decodes`);
console.log('PASS project replacement, close and failed loads release native attachment directories');
process.exit(0);
