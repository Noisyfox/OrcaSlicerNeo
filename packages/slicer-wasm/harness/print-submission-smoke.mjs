// Inspect real dispatch archives, material identities and retained-result guards.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fixtureProfileOptions, createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { readZipEntries } from './native-3mf-parser.mjs';
import { callAsyncTask } from './async-task-mailbox.mjs';
import { createNozzleMappingFixture } from './nozzle-mapping-fixtures.mjs';

if (!process.argv[2]) throw new Error('usage: node print-submission-smoke.mjs <module>');
const modulePath = resolve(process.argv[2]);
const Module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
const call = (name, types = [], args = []) => {
  const p = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(p)); } finally { Module._free(p); }
};
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
ok(call('orc_init', ['string'], [fixtureProfileOptions(Module)]));
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Dispatch test']));
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
const dualXml = new TextDecoder().decode(dualEntries.get('Metadata/slice_info.config'));
assert.match(dualXml, /O1D/);
assert.match(dualXml, /<nozzle /);
console.log(JSON.stringify({ ok: true, h2d: dualOutput.manifest }));
process.exit(0);
