import assert from 'node:assert/strict';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';
import { openProject, saveProject, withRangeMetadata } from './height-range-project.mjs';

const { module, call, edit } = await createMixedFilamentFixture(process.argv[2]);
edit('orc_add_filament_slot');
const recipe = { components: [1, 2], ratios: [60, 40], gradient: false, perPart: false, reverse: false, points: [] };
const mix = edit('orc_edit_mixed_filament', { recipe }).slots.at(-1).slot;
assert.equal(call('orc_add_shape', ['string', 'string'], ['Cube', 'Range tower']).ok, true);
const project = saveProject(module, call);
const row = (min, max, values) => [min, max, { layer_height: 0.2, ...values }];
const ranges = [
  row(0, 5, { sparse_infill_density: '0%', sparse_infill_filament_id: mix }),
  row(1, 3, { outer_wall_filament_id: 3 }),
  row(1000, 1010, { extruder: 3 }),
];
function check(rows, slots) {
  openProject(module, call, withRangeMetadata(project, rows));
  const tower = call('orc_get_prime_tower_projection').plates[0];
  assert.deepEqual(tower.used_slots, slots);
}
check(ranges, [1]);
check([...ranges, row(3, 8, { sparse_infill_density: '20%', sparse_infill_filament_id: mix })], [1, 2]);
console.log('PASS effective range feature, mixed components, disabled, covered and off-object ranges');
process.exit(0);
