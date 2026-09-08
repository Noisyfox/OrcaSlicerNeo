// Optional real-reader proof for the independently assembled Step 0 fixture.
// Run when a staged artifact is available:
// node harness/multi-filament-reader-smoke.mjs --module out/serial/orca_slice.js
// This uses only existing orc_init/orc_load_project APIs. Slot-count and
// assignment assertions remain deferred to the later bridge contract step.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
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
const pointer = Number(Module._malloc(bytes.byteLength));
Module.HEAPU8.set(bytes, pointer);
const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
  [pointer, bytes.byteLength, 0, 'independent-reader-basic.3mf']);
Module._free(pointer);
assert.equal(loaded.ok, true, JSON.stringify(loaded));
assert.equal(loaded.mode, 'project', JSON.stringify(loaded));
assert.equal(loaded.objects, 1, JSON.stringify(loaded));
console.log(`multi-filament native reader smoke passed (objects=${loaded.objects}; slot assertions deferred to bridge contract)`);
