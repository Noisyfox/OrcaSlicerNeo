import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages, fixtureProfileOptions } from './profile-installer.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: flushing-volumes-dialog-smoke.mjs <out/serial/orca_slice.js>');
const Module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
}
const session = () => call('orc_get_filament_session_snapshot');
const request = (name, body = {}) => call(name, ['string'], [JSON.stringify({ version: 1, revision: session().revisions.session, ...body })]);
function must(value) { assert.equal(value.ok, true, JSON.stringify(value)); return value; }
function policy(value) { must(call('orc_set_auto_flush_policy', ['string'], [value])); }
const editor = () => must(request('orc_get_flushing_volumes'));
function customMatrix(view, base = 111) {
  return view.matrix.map((_, i) => Math.floor(i / view.dimension) % view.dimension === i % view.dimension ? 0 : base + i);
}
function save(matrix, multipliers = editor().multipliers, extra = {}) {
  return must(request('orc_set_flushing_volumes', { matrix, multipliers, ...extra }));
}
function colour(slot, color) { return must(request('orc_set_filament_slot_colour', { slot, colour: { kind: 'solid', color } })); }

must(call('orc_init', ['string'], [fixtureProfileOptions(Module)]));
must(call('orc_select_preset', ['string', 'string'], ['printer', 'Bambu Lab P1P 0.4 nozzle']));
must(request('orc_add_filament_slot')); must(request('orc_add_filament_slot'));
const before = editor(), history = call('orc_history_status');
const matrix = customMatrix(before);
assert.deepEqual(editor(), before, 'default calculation is a read, never a project mutation');
assert.deepEqual(call('orc_history_status'), history);
const committed = save(matrix, [0.75]);
assert.equal(committed.result.mutation.history_entry_delta, 1);
assert.equal(committed.result.mutation.all_plate_results_invalidated, true);
assert.deepEqual(editor().matrix, matrix, 'raw values are not multiplied on storage');
assert.deepEqual(editor().multipliers, [0.75]);
must(call('orc_history_undo')); assert.deepEqual(editor().matrix, before.matrix);
must(call('orc_history_redo')); assert.deepEqual(editor().matrix, matrix); assert.deepEqual(editor().multipliers, [0.75]);
const noOpHistory = call('orc_history_status');
assert.equal(save(matrix, [0.75]).result.mutation.history_entry_delta, 0);
assert.deepEqual(call('orc_history_status'), noOpHistory, 'unchanged OK creates no history or invalidation');
assert.equal(request('orc_set_flushing_volumes', { revision: before.revision, matrix, multipliers: [1] }).ok, false);
for (const body of [{ matrix: matrix.slice(1), multipliers: [1] }, { matrix, multipliers: [4] },
  { matrix: matrix.map((v, i) => i === 0 ? 1 : v), multipliers: [1] }, { matrix: matrix.map((v, i) => i === 1 ? -1 : v), multipliers: [1] }]) {
  assert.equal(request('orc_set_flushing_volumes', body).ok, false);
  assert.deepEqual(editor().matrix, matrix);
}
const failed = request('orc_set_flushing_volumes', { matrix: customMatrix(editor(), 222), multipliers: [1], inject_failure: true });
assert.equal(failed.ok, false); assert.deepEqual(editor().matrix, matrix); assert.deepEqual(call('orc_history_status'), noOpHistory);
save(matrix, [0]); assert.deepEqual(editor().matrix, matrix); assert.deepEqual(editor().multipliers, [0]);
save(matrix, [0.75]);

policy('disabled'); colour(1, '#AA1122'); assert.deepEqual(editor().matrix, matrix);
policy('color change'); colour(1, '#FFFFFF');
const changed = editor().matrix;
assert.equal(changed[5], matrix[5]); assert.equal(changed[7], matrix[7], 'unrelated pair retains manual volumes');
assert.notDeepEqual(changed, matrix);
save(matrix, [1]);
// Native per-slot compatible sources are authoritative, not the global list.
const profile = must(call('orc_get_preset_snapshot'));
const preset = profile.filament_catalog.find(p => p.name !== session().slots[1].preset.name);
assert.ok(preset);
must(request('orc_select_filament_slot_preset', { slot: 2, preset: preset.name }));
assert.deepEqual(editor().matrix, matrix, 'Color does not react to a preset-only change');
policy('all'); must(request('orc_set_filament_routing', { selector: 'support-base', slot: 1, targets: [{ kind: 'project', id: 0 }] }));
assert.notDeepEqual(editor().matrix, matrix);
must(request('orc_select_filament_slot_preset', { slot: 2, preset: 'Bambu Support For PLA @BBL P1P' }));
assert.equal(editor().defaults[1], 230, 'prediction reads the selected support filament from the effective native config');
assert.ok(editor().defaults[3] >= 700, 'flushing from support respects the native support minimum');
save(matrix, [1]); policy('disabled');
must(request('orc_add_filament_slot'));
const added = editor();
for (let r = 0; r < 3; ++r) for (let c = 0; c < 3; ++c) assert.equal(added.matrix[r * 4 + c], matrix[r * 3 + c]);
must(request('orc_delete_filament_slot', { slot: 4 })); assert.deepEqual(editor().matrix, matrix);

// Production 3MF round trip persists custom matrix and multipliers.
must(call('orc_add_shape', ['string', 'string'], ['Cube', 'Flushing persistence']));
const exported = call('orc_export_project');
assert.equal(exported.ok, true, JSON.stringify(exported));
const bytes = Module.HEAPU8.slice(exported.bytes_ptr, exported.bytes_ptr + exported.bytes_length); Module._free(exported.bytes_ptr);
const data = Module._malloc(bytes.length); Module.HEAPU8.set(bytes, data);
try { must(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [data, bytes.length, 0, 'flushing-custom.3mf'])); }
finally { Module._free(data); }
assert.deepEqual(editor().matrix, matrix); assert.deepEqual(editor().multipliers, [1]);

must(call('orc_select_preset', ['string', 'string'], ['printer', 'Bambu Lab H2D 0.4 nozzle']));
const dual = editor(); assert.equal(dual.planes, 2);
save(customMatrix(dual, 300), [0.5, 1.5]);
assert.deepEqual(editor().multipliers, [0.5, 1.5]);
while (session().slots.length > 1) must(request('orc_delete_filament_slot', { slot: session().slots.length }));
assert.equal(editor().dimension, 1); assert.equal(editor().planes, 2);
assert.equal(request('orc_set_flushing_volumes', { matrix: [0, 0], multipliers: [1, 1] }).ok, false);
console.log('flushing dialog smoke passed: read-only defaults, atomic raw matrix/multipliers, no-op, stale/failure rollback, Undo/Redo, policies, topology, 3MF, H2D planes');
