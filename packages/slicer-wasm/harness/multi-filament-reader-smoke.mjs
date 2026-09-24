// Optional real-reader proof for the independently assembled Step 0 fixture.
// Run when a staged artifact is available:
// node harness/multi-filament-reader-smoke.mjs --module out/serial/orca_slice.js
// This uses only existing orc_init/orc_load_project APIs plus the Step 1
// read-only projection operation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let index = 2; index < argv.length; index += 2) opts[argv[index]?.replace(/^--/, '')] = argv[index + 1];
if (!opts.module) {
  console.error('usage: node multi-filament-reader-smoke.mjs --module out/{serial,threaded}/orca_slice.js [--profile-root path]');
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const fixturePath = resolve(repoRoot, 'packages/slicer-wasm/fixtures/multi-filament/independent-reader-basic.3mf');
const profileRoot = resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`);
const bytes = await readFile(fixturePath);
const factory = await loadModuleFactory(resolve(opts.module));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));

function callJson(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  const result = JSON.parse(Module.UTF8ToString(pointer));
  Module._free(pointer);
  return result;
}

const initialized = callJson('orc_init', ['string'], ['']);
assert.equal(initialized.ok, true, JSON.stringify(initialized));
const defaultSession = callJson('orc_get_filament_session_snapshot');
assert.equal(defaultSession.ok, true, JSON.stringify(defaultSession));
assert.equal(defaultSession.slots[0].preset.id, 'Generic PLA @System', JSON.stringify(defaultSession));
assert.equal(defaultSession.slots[0].colour.effective, '#26A69A', JSON.stringify(defaultSession));
assert.equal(defaultSession.slots[0].colour.provenance, 'preset', JSON.stringify(defaultSession));
assert.equal(defaultSession.flushing.plane_count, defaultSession.capabilities.nozzle_count, JSON.stringify(defaultSession));
const pointer = Number(Module._malloc(bytes.byteLength));
Module.HEAPU8.set(bytes, pointer);
const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
  [pointer, bytes.byteLength, 0, 'independent-reader-basic.3mf']);
Module._free(pointer);
assert.equal(loaded.ok, true, JSON.stringify(loaded));
assert.equal(loaded.mode, 'project', JSON.stringify(loaded));
assert.equal(loaded.objects, 1, JSON.stringify(loaded));
const session = callJson('orc_get_filament_session_snapshot');
assert.equal(session.ok, true, JSON.stringify(session));
assert.equal(session.version, 1, JSON.stringify(session));
assert.deepEqual(session.slots.map((slot) => slot.slot), [1, 2], JSON.stringify(session));
assert.deepEqual(session.slots.map((slot) => slot.colour.effective), ['#FF0000', '#00FF00'], JSON.stringify(session));
// The fixture imports project-local preset ids and explicit red/green colour
// overrides; the read-only native projection must preserve those effective
// values as user provenance. The default Generic PLA session above is the
// separate preset-equivalence assertion.
assert.deepEqual(session.slots.map((slot) => slot.colour.provenance), ['user', 'user'], JSON.stringify(session));
assert.deepEqual(session.mappings.filament, [1, 1], JSON.stringify(session));
assert.deepEqual(session.mappings.volume, [0, 0], JSON.stringify(session));
assert.deepEqual(session.mappings.nozzle, [0, 0], JSON.stringify(session));
assert.deepEqual(session.mappings.filament2, [1, 1], JSON.stringify(session));
assert.deepEqual(session.mappings.physical_extruder, [0], JSON.stringify(session));
assert.equal(session.flushing.matrix.length, 4, JSON.stringify(session));
assert.equal(session.flushing.plane_count, 1, JSON.stringify(session));
assert.equal(session.flushing.plane_count, session.capabilities.nozzle_count, JSON.stringify(session));
assert.equal(session.flushing.source, 'native', JSON.stringify(session));
assert.equal(session.assignments.objects.length, 1, JSON.stringify(session));
assert.equal(session.assignments.parts.length, 1, JSON.stringify(session));
assert.equal(session.assignments.objects[0].effective_slot, 2, JSON.stringify(session));
assert.equal(session.assignments.parts[0].effective_slot, 2, JSON.stringify(session));

// A multi-nozzle project can name two source filaments while native preset
// compatibility grows the active rack. Preserve the two saved plate mappings
// and fill only the new slots, as the Orca Plater does after preset loading.
const expandedEntries = readZipEntries(bytes);
const expandedProject = JSON.parse(new TextDecoder().decode(expandedEntries.find(
  (entry) => entry.name === 'Metadata/project_settings.config').content));
Object.assign(expandedProject, {
  single_extruder_multi_material: '0',
  nozzle_diameter: ['0.4', '0.4', '0.4', '0.4'],
  filament_diameter: ['1.75', '1.75'],
});
const expandedBytes = writeStoredZip(expandedEntries.map((entry) => entry.name === 'Metadata/project_settings.config'
  ? { name: entry.name, content: new TextEncoder().encode(JSON.stringify(expandedProject)) }
  : entry));
const expandedPointer = Number(Module._malloc(expandedBytes.byteLength));
Module.HEAPU8.set(expandedBytes, expandedPointer);
const expanded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
  [expandedPointer, expandedBytes.byteLength, 0, 'independent-expanded-rack.3mf']);
Module._free(expandedPointer);
assert.equal(expanded.ok, true, JSON.stringify(expanded));
const expandedSession = callJson('orc_get_filament_session_snapshot');
const expandedPlates = callJson('orc_get_plate_session_snapshot');
assert.equal(expandedSession.slots.length, 4, JSON.stringify(expandedSession));
assert.equal(expandedPlates.plates[0].settings.filament_map, '1,1,1,1', JSON.stringify(expandedPlates));
console.log(`multi-filament native reader smoke passed (objects=${loaded.objects}; slots=${session.slots.length}; object/part assignments=2)`);
