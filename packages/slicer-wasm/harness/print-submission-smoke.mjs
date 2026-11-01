// Inspect real dispatch archives, material identities and retained-result guards.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { fixtureProfileOptions, createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { readZipEntries } from './native-3mf-parser.mjs';
import { callAsyncTask } from './async-task-mailbox.mjs';
import { createNozzleMappingFixture } from './nozzle-mapping-fixtures.mjs';

function pickingIds(bytes) {
  const png = Buffer.from(bytes), chunks = [];
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(png[24], 8); assert.equal(png[25], 6);
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * 4, pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) {
    const a = x >= 4 ? pixels[y * stride + x - 4] : 0;
    const b = y ? pixels[(y - 1) * stride + x] : 0, c = y && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    const predictors = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c];
    pixels[y * stride + x] = (raw[y * (stride + 1) + x + 1] + predictors[raw[y * (stride + 1)]]) & 255;
  }
  const ids = new Set(), centres = new Map();
  for (let p = 0; p < pixels.length; p += 4) {
    const id = pixels[p] | pixels[p + 1] << 8 | pixels[p + 2] << 16;
    if (id) {
      ids.add(id);
      const point = centres.get(id) ?? { x: 0, y: 0, count: 0 };
      point.x += p / 4 % width; point.y += Math.floor(p / 4 / width); point.count++;
      centres.set(id, point);
    }
  }
  assert.deepEqual([width, height], [512, 512]);
  for (const point of centres.values()) { point.x /= point.count; point.y /= point.count; }
  return { ids, centres };
}

function verifyObjects(entries, gcodePath, count, positioned = false) {
  const xml = new TextDecoder().decode(entries.get('Metadata/slice_info.config'));
  const ids = [...xml.matchAll(/<object identify_id="(\d+)"/g)].map(m => Number(m[1]));
  assert.equal(ids.length, count, 'one archive object per printed instance');
  assert.equal(new Set(ids).size, count, 'instance labels are unique');
  const image = entries.get('Metadata/pick_1.png');
  assert.ok(image, 'normalized single-plate picking image exists');
  const decoded = pickingIds(image);
  assert.deepEqual(decoded.ids, new Set(ids), 'lossless pixels encode exactly the archive instance IDs');
  if (positioned) {
    assert.ok(decoded.centres.get(ids[0]).x < decoded.centres.get(ids[1]).x, 'left instance retains its identity');
    assert.ok(decoded.centres.get(ids[0]).y > decoded.centres.get(ids[1]).y, 'PNG top-down Y agrees with the instance positions');
  }
  const model = new TextDecoder().decode(entries.get('Metadata/model_settings.config'));
  assert.match(model, /Metadata\/pick_1.png/);
  assert.match(xml, /key="index" value="1"/);
  if (gcodePath) {
    const gcode = new TextDecoder().decode(entries.get(gcodePath));
    const labels = gcode.match(/; model label id: ([\d,]+)/);
    assert.ok(labels, 'Bambu G-code includes model labels');
    assert.deepEqual(new Set(labels[1].split(',').map(Number)), new Set(ids), 'G-code and archive IDs agree');
  }
}

async function saveObjectResources(entries, count, name) {
  if (!process.argv[3]) return;
  const directory = resolve(process.argv[3], name); await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'case.json'), JSON.stringify({ count }));
  for (const path of ['Metadata/slice_info.config', 'Metadata/pick_1.png']) await writeFile(resolve(directory, path.split('/').at(-1)), entries.get(path));
}

if (!process.argv[2]) throw new Error('usage: node print-submission-smoke.mjs <module> [object-resource-output-directory]');
const modulePath = resolve(process.argv[2]);
const Module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
const call = (name, types = [], args = []) => {
  const p = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(p)); } finally { Module._free(p); }
};
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
ok(call('orc_init', ['string'], [fixtureProfileOptions(Module)]));
ok(call('orc_select_preset', ['string', 'string'], ['printer', 'Bambu Lab A1 mini 0.4 nozzle']));
const secondPlate = ok(call('orc_add_plate'));
const origin = secondPlate.plates.find(p => p.plate_id === secondPlate.current_plate_id).origin;
const added = ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Dispatch test']));
const restZ = added.plate_session.instance_transforms[0].world_transform.offset[2];
const geometry = ok(call('orc_get_model_mesh'));
const volumeTransform = geometry.renderables[0].volume_transform;
for (const mesh of geometry.geometries) { Module._free(Number(mesh.vertex_ptr)); Module._free(Number(mesh.index_ptr)); }
const object = ok(call('orc_get_model_structure')).objects[0];
ok(call('orc_add_instance', ['number'], [object.id]));
for (let i = 0; i < 2; i++) ok(call('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'],
  [0, 0, i, JSON.stringify({ offset: [origin[0] + 70 + i * 50, origin[1] + 70 + i * 30, restZ], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] }), JSON.stringify(volumeTransform)]));
