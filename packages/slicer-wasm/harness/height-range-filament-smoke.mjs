import assert from 'node:assert/strict';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';
import { parseLayerRanges, readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';

const { module, call, edit, run, rack } = await createMixedFilamentFixture(process.argv[2]);
const checked = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
function save() {
  const { bytes_ptr, bytes_length } = checked(call('orc_export_project', ['string'], ['{}']));
  try { return module.HEAPU8.slice(Number(bytes_ptr), Number(bytes_ptr) + bytes_length); }
  finally { module._free(bytes_ptr); }
}
function open(bytes) {
  const ptr = module._malloc(bytes.length);
  try {
    module.HEAPU8.set(bytes, Number(ptr));
    checked(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, bytes.length, 0, 'ranges.3mf']));
  } finally { module._free(ptr); }
}

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
const ranges = expected(mixSlot).map((values, i) =>
  `<range min_z="${4*i}" max_z="${4*i+4}">${Object.entries(values)
    .map(([key, value]) => `<option opt_key="${key}">${value}</option>`).join('')}</range>`);
const seed = writeStoredZip([...readZipEntries(save()), {
  name: 'Metadata/layer_config_ranges.xml',
  content: new TextEncoder().encode(`<objects><object id="1">${ranges.join('')}</object></objects>`),
}]);
open(seed);
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
