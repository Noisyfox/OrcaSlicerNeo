// Real Orca naming contract, independent of Electron/Web save UI.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: node gcode-filename-smoke.mjs <out/orca_slice.js>');
const factory = await loadModuleFactory(modulePath);
const Module = await factory({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
function ok(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
const session = () => ok(call('orc_get_plate_session_snapshot'));
async function slice(format, plateId = session().current_plate_id) {
  const config = format === undefined ? {} : { filename_format: format };
  return ok(await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'],
    [JSON.stringify(config), plateId, session().input_revisions[plateId]]));
}
const exported = (receipt, filenameBase = '') => ok(exportGcode(call, { receipt, filenameBase }));
ok(call('orc_init', ['string'], ['{"log_level":"error"}']));
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Café中文Ａ']));

let result = await slice(undefined);
let output = exported(result.receipt);
assert.match(output.file_name, /^Cafe中文A_.+_.+\.gcode$/);
assert.ok(!output.file_name.includes('{'), 'default uses final statistics');
const originalBytes = Module.FS.readFile(output.path);
const originalPath = output.path;
const originalGeneration = output.receipt.result_generation;
const stat = Module.FS.stat(output.path);
const renamed = exported(result.receipt, 'Project');
assert.match(renamed.file_name, /^Project_/);
assert.equal(renamed.path, originalPath);
assert.equal(renamed.receipt.result_generation, originalGeneration);
assert.equal(Module.FS.stat(renamed.path).mtime.getTime(), stat.mtime.getTime());
assert.deepEqual(Module.FS.readFile(renamed.path), originalBytes, 'rename reuses immutable G-code');

result = await slice('');
assert.equal(exported(result.receipt).file_name, 'Cafe中文A.gcode');
assert.equal(exported(result.receipt, 'Untitled').file_name, 'Untitled.gcode');
result = await slice('{input_filename_base}_{plate_name}_{plate_number}_{print_time}_{used_filament}.custom');
output = exported(result.receipt, 'Résumé中文Ｂ');
assert.match(output.file_name, /^Resume中文B_Plate 1_01_.+_[\d.]+\.custom$/);
assert.ok(!output.file_name.includes('{'));
const text = Module.FS.readFile(output.path, { encoding: 'utf8' });
const printTime = text.match(/; estimated printing time \(normal mode\) = (.+)/)?.[1];
assert.ok(printTime, 'G-code contains actual duration');
assert.ok(output.file_name.includes(`_${printTime.replace(/\s+/g, '')}_`), `name duration matches generated G-code: ${output.file_name}; ${printTime}`);

result = await slice('name');
assert.equal(exported(result.receipt).file_name, 'name.gcode');
result = await slice('{second}.gcode');
const firstTime = exported(result.receipt);
await new Promise((resolve) => setTimeout(resolve, 1100));
const secondTime = exported(result.receipt);
assert.notEqual(secondTime.file_name, firstTime.file_name, 'timestamp is evaluated per operation');
assert.equal(secondTime.path, firstTime.path);
result = await slice('bad<>:"|?*.GCODE');
assert.equal(exported(result.receipt).file_name, 'bad<>:"|?*.GCODE', 'no business sanitization and extension preserved');
result = await slice('{missing_filename_variable}');
const invalid = exportGcode(call, { receipt: result.receipt, filenameBase: '' });
assert.equal(invalid.ok, false);
assert.match(invalid.error, /filename_format/);

result = await slice('{input_filename_base}_{plate_name}_{plate_number}.gcode');
const firstId = session().current_plate_id;
const retained = exported(result.receipt, 'Retained');
ok(call('orc_add_plate'));
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Other']));
const other = await slice('{input_filename_base}_{plate_name}_{plate_number}.gcode');
assert.equal(exported(other.receipt).file_name, 'Other_Plate 2_02.gcode');
assert.equal(exported(result.receipt, 'Retained').file_name, retained.file_name, 'another plate cannot replace naming context');
assert.equal(exported(result.receipt).path, retained.path);
const superseded = await slice('{input_filename_base}.gcode', firstId);
assert.equal(exportGcode(call, { receipt: result.receipt, filenameBase: '' }).status, 'stale');
assert.equal(exported(superseded.receipt).file_name, 'Cafe中文A.gcode');
const structure = ok(call('orc_get_model_structure'));
ok(call('orc_rename_object', ['number', 'string'], [structure.objects[0].id, 'Changed']));
assert.equal(exported(superseded.receipt).file_name, 'Cafe中文A.gcode', 'non-invalidating metadata edit preserves generation model naming');
ok(setNativeScopedConfig(call, 'project', undefined, 'layer_height', '0.25'));
assert.equal(exportGcode(call, { receipt: superseded.receipt, filenameBase: '' }).status, 'stale', 'configuration mutation invalidates receipt');
assert.equal(call('orc_export_gcode_plate', ['string'], [JSON.stringify({ receipt: superseded.receipt })]).ok, undefined, 'filename base is mandatory');
console.log('PASS real Orca filename templates, statistics, Unicode folding, immutable generations, plate isolation and stale receipts');