const session = ok(call('orc_get_plate_session_snapshot'));
const plateId = session.current_plate_id;
const slice = () => callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'],
  ['{}', plateId, call('orc_get_plate_session_snapshot').input_revisions[plateId]]);
const first = ok(await slice());
const request = receipt => JSON.stringify({ receipt: { ...receipt, result_generation: Number(receipt.result_generation) }, filename_base: 'Print test' });
const describe = receipt => call('orc_describe_print_plate', ['string'], [request(receipt)]);
const exported = receipt => call('orc_export_print_plate', ['string'], [request(receipt)]);
const manifest = ok(describe(first.receipt)).manifest;
assert.equal(manifest.plateId, plateId);
assert.equal(manifest.materials.length, 1);
assert.equal(manifest.materials[0].index, 0);
assert.equal(manifest.materials[0].toolIndex, 0);
assert.ok(manifest.materials[0].usedGrams > 0);
assert.ok(manifest.durationSeconds > 0);
const gcode = ok(call('orc_export_gcode_plate', ['string'], [request(first.receipt)]));
const before = Module.FS.readFile(gcode.path);
const packaged = ok(exported(first.receipt));
assert.deepEqual(packaged.manifest, manifest);
assert.match(packaged.file_name, /^Print test.*\.gcode\.3mf$/);
assert.equal(packaged.plate_index, 1);
const archive = new Map(readZipEntries(Module.FS.readFile(packaged.path)).map(e => [e.name, e.content]));
const configuration = new Map(readZipEntries(Module.FS.readFile(packaged.config_path)).map(e => [e.name, e.content]));
assert.deepEqual(archive.get(packaged.gcode_path), before, 'archive embeds the exact retained G-code');
assert.ok(archive.has('Metadata/slice_info.config'));
assert.ok(configuration.has('Metadata/slice_info.config'));
assert.deepEqual(archive.get('Metadata/slice_info.config'), configuration.get('Metadata/slice_info.config'));
verifyObjects(archive, packaged.gcode_path, 2, true);
verifyObjects(configuration, null, 2, true);
await saveObjectResources(archive, 2, 'two-instances');
assert.deepEqual(archive.get('Metadata/pick_1.png'), configuration.get('Metadata/pick_1.png'));
assert.equal(manifest.nozzleFlowTypes.length, manifest.nozzleDiameters.length);
assert.ok(manifest.layerCount > 0);
assert.ok(!configuration.has(packaged.gcode_path), 'Cloud configuration archive does not duplicate G-code');
assert.deepEqual(Module.FS.readFile(gcode.path), before, 'packing does not regenerate G-code');
const xml = new TextDecoder().decode(archive.get('Metadata/slice_info.config'));
assert.match(xml, /<filament /);
assert.match(xml, /id="1"/);
Module.FS.unlink(packaged.path);
Module.FS.unlink(packaged.config_path);
ok(await slice());
assert.equal(describe(first.receipt).status, 'stale');
assert.equal(exported(first.receipt).status, 'stale');
console.log(JSON.stringify({ ok: true, modulePath, manifest, entries: [...archive.keys()] }));
// Exercise inclusive 64-bit masks with actual sliced instances; 65 remains
// catalogued for visibility but cannot authorize a provider skip command.
let instanceCount = 2;
for (const count of [63, 64, 65]) {
  while (instanceCount < count) { ok(call('orc_add_instance', ['number'], [object.id])); instanceCount++; }
  for (let i = 0; i < count; i++) ok(call('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'],
    [0, 0, i, JSON.stringify({ offset: [origin[0] + 40 + i % 9 * 10, origin[1] + 40 + Math.floor(i / 9) * 10, restZ * 0.1], rotation: [0, 0, 0], scale: [0.1, 0.1, 0.1], mirror: [1, 1, 1] }), JSON.stringify(volumeTransform)]));
  const boundary = ok(exported(ok(await slice()).receipt));
  const entries = new Map(readZipEntries(Module.FS.readFile(boundary.path)).map(e => [e.name, e.content]));
  verifyObjects(entries, boundary.gcode_path, count);
  if (count <= 64) {
    const gcode = new TextDecoder().decode(entries.get(boundary.gcode_path)); let mask = 0n;
    for (const match of gcode.matchAll(/^M624 ([A-Za-z0-9+/=]+)$/gm)) {
      const encoded = Buffer.from(match[1], 'base64'); assert.equal(encoded.length, 8); mask |= encoded.readBigUInt64LE();
    }
    assert.equal(mask, (1n << BigInt(count)) - 1n, `all ${count} distinct instance bits are encoded without truncation`);
  }
  await saveObjectResources(entries, count, `boundary-${count}`);
  Module.FS.unlink(boundary.path); Module.FS.unlink(boundary.config_path);
  console.log(JSON.stringify({ ok: true, objectCount: count, inclusiveMaskVerified: count <= 64 }));
}

