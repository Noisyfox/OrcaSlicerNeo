import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { metadataEntry } from './native-3mf-parser.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const modulePath = argv[2];
if (!modulePath) throw new Error('usage: node step6-64-persistence-diagnostic.mjs <module>');
const repoRoot = resolve(import.meta.dirname, '../../..');
const factory = await loadModuleFactory(resolve(modulePath));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(repoRoot, 'packages/profile-resources/dist')));
function callJson(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  const result = JSON.parse(Module.UTF8ToString(pointer)); Module._free(pointer); return result;
}
function request(name, body) { return callJson(name, ['string'], [JSON.stringify(body)]); }
function readBytes(pointer, length) {
  const bytes = Module.HEAPU8.slice(Number(pointer), Number(pointer) + Number(length));
  Module._free(Number(pointer)); return bytes;
}
let init = callJson('orc_init', ['string'], ['']); assert.equal(init.ok, true, JSON.stringify(init));
const presets = callJson('orc_get_preset_snapshot');
const printer = presets.printers.find((entry) => /Bambu Lab P1P 0\.4 nozzle/.test(entry.name)) ?? presets.printers.find((entry) => /Bambu Lab/.test(entry.name));
assert.ok(printer); assert.equal(callJson('orc_select_preset', ['string', 'string'], ['printer', printer.name]).ok, true);
let snapshot = callJson('orc_get_filament_session_snapshot');
for (let count = 1; count < 64; count++) snapshot = request('orc_add_filament_slot', { version: 1, revision: snapshot.revisions.session }).result.snapshot;
assert.equal(snapshot.slots.length, 64);
const exported = callJson('orc_export_project'); assert.equal(exported.ok, true, JSON.stringify(exported));
const bytes = readBytes(exported.bytes_ptr, exported.bytes_length);
const sidecar = metadataEntry(bytes, 'Metadata/orca_neo_filament_state_v1.json');
assert.equal(sidecar?.state?.filament_presets?.length, 64, 'writer must preserve all 64 ordered presets');
const vectorLength = (value) => Array.isArray(value)
  ? value.length : String(value ?? '').split(/[,\s]+/).filter(Boolean).length;
assert.equal(vectorLength(sidecar.state.project_config.filament_map), 64);
assert.equal(vectorLength(sidecar.state.project_config.flush_volumes_matrix), 4096);
function loadProject(mode, displayName) {
  const pointer = Module._malloc(bytes.length); Module.HEAPU8.set(bytes, pointer);
  const result = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [pointer, bytes.length, mode, displayName]);
  Module._free(pointer); return result;
}
const geometry = loadProject(1, 'capacity-64-geometry.3mf');
assert.equal(Boolean(geometry.ok), false, 'geometry-only import must reject an empty project');
const project = loadProject(0, 'capacity-64-project.3mf');
assert.equal(project.ok, true, JSON.stringify(project));
const restored = callJson('orc_get_filament_session_snapshot');
assert.equal(restored.slots.length, 64, JSON.stringify(restored));
assert.equal(restored.flushing.matrix.length, 4096, JSON.stringify(restored.flushing));
assert.equal(restored.flushing.plane_count, restored.capabilities.nozzle_count);
assert.deepEqual(restored.slots.map((entry) => entry.slot), Array.from({ length: 64 }, (_, index) => index + 1));
console.log(JSON.stringify({ bytes: bytes.length, geometry, project,
  restored: { slots: restored.slots.length, matrix: restored.flushing.matrix.length,
    plane_count: restored.flushing.plane_count } }, null, 2));
