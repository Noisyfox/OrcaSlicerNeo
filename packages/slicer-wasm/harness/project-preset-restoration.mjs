// Regression harness for parentless project machine presets.
//
// The archive is assembled in memory from the committed native project
// fixture.  It intentionally does not contain any user project bytes: the
// only machine metadata is the deterministic P1P/0.4 record below.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';

const opts = {};
for (let i = 2; i < argv.length; i += 2) opts[argv[i]?.replace(/^--/, '')] = argv[i + 1];
if (!opts.module) {
  console.error('usage: node project-preset-restoration.mjs --module out/{serial,threaded}/orca_slice.js');
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const fixturePath = resolve(repoRoot, 'packages/slicer-wasm/fixtures/native-interoperability/orca-native-multi-plate.3mf');
const source = await readFile(fixturePath);
const entries = readZipEntries(source);
const projectEntry = entries.find((entry) => entry.name === 'Metadata/project_settings.config');
if (!projectEntry) throw new Error('native fixture has no project settings entry');

const project = JSON.parse(new TextDecoder().decode(projectEntry.content));
Object.assign(project, {
  printer_settings_id: 'Bambu Lab P1P 0.4 nozzle(parentless-fixture.3mf)',
  print_settings_id: '0.20mm Standard @BBL P1P(parentless-fixture.3mf)',
  filament_settings_id: ['Bambu PLA Basic @BBL P1P(parentless-fixture.3mf)'],
  printer_model: 'Bambu Lab P1P',
  printer_variant: '0.4',
  printer_technology: 'FFF',
  nozzle_diameter: ['0.4'],
});

const machine = { ...project,
  printer_settings_id: 'Bambu Lab P1P 0.4 nozzle(parentless-fixture.3mf)',
  inherits: '',
  from: 'project',
};
const process = { ...project,
  print_settings_id: '0.20mm Standard @BBL P1P(parentless-fixture.3mf)',
  inherits: '',
  from: 'project',
};
const filament = { ...project,
  filament_settings_id: ['Bambu PLA Basic @BBL P1P(parentless-fixture.3mf)'],
  inherits: '',
  from: 'project',
};
const encoder = new TextEncoder();
const fixture = writeStoredZip([
  ...entries.filter((entry) => entry.name !== 'Metadata/machine_settings_1.config'),
  { name: 'Metadata/project_settings.config', content: encoder.encode(JSON.stringify(project)) },
  { name: 'Metadata/process_settings_1.config', content: encoder.encode(JSON.stringify(process)) },
  { name: 'Metadata/filament_settings_1.config', content: encoder.encode(JSON.stringify(filament)) },
  { name: 'Metadata/machine_settings_1.config', content: encoder.encode(JSON.stringify(machine)) },
]);

const factory = await loadModuleFactory(resolve(opts.module));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`)));

function callJson(name, types = [], args = []) {
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
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

let failures = 0;
check('initialise real module', callJson('orc_init', ['string'], ['']).ok === true);
const before = callJson('orc_get_preset_snapshot');
const ptr = writeBytes(fixture);
const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
  [ptr, fixture.length, 0, 'parentless-fixture.3mf']);
Module._free(ptr);
const after = loaded.preset_snapshot;
const selectedNames = [after?.printer?.name, after?.print?.name];
check('parentless project load succeeds', loaded.ok === true && loaded.mode === 'project',
  JSON.stringify({ ok: loaded.ok, mode: loaded.mode, error: loaded.error }));
check('printer selection uses the project machine ID', after?.printer?.name ===
  'Bambu Lab P1P 0.4 nozzle(parentless-fixture.3mf)(parentless-fixture.3mf)', selectedNames.join(' | '));
check('process selection follows the same project load',
  after?.print?.name !== before?.print?.name &&
  after?.print?.name && Array.isArray(after?.filament_catalog),
  selectedNames.join(' | '));
check('selection changed from the pre-load tuple', JSON.stringify(before.printer) !== JSON.stringify(after?.printer));

if (failures) {
  console.error(`project preset restoration failed: ${failures} check(s)`);
  process.exitCode = 1;
} else {
  console.log('project preset restoration OK');
}
