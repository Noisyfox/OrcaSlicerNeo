import assert from 'node:assert/strict';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';
import { parseLayerRanges } from './native-3mf-parser.mjs';

import { saveProject, openProject, withRangeMetadata } from './height-range-project.mjs';

const { module, call, edit, run, rack } = await createMixedFilamentFixture(process.argv[2]);
const checked = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
const save = () => saveProject(module, call);
const open = bytes => openProject(module, call, bytes);

const recipe = { components: [1, 2], ratios: [60, 40], gradient: false, perPart: false, reverse: false, points: [] };
const mixSlot = edit('orc_edit_mixed_filament', { recipe }).slots.at(-1).slot;
checked(call('orc_add_shape', ['string', 'string'], ['Cube', 'Range reference']));
const features = ['outer_wall', 'inner_wall', 'sparse_infill', 'internal_solid', 'top_surface', 'bottom_surface']
  .map(feature => feature + '_filament_id');
function expected(slot) {
  return [
    { layer_height: '0.16', extruder: String(slot), ...Object.fromEntries(features.map(key => [key, String(slot)])) },
    { layer_height: '0.12', outer_wall_filament_id: '0', extruder: '2' },
  ];
}
open(withRangeMetadata(save(), expected(mixSlot).map((values, i) => [4 * i, 4 * i + 4, values])));
function assertRanges(slot) {
  assert.deepEqual(parseLayerRanges(save()).map(range => range.values), expected(slot));
}
assertRanges(mixSlot);
assert.equal(run('orc_add_filament_slot', { inject_failure: true }).ok, false);
assertRanges(mixSlot);
edit('orc_add_filament_slot');
assertRanges(mixSlot + 1);
open(save());
assertRanges(mixSlot + 1);
edit('orc_delete_filament_slot', { slot: mixSlot });
assertRanges(mixSlot);
edit('orc_merge_filament_slots', { source: mixSlot, destination: 2 });
assertRanges(2);
checked(call('orc_history_undo'));
assertRanges(mixSlot);
edit('orc_delete_filament_slot', { slot: mixSlot });
assertRanges(0);
checked(call('orc_history_undo'));
assertRanges(mixSlot);
checked(call('orc_history_redo'));
assertRanges(0);
checked(call('orc_history_undo'));
const shorterRack = rack().slots.slice(0, 2).map(slot => ({
  preset: slot.preset.name, colour: slot.colour.effective, native: slot.colour.native,
}));
const printer = call('orc_get_preset_snapshot').printers.find(item => item.name.includes('Bambu Lab X1 Carbon 0.4'));
checked(run('orc_select_printer_with_remembered_rack', {
  printer: printer.name, remembered_bed_type: null, remembered_rack: { version: 1, slots: shorterRack },
  history_context: { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
    activePlateId: null, gizmo: null, nativeScopedConfig: {} },
}));
assert.deepEqual(parseLayerRanges(save()).map(range => range.values), [
  { layer_height: '0.16', extruder: '0' }, expected(mixSlot)[1],
]);
console.log('PASS range filament slots across insert, reload, merge, delete, rollback, undo, redo and shorter rack');
process.exit(0);
