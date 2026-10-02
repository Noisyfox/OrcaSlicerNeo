// Real WASM regression: DeltaMaker's negative-coordinate hexagonal bed must
// slice at a manually placed tower instead of cached Settings coordinates.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: node harness/prime-tower-slice-settings-smoke.mjs <module.js>');
const root = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(resolve(modulePath)))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(root, 'packages/profile-resources/dist')));
function callJson(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
function request(name, body) { return callJson(name, ['string'], [JSON.stringify(body)]); }
function must(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function set(key, value) { return must(setNativeScopedConfig(callJson, 'project', undefined, key, value)); }
function session() { return must(callJson('orc_get_plate_session_snapshot')); }
function tower(id = session().current_plate_id) {
  const projection = must(callJson('orc_get_prime_tower_projection'));
  const result = projection.plates.find(plate => plate.plate_id === id);
  assert.equal(result?.eligible, true, JSON.stringify(projection));
  return result;
}
const bed = [[-69, -120], [69, -120], [138, 0], [69, 120], [-69, 120], [-138, 0]];
function assertInside(value) {
  const angle = value.rotation * Math.PI / 180;
  for (const [x, y] of [[0, 0], [value.width, 0], [value.width, value.depth], [0, value.depth]]) {
    const rx = value.position.x + Math.cos(angle) * x - Math.sin(angle) * y;
    const ry = value.position.y + Math.sin(angle) * x + Math.cos(angle) * y;
    for (const dx of [-value.brim_margin, value.brim_margin])
      for (const dy of [-value.brim_margin, value.brim_margin])
        for (let i = 0; i < bed.length; i++) {
          const [ax, ay] = bed[i], [bx, by] = bed[(i + 1) % bed.length];
          assert.ok((bx - ax) * (ry + dy - ay) - (by - ay) * (rx + dx - ax) >= -0.01,
            `tower footprint leaves hexagonal printable area: ${JSON.stringify(value)}`);
        }
  }
}
function move(id, x, y) {
  return must(request('orc_move_prime_tower', { version: 1, plate_id: id,
    revision: session().input_revisions[id], x, y }));
}

must(callJson('orc_init', ['string'], ['']));
must(request('orc_select_printer_with_remembered_rack', { printer: 'DeltaMaker 2 0.35 nozzle',
  remembered_rack: { version: 1, slots: [
    { preset: 'Generic PLA @DeltaMaker', colour: '#FF0000' },
    { preset: 'Generic PLA @DeltaMaker', colour: '#00FF00' },
  ] } }));
// Enable a multi-material attachment in the native Printer draft for slicing.
const printerDraft = must(callJson('orc_get_preset_draft', ['string', 'string'], ['printer', 'DeltaMaker 2 0.35 nozzle']));
must(request('orc_mutate_preset_draft', { action: 'set', kind: 'printer',
  canonical_name: 'DeltaMaker 2 0.35 nozzle', expected_revision: printerDraft.revision,
  key: 'single_extruder_multi_material', value: '1' }));
set('enable_prime_tower', '1'); set('timelapse_type', '0');
set('prime_tower_width', '25'); set('prime_tower_brim_width', '5'); set('wipe_tower_wall_type', 'rectangle');
for (let i = 0; i < 2; i++) must(callJson('orc_add_shape', ['string', 'string'], ['Cube', `hex bed cube ${i}`]));
const filament = must(callJson('orc_get_filament_session_snapshot'));
assert.equal(filament.slots.length, 2);
const objects = must(callJson('orc_get_model_structure')).objects;
must(request('orc_assign_filament', { version: 1, revision: filament.revisions.session,
  slot: 2, targets: [{ kind: 'object', id: objects[1].id }] }));
const id = session().current_plate_id;
assert.deepEqual(tower(id).used_slots, [1, 2]);
// The entire tower and brim are well inside the actual hexagon, without
// relying on automatic polygon clamping.
// A bbox-valid corner deliberately lies beyond the actual hexagon. Cache it
// as Settings does, then move the scene entity to the interior.
move(id, 110, 90);
const staleSettings = must(callJson('orc_get_preset_snapshot')).project_config;
move(id, -60, -50); assertInside(tower(id));
const staleSlice = await callAsyncTask(callJson, 'orc_slice_plate', ['string', 'string', 'number'],
  [JSON.stringify(staleSettings), id, session().input_revisions[id]]);
assert.match(staleSlice.error ?? '', /Prime Tower is partially outside the printable area/,
  'pre-drag Settings coordinates reproduce the reported failure');
assert.deepEqual(tower(id).position, { x: -60, y: -50 }, 'the native position is already legal');
must(callJson('orc_history_undo'));
assert.notDeepEqual(tower(id).position, { x: -60, y: -50 });
must(callJson('orc_history_redo'));
assert.deepEqual(tower(id).position, { x: -60, y: -50 }, 'Redo restores the native scene position');
// Match the shared application's slice request: scene-owned X/Y are excluded.
const { wipe_tower_x, wipe_tower_y, ...sliceSettings } = staleSettings;
const sliced = must(await callAsyncTask(callJson, 'orc_slice_plate', ['string', 'string', 'number'],
  [JSON.stringify(sliceSettings), id, session().input_revisions[id]]));
assert.ok(!(sliced.warnings ?? []).some(warning => /outside the printable area/.test(warning)), JSON.stringify(sliced));
const exported = must(exportGcode(callJson, sliced.receipt));
const gcode = Module.FS.readFile(exported.path, { encoding: 'utf8' });
assert.match(gcode, /wipe_tower_x = -60\b/);
assert.match(gcode, /wipe_tower_y = -50\b/);

console.log(JSON.stringify({ ok: true, printer: 'DeltaMaker 2', multiFilamentSlice: true }));
