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

function towerMotion(gcode) {
  assert.ok(gcode.includes(';TYPE:Prime tower'), 'export contains the Prime Tower feature');
  let x, y, e = 0;
  let relativeExtrusion = true;
  let feature = '';
  const points = [];
  for (const line of gcode.split(/\r?\n/)) {
    if (line.startsWith(';TYPE:')) feature = line.slice(6).trim();
    if (/^M83\b/.test(line)) relativeExtrusion = true;
    if (/^M82\b/.test(line)) relativeExtrusion = false;
    const eMatch = line.match(/\bE(-?(?:\d+(?:\.\d*)?|\.\d+))/);
    if (/^G92\b/.test(line) && eMatch) e = Number(eMatch[1]);
    if (!/^G[0123]\b/.test(line)) continue;
    const xMatch = line.match(/\bX(-?\d+(?:\.\d+)?)/);
    const yMatch = line.match(/\bY(-?\d+(?:\.\d+)?)/);
    const previous = [x, y];
    if (xMatch) x = Number(xMatch[1]);
    if (yMatch) y = Number(yMatch[1]);
    const nextE = eMatch ? Number(eMatch[1]) : e;
    const extruding = eMatch && (relativeExtrusion ? nextE > 0 : nextE > e);
    if (eMatch) e = nextE;
    // Track modal XY across the whole file, but compare only actual deposited
    // Prime Tower paths. Unload/retract moves and travel to models are excluded.
    if (feature === 'Prime tower' && extruding && (xMatch || yMatch)) {
      if (previous.every(value => value !== undefined)) points.push(previous);
      if (x !== undefined && y !== undefined) points.push([x, y]);
    }
  }
  assert.ok(points.length > 0, 'tower G-code contains extruding XY paths');
  return {
    points,
    bounds: {
      min_x: Math.min(...points.map(([x]) => x)), max_x: Math.max(...points.map(([x]) => x)),
      min_y: Math.min(...points.map(([, y]) => y)), max_y: Math.max(...points.map(([, y]) => y)),
    },
  };
}

function assertMotionMatchesPreview(motion, projection) {
  // This fixture has a rectangular tower at zero rotation. Its deposited brim
  // starts at the displayed native anchor minus the brim margin, within nozzle
  // width / G-code rounding. Prepare depth is a pre-slice estimate, so the
  // positional assertion does not equate it with the generated purge depth.
  assert.equal(projection.rotation, 0);
  for (const axis of ['x', 'y']) {
    const expected = projection.position[axis] - projection.brim_margin;
    const actual = motion.bounds[`min_${axis}`];
    assert.ok(Math.abs(actual - expected) <= 0.5,
      `tower path origin ${axis} disagrees with Prepare: expected ${expected}, got ${actual}`);
  }
}

must(callJson('orc_init', ['string'], ['']));
must(request('orc_select_printer_with_remembered_rack', { printer: 'DeltaMaker 2 0.35 nozzle',
  remembered_bed_type: null, remembered_rack: { version: 1, slots: [
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
const firstPreview = tower(id);
const sliced = must(await callAsyncTask(callJson, 'orc_slice_plate', ['string', 'string', 'number'],
  [JSON.stringify(sliceSettings), id, session().input_revisions[id]]));
assert.ok(!(sliced.warnings ?? []).some(warning => /outside the printable area/.test(warning)), JSON.stringify(sliced));
const exported = must(exportGcode(callJson, { receipt: sliced.receipt, filenameBase: '' }));
const gcode = Module.FS.readFile(exported.path, { encoding: 'utf8' });
assert.match(gcode, /wipe_tower_x = -60\b/);
assert.match(gcode, /wipe_tower_y = -50\b/);
assert.deepEqual(tower(id).position, firstPreview.position, 'Slice preserves the pre-slice Prepare position');
const firstMotion = towerMotion(gcode);
assertMotionMatchesPreview(firstMotion, firstPreview);

// Re-slice the same geometry after another scene move. The actual XY paths,
// rather than just the exported config footer, must translate with the proxy.
move(id, -40, -40);
const secondPreview = tower(id);
assertInside(secondPreview);
const secondSlice = must(await callAsyncTask(callJson, 'orc_slice_plate', ['string', 'string', 'number'],
  [JSON.stringify(sliceSettings), id, session().input_revisions[id]]));
const secondExport = must(exportGcode(callJson, { receipt: secondSlice.receipt, filenameBase: '' }));
const secondMotion = towerMotion(Module.FS.readFile(secondExport.path, { encoding: 'utf8' }));
assertMotionMatchesPreview(secondMotion, secondPreview);
for (const axis of ['x', 'y']) {
  const delta = secondPreview.position[axis] - firstPreview.position[axis];
  for (const edge of ['min', 'max']) {
    const actualDelta = secondMotion.bounds[`${edge}_${axis}`] - firstMotion.bounds[`${edge}_${axis}`];
    assert.ok(Math.abs(actualDelta - delta) <= 0.002,
      `${edge} ${axis} G-code motion must follow the preview move: expected ${delta}, got ${actualDelta}`);
  }
}

assert.equal(secondMotion.points.length, firstMotion.points.length, 'the same tower has the same extrusion paths');
for (let i = 0; i < firstMotion.points.length; i++)
  for (const [index, axis] of ['x', 'y'].entries()) {
    const delta = secondPreview.position[axis] - firstPreview.position[axis];
    const actualDelta = secondMotion.points[i][index] - firstMotion.points[i][index];
    assert.ok(Math.abs(actualDelta - delta) <= 0.002,
      `tower extrusion endpoint ${i} ${axis} must translate with Prepare: expected ${delta}, got ${actualDelta}`);
  }

console.log(JSON.stringify({ ok: true, printer: 'DeltaMaker 2', multiFilamentSlice: true,
  gcodeMotionMatchesPreview: true, motionDelta: { x: 20, y: 10 } }));
