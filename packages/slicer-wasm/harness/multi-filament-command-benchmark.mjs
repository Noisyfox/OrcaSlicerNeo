// Warmed single-command latency benchmark for real Step 2 filament mutations.
// node harness/multi-filament-command-benchmark.mjs --module out/serial/orca_slice.js
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let index = 2; index < argv.length; index += 2) opts[argv[index]?.replace(/^--/, '')] = argv[index + 1];
if (!opts.module) {
  console.error('usage: node multi-filament-command-benchmark.mjs --module out/serial/orca_slice.js');
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const profileRoot = resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`);
const factory = await loadModuleFactory(resolve(opts.module));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));

function callJson(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  const result = JSON.parse(Module.UTF8ToString(pointer));
  Module._free(pointer);
  return result;
}
function request(name, body) {
  return callJson(name, ['string'], [JSON.stringify(body)]);
}
function initFlexible() {
  assert.equal(callJson('orc_init', ['string'], ['']).ok, true);
  const presets = callJson('orc_get_preset_snapshot');
  const printer = presets.printers.find((entry) => /Bambu Lab P1P 0\.4 nozzle/.test(entry.name))
    ?? presets.printers.find((entry) => /Bambu Lab/.test(entry.name));
  assert.ok(printer, 'profile set must expose a Bambu flexible printer');
  assert.equal(callJson('orc_select_preset', ['string', 'string'], ['printer', printer.name]).ok, true);
  const snapshot = callJson('orc_get_filament_session_snapshot');
  assert.equal(snapshot.capabilities.flexible, true, JSON.stringify(snapshot));
  return snapshot;
}
function add(snapshot) {
  const started = performance.now();
  const result = request('orc_add_filament_slot', { version: 1, revision: snapshot.revisions.session });
  const elapsedMs = performance.now() - started;
  assert.equal(result.ok, true, JSON.stringify(result));
  return { snapshot: result.result.snapshot, elapsedMs };
}
function remove(snapshot, slot) {
  const started = performance.now();
  const result = request('orc_delete_filament_slot', { version: 1, revision: snapshot.revisions.session, slot });
  const elapsedMs = performance.now() - started;
  assert.equal(result.ok, true, JSON.stringify(result));
  return { snapshot: result.result.snapshot, elapsedMs };
}

let snapshot = initFlexible();
// Warm the preset/config and history paths before recording command timings.
snapshot = add(snapshot).snapshot;
snapshot = add(snapshot).snapshot;
snapshot = remove(snapshot, 1).snapshot;

const samples = [];
for (let index = 0; index < 3; index += 1) {
  const added = add(snapshot);
  snapshot = added.snapshot;
  const deleted = remove(snapshot, 1);
  snapshot = deleted.snapshot;
  samples.push({ addMs: added.elapsedMs, deleteMs: deleted.elapsedMs, slots: snapshot.slots.length });
}

const values = samples.flatMap(({ addMs, deleteMs }) => [addMs, deleteMs]);
const summary = {
  module: opts.module,
  samples,
  maxMs: Math.max(...values),
  medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)],
};
console.log(JSON.stringify(summary, null, 2));
if (opts['assert-under-ms'] !== undefined && summary.maxMs >= Number(opts['assert-under-ms'])) {
  throw new Error(`warmed Add/Delete max ${summary.maxMs.toFixed(1)}ms is not below ${opts['assert-under-ms']}ms`);
}
