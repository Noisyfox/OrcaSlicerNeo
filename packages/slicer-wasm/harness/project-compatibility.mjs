// Real WASM compatibility gate for the pinned Orca/Bambu/Prusa fixtures.
// Run once per production wasm64 variant after fixture acquisition.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let i = 2; i < argv.length; i += 2) opts[argv[i]?.replace(/^--/, '')] = argv[i + 1];
const modulePath = opts.module;
if (!modulePath) {
  console.error('usage: node project-compatibility.mjs --module out/orca_slice.js [--fixture-root path] [--profile-root path]');
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(opts['fixture-root'] ?? `${repoRoot}/packages/slicer-wasm/fixtures/project-compatibility`);
const profileRoot = resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`);
const manifest = JSON.parse(await readFile(resolve(fixtureRoot, 'manifest.json'), 'utf8'));
const factory = await loadModuleFactory(modulePath);
const Module = await factory({ noInitialRun: true, print: console.error, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));

function callJson(name, types, args) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const text = Module.UTF8ToString(ptr);
  Module._free(ptr);
  return JSON.parse(text);
}
function writeBytes(bytes) {
  const ptr = Number(Module._malloc(bytes.byteLength));
  Module.HEAPU8.set(bytes, ptr);
  return ptr;
}

let failures = 0;
const check = (label, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
};
check('initialise real module', callJson('orc_init', ['string'], ['']).ok === true);

for (const fixture of manifest.fixtures) {
  const bytes = await readFile(resolve(fixtureRoot, fixture.filename));
  callJson('orc_clear_model', [], []);
  const ptr = writeBytes(bytes);
  const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [ptr, bytes.length, 0, fixture.filename]);
  Module._free(ptr);
  check(`${fixture.id} opens as project`, loaded.ok === true && loaded.mode === 'project' && loaded.objects > 0,
    JSON.stringify({ ok: loaded.ok, mode: loaded.mode, objects: loaded.objects, error: loaded.error }));
  check(`${fixture.id} reports compatibility`, loaded.compatibility === fixture.expected_compatibility
    && loaded.project_settings_available === fixture.expected_project_settings,
    JSON.stringify({ compatibility: loaded.compatibility, projectSettingsAvailable: loaded.project_settings_available }));

  callJson('orc_clear_model', [], []);
  const geometryPtr = writeBytes(bytes);
  const geometry = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [geometryPtr, bytes.length, 1, fixture.filename]);
  Module._free(geometryPtr);
  check(`${fixture.id} geometry-only import succeeds`, geometry.ok === true && geometry.mode === 'geometry-only' && geometry.objects > 0,
    JSON.stringify({ ok: geometry.ok, mode: geometry.mode, objects: geometry.objects, error: geometry.error }));
}

if (failures) {
  console.error(`project compatibility failed: ${failures} check(s)`);
  process.exitCode = 1;
} else {
  console.log('project compatibility OK: Orca, BambuStudio, and Prusa/generic fixtures');
}
