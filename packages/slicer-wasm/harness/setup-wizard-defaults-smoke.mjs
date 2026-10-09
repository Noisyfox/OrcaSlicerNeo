import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { installProfilePackages, createNodeProfileSource } from './profile-installer.mjs';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';

if (!process.argv[2]) throw new Error('usage: node setup-wizard-defaults-smoke.mjs <module.js>');
const factory = await loadModuleFactory(resolve(process.argv[2]));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
const FS = Module.FS;
function call(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
function must(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function links(activation) {
  for (const vendor of ['Creality', 'OrcaFilamentLibrary']) for (const suffix of ['', '.json']) {
    try { FS.unlink(`/system/${vendor}${suffix}`); } catch {}
  }
  for (const vendor of ['OrcaFilamentLibrary', ...new Set(activation?.models.map(model => model.vendor) ?? [])]) {
    FS.symlink(`/profiles/${vendor}.json`, `/system/${vendor}.json`);
    FS.symlink(`/profiles/${vendor}`, `/system/${vendor}`);
  }
}
function init(activation) { links(activation); must(call('orc_init', ['string'], [JSON.stringify({ log_level: 'error', profile_activation: activation })])); }
function summary() {
  const value = must(call('orc_get_preset_snapshot'));
  const keys = ['nozzle_diameter', 'layer_height', 'initial_layer_print_height', 'line_width', 'initial_layer_line_width',
    'outer_wall_line_width', 'inner_wall_line_width', 'top_surface_line_width', 'sparse_infill_line_width', 'internal_solid_infill_line_width', 'support_line_width'];
  return { printer: value.printer.name, process: value.print.name,
    effective: Object.fromEntries(keys.map(key => [key, value.project_config[key]])) };
}
async function slice() {
  const session = must(call('orc_get_plate_session_snapshot'));
  return callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number'], ['{}', session.current_plate_id, session.input_revisions[session.current_plate_id]]);
}
const activation = { models: [{ vendor: 'Creality', model: 'Creality Ender-3', nozzle_diameter: ['0.2', '0.4', '0.6', '0.8'] }],
  filaments: ['Generic PLA @System'] };
init(activation);
must(call('orc_select_printer_with_remembered_rack', ['string'], [JSON.stringify({ printer: 'Creality Ender-3 0.2 nozzle', remembered_rack: null, remembered_bed_type: null })]));
const direct = summary(); must(call('orc_add_shape', ['string', 'string'], ['Cube', 'Default comparison']));
const directSlice = await slice();
init(null); must(call('orc_open_setup_wizard_catalogue'));
const prepared = must(call('orc_prepare_profile_activation', ['string'], [JSON.stringify({ activation, remembered_filament_racks: {}, remembered_bed_types: {} })]));
const saved = structuredClone(prepared.activation); links(saved); must(call('orc_apply_profile_activation'));
const wizard = summary(); must(call('orc_add_shape', ['string', 'string'], ['Cube', 'Default comparison']));
const wizardSlice = await slice();
assert.deepEqual(wizard, direct, 'wizard and ordinary selection must produce the same native effective defaults');
assert.equal(wizardSlice.error, directSlice.error);
assert.equal(wizardSlice.error, 'Line width too small');
must(call('orc_select_printer_with_remembered_rack', ['string'], [JSON.stringify({ printer: 'Creality Ender-3 0.4 nozzle', remembered_rack: null, remembered_bed_type: null })]));
const usable = summary(), sliced = must(await slice());
const exported = must(exportGcode(call, { receipt: sliced.receipt, filenameBase: '' }));
const gcode = FS.readFile(exported.path, { encoding: 'utf8' });
assert.ok(gcode.includes('G1') && gcode.length > 1000);
must(call('orc_close_setup_wizard_catalogue'));
console.log('setup-wizard-defaults PASS', JSON.stringify({ direct, wizard, directSlice, wizardSlice, usable, exportedBytes: gcode.length }));
