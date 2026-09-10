// Focused Step 11 native projection smoke. Run against the threaded artifact:
// node multi-filament-prime-tower-projection-smoke.mjs --module out/threaded/orca_slice.js
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let i = 2; i < argv.length; i += 2) opts[argv[i]?.replace(/^--/, '')] = argv[i + 1];
if (!opts.module) throw new Error('usage: node multi-filament-prime-tower-projection-smoke.mjs --module out/threaded/orca_slice.js');
const repoRoot = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(resolve(opts.module)))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`)));

function callJson(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const result = JSON.parse(Module.UTF8ToString(ptr)); Module._free(ptr); return result;
}
function request(name, body) { return callJson(name, ['string'], [JSON.stringify(body)]); }
const init = callJson('orc_init', ['string'], ['']);
assert.equal(init.ok, true, JSON.stringify(init));

// One used filament is hidden even when the rack contains multiple slots.
const first = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'projection cube']);
assert.equal(first.ok, true, JSON.stringify(first));
let session = callJson('orc_get_filament_session_snapshot');
const added = request('orc_add_filament_slot', { version: 1, revision: session.revisions.session });
assert.equal(added.ok, true, JSON.stringify(added)); session = added.result.snapshot;
let projection = callJson('orc_get_prime_tower_projection');
assert.equal(projection.ok, true, JSON.stringify(projection));
assert.equal(projection.plates.length, 1);
assert.equal(projection.plates[0].eligible, false, 'rack count alone is not eligibility evidence');
assert.equal(projection.plates[0].height, 0, 'hidden one-filament proxy has no visible height');

// Smooth timelapse is a native forced case: one actually used filament is
// enough once the native feature is enabled.
callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'], ['project', '', 'enable_prime_tower', '1']);
callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'], ['project', '', 'timelapse_type', '1']);
projection = callJson('orc_get_prime_tower_projection');
assert.equal(projection.plates[0].eligible, true, JSON.stringify(projection));
assert.equal(projection.plates[0].forced, true);
assert.deepEqual(projection.plates[0].used_slots, [1]);
callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'], ['project', '', 'timelapse_type', '0']);

// Paint/assign a second slot: eligibility, native dimensions, and equal bands
// are all returned by C++, including the dark-colour render adjustment.
const second = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'second projection cube']);
assert.equal(second.ok, true, JSON.stringify(second));
const objectId = callJson('orc_get_model_structure').objects[1].id;
const assigned = request('orc_assign_filament', {
  version: 1, revision: session.revisions.session, slot: 2,
  targets: [{ kind: 'object', id: objectId }],
});
assert.equal(assigned.ok, true, JSON.stringify(assigned));
callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'], ['project', '', 'prime_tower_width', '25']);
callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'], ['project', '', 'prime_tower_brim_width', '7']);
callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'], ['project', '', 'wipe_tower_rotation_angle', '90']);
callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'], ['project', '', 'wipe_tower_wall_type', 'rectangle']);
projection = callJson('orc_get_prime_tower_projection');
const tower = projection.plates[0];
assert.equal(tower.eligible, true, JSON.stringify(tower));
assert.deepEqual(tower.used_slots, [1, 2]);
assert.equal(tower.width, 25);
assert.equal(tower.height >= 0.1, true);
assert.equal(tower.rotation, 90);
assert.equal(tower.brim_margin, 7);
assert.equal(tower.bands.length, 2);
assert.equal(tower.bands[0].start_depth, 0);
assert.equal(tower.bands[0].end_depth, tower.bands[1].start_depth);
assert.equal(tower.bands[1].end_depth, tower.depth);
assert.equal(tower.bands[0].opacity, 0.66);

// Rib-wall towers use the native estimated depth for both dimensions.
callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'], ['project', '', 'wipe_tower_wall_type', 'rib']);
projection = callJson('orc_get_prime_tower_projection');
assert.equal(projection.plates[0].width, projection.plates[0].depth);

// A degenerate native height still gets the accepted minimum visible proxy
// height. The zero-Z transform is setup only; the feature remains read-only.
const meshEntries = callJson('orc_get_model_mesh').objects;
for (const entry of meshEntries) {
  const instance = { ...entry.instance_transform, scale: [...entry.instance_transform.scale.slice(0, 2), 0] };
  delete instance.matrix;
  const changed = callJson('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'],
    [entry.object_idx, entry.volume_idx, entry.instance_idx, JSON.stringify(instance), JSON.stringify(entry.volume_transform)]);
  assert.equal(changed.ok, true, JSON.stringify(changed));
}
projection = callJson('orc_get_prime_tower_projection');
assert.equal(projection.plates[0].eligible, true, JSON.stringify(projection));
assert.equal(projection.plates[0].height, 0.1);

// Every plate is projected, not only the current one.
const addedPlate = callJson('orc_add_plate');
assert.equal(addedPlate.ok, true, JSON.stringify(addedPlate));
projection = callJson('orc_get_prime_tower_projection');
assert.equal(projection.plates.length, 2);
assert.deepEqual(projection.plates.map((plate) => plate.display_index), [0, 1]);
console.log(JSON.stringify({ ok: true, plates: projection.plates.length, eligible: projection.plates.filter((p) => p.eligible).length }));