// Fixed H2D tools must keep native material indices and nozzle assignments.
const dual = await createNozzleMappingFixture(modulePath);
dual.configure({ plate_settings: { [dual.plateId]: { filament_map_mode: 'Manual', filament_map: '2,1' } } });
const dualSlice = dual.ok(await callAsyncTask(dual.call, 'orc_slice_plate', ['string', 'string', 'number'],
  ['{}', dual.plateId, dual.call('orc_get_plate_session_snapshot').input_revisions[dual.plateId]]));
const dualOutput = dual.ok(dual.command('orc_export_print_plate', JSON.parse(request(dualSlice.receipt))));
assert.equal(dualOutput.manifest.printerModelId, 'O1D');
assert.equal(dualOutput.manifest.requiresDynamicMapping, false);
assert.equal(dualOutput.manifest.nozzleDiameters.length, 2);
for (const material of dualOutput.manifest.materials)
  assert.equal(material.toolIndex, dualOutput.manifest.filamentMap[material.index] - 1);
assert.deepEqual(new Set(dualOutput.manifest.materials.map(m => m.toolIndex)), new Set([0, 1]));
const dualEntries = new Map(readZipEntries(dual.Module.FS.readFile(dualOutput.path)).map(e => [e.name, e.content]));
const dualObjectCount = dual.ok(dual.call('orc_get_model_structure')).objects
  .reduce((count, object) => count + object.instances.filter(instance => instance.printable).length, 0);
assert.ok(dualObjectCount > 0);
verifyObjects(dualEntries, dualOutput.gcode_path, dualObjectCount);
await saveObjectResources(dualEntries, dualObjectCount, 'loaded-h2d');
const dualGcode = new TextDecoder().decode(dualEntries.get(dualOutput.gcode_path));
// Fixed H2D nozzle assignments must not request a Filament Track Switch.
assert.match(dualGcode, /^M620 S\d+A H-1(?:[ ;]|$)/m);
assert.doesNotMatch(dualGcode, /^(?:M620 S\d+A|T\d+) H\d+(?:[ ;]|$)/m);
const dualXml = new TextDecoder().decode(dualEntries.get('Metadata/slice_info.config'));
assert.match(dualXml, /O1D/);
assert.match(dualXml, /<nozzle /);
console.log(JSON.stringify({ ok: true, h2d: dualOutput.manifest }));
const converted = dual.ok(dual.command('orc_export_print_plate', { ...JSON.parse(request(dualSlice.receipt)), material_catalog_ids: dualOutput.manifest.materials.map(m => ({materialKey: m.key, catalogId: 'GFA00'})) }));
const convertedXml = new TextDecoder().decode(new Map(readZipEntries(dual.Module.FS.readFile(converted.path)).map(e => [e.name, e.content])).get('Metadata/slice_info.config'));
assert.match(convertedXml, /GFA00/);
assert.deepEqual(converted.manifest, dualOutput.manifest);
dual.configure({ plate_settings: { [dual.plateId]: { filament_map_mode: 'Auto For Flush' } } });
const automaticSlice = dual.ok(await callAsyncTask(dual.call, 'orc_slice_plate', ['string', 'string', 'number'], ['{}', dual.plateId, dual.call('orc_get_plate_session_snapshot').input_revisions[dual.plateId]]));
const automatic = dual.ok(dual.command('orc_describe_print_plate', JSON.parse(request(automaticSlice.receipt)))).manifest;
assert.equal(automatic.requiresDynamicMapping, false);
for (const material of automatic.materials) assert.equal(material.toolIndex, automatic.filamentMap[material.index] - 1);
console.log(JSON.stringify({ ok: true, automaticFixedTools: automatic.filamentMap }));
process.exit(0);
