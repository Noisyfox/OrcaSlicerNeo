import assert from 'node:assert/strict';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';
import { awaitAsyncTask, exportGcode, getSliceResult } from './async-task-mailbox.mjs';
import { openProject, saveProject } from './height-range-project.mjs';

const { module, call, edit, rack } = await createMixedFilamentFixture(process.argv[2]);
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
const object = () => ok(call('orc_get_model_structure')).objects[0];
function range(command) {
  return ok(call('orc_edit_height_ranges', ['string'],
    [JSON.stringify({ objectId: object().id, targets: object().heightRanges, ...command })]));
}
async function wallTools() {
  const sliced = ok(await awaitAsyncTask(call, call('orc_slice', ['string'],
    [JSON.stringify({ enable_prime_tower: '0', enable_mixed_color_sublayer: '1' })])));
  const { toolpath } = ok(getSliceResult(call, sliced.receipt));
  const { segment_count: n } = toolpath;
  const moves = new Uint8Array(module.HEAPU8.buffer, Number(toolpath.move_type_ptr), n);
  const roles = new Uint16Array(module.HEAPU8.buffer, Number(toolpath.extrusion_role_ptr), n);
  const tools = new Uint8Array(module.HEAPU8.buffer, Number(toolpath.extruder_id_ptr), n);
  const ends = new Float32Array(module.HEAPU8.buffer, Number(toolpath.ends_ptr), n * 3);
  const inside = new Set(), above = new Set();
  for (let i = 0; i < n; ++i) {
    if (moves[i] !== 10 || roles[i] !== 2) continue; // Extrude / ExternalPerimeter
    const z = ends[i * 3 + 2];
    if (z > 1 && z < 5) inside.add(tools[i]);
    if (z > 8 && z < 13) above.add(tools[i]);
  }
  const file = ok(exportGcode(call, { receipt: sliced.receipt, filenameBase: '' }));
  const gcode = module.FS.readFile(file.path, { encoding: 'utf8' });
  const physicalTools = [...new Set([...gcode.matchAll(/^T(\d+)\b/gm)].map(m => Number(m[1])).filter(t => t < 64))].sort();
  const layerZ = [...gcode.matchAll(/^;\s*(?:Z_HEIGHT|Z):\s*([\d.]+)/gm)].map(m => Number(m[1]));
  assert.ok(layerZ.length > 40);
  return { inside: [...inside].sort(), above: [...above].sort(), physicalTools, layerZ };
}
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Range materials']));
const owner = object();
const part = ok(call('orc_add_volume', ['string', 'pointer', 'number'], [JSON.stringify({
  objectId: owner.id, instanceId: owner.instances[0].id, volumeType: 'model_part', shape: 'Cube',
}), 0, 0]));
// Keep both solids on the bed, separated in X, so both produce external perimeters.
const placed = ok(call('orc_get_model_mesh')).renderables;
const a = placed.find(row => row.volume_id === owner.volumes[0].id);
const b = placed.find(row => row.volume_id === part.volumeId);
const transform = structuredClone(a.volume_transform);
delete transform.matrix;
transform.offset[0] += 36;
ok(call('orc_set_model_transform', ['number', 'number', 'number', 'string', 'string'], [
  0, 1, 0, JSON.stringify(a.instance_transform), JSON.stringify(transform),
]));
assert.ok(b);
const first = { kind: 'model-part', id: owner.volumes[0].id };
const second = { kind: 'model-part', id: part.volumeId };
edit('orc_add_filament_slot');
const setRoute = (target, slot) => edit('orc_set_filament_routing', { targets: [target], selector: 'outer-wall', slot });
setRoute({ kind: 'object', id: owner.id }, 2);
setRoute(first, 1);
setRoute(second, 2);
range({ operation: 'initialize' });
range({ operation: 'max', value: 6 });
let sliced = await wallTools();
assert.deepEqual(sliced.inside, [0, 1]);
assert.deepEqual(sliced.above, [0, 1]);
const inheritedZ = sliced.layerZ;
range({ operation: 'set', key: 'outer_wall_filament_id', value: 3 });
sliced = await wallTools();
assert.deepEqual(sliced.layerZ, inheritedZ, 'a filament-only edit preserves the Z sequence');
assert.deepEqual(sliced.inside, [2]);
assert.deepEqual(sliced.above, [0, 1]);
range({ operation: 'set', key: 'extruder', value: 1 });
edit('orc_delete_filament_slot', { slot: 3 });
assert.deepEqual((await wallTools()).inside, [0], 'Delete explicitly defaults to the white range base');
range({ operation: 'reset', key: 'outer_wall_filament_id' });
assert.deepEqual((await wallTools()).inside, [0, 1], 'Reset restores the inherited part routes');
const recipe = { components: [1, 2], ratios: [50, 50], gradient: false, perPart: false, reverse: false, points: [] };
edit('orc_edit_mixed_filament', { recipe });
setRoute(second, 1);
range({ operation: 'set', key: 'outer_wall_filament_id', value: 3 });
edit('orc_add_filament_slot');
openProject(module, call, saveProject(module, call));
assert.equal(object().heightRanges[0].values.outer_wall_filament_id, '4');
assert.equal(rack().slots.length, 4);
assert.deepEqual(ok(call('orc_get_prime_tower_projection')).plates[0].used_slots, [1, 2]);
sliced = await wallTools();
assert.deepEqual(sliced.physicalTools, [0, 1], 'inserted physical slot has zero use in G-code');
assert.deepEqual(sliced.inside, [0, 1], 'both physical components extrude range walls');
assert.deepEqual(sliced.above, [0]);
console.log('PASS multipart range inheritance, override, Delete/Reset and mixed physical tools in G-code');
process.exit(0);
