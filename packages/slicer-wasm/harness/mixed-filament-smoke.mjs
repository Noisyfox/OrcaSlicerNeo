// Usage: node harness/mixed-filament-smoke.mjs out/serial/orca_slice.js
import assert from 'node:assert/strict';
import { awaitAsyncTask, getSliceResult } from './async-task-mailbox.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';

const { module, call, rack, run, edit, printer } = await createMixedFilamentFixture(process.argv[2]);
const initial = rack();
const count = initial.slots.length;
const draft = {
  components: [1, 2],
  ratios: [60, 40],
  gradient: false,
  reverse: false,
  perPart: false,
  points: [],
};
const saved = edit('orc_edit_mixed_filament', { recipe: draft });
const mix = saved.slots.at(-1);
assert.deepEqual(mix.mix.components, draft.components);
assert.deepEqual(mix.mix.ratios, draft.ratios);
assert.equal(mix.mix.error, '');
// The first measured CMYW table entry is a two-base recipe. Neither base
// is present, so both physical insertions must precede the existing mix.
edit('orc_set_filament_slot_colour', { slot: 1, colour: { kind: 'solid', color: '#965E9E' } });
const decompose = { source: 1, material: 'PLA Basic', method: 'CMYW' };
const plan = run('orc_preview_mixed_filament', { decompose });
assert.equal(plan.error, '', JSON.stringify(plan));
assert.equal(plan.matched, '#965E9E');
assert.equal(plan.additions.length, 2);
const decomposed = edit('orc_edit_mixed_filament', { decompose });
assert.deepEqual(decomposed.slots.at(-1).mix.components, plan.recipe.components);
assert.equal(decomposed.slots.at(-2).logical_id, mix.logical_id);
assert.equal(decomposed.slots[0].colour.effective, '#965E9E');
assert.equal(call('orc_history_undo').ok, true);
assert.equal(rack().slots.length, saved.slots.length);
const before = rack().revisions.session;
assert.equal(
  run('orc_edit_mixed_filament', { slot: mix.slot, recipe: { ...draft, components: [1, 1] } }).ok,
  false,
);
assert.equal(rack().revisions.session, before);
const gradient = {
  ...draft,
  gradient: true,
  reverse: true,
  perPart: true,
  points: [
    { x: 0, y: 0.1, in: null, out: null },
    { x: 0.7, y: 0.2, in: null, out: null },
    { x: 1, y: 0.9, in: null, out: null },
  ],
};
edit('orc_edit_mixed_filament', { slot: mix.slot, recipe: gradient });
assert.deepEqual(rack().slots.at(-1).mix.points, gradient.points);
assert.equal(rack().slots.at(-1).mix.ramp.length, 17);
assert.equal(call('orc_add_shape', ['string', 'string'], ['Cube', 'Painted mix']).ok, true);
const objectId = rack().assignments.objects[0].id;
edit('orc_assign_filament', { targets: [{ kind: 'object', id: objectId }], slot: mix.slot });
function archiveEntries() {
  const archive = call('orc_export_project', ['string'], ['{}']);
  assert.equal(archive.ok, true);
  const ptr = Number(archive.bytes_ptr);
  try {
    return readZipEntries(module.HEAPU8.slice(ptr, ptr + archive.bytes_length));
  } finally {
    module._free(ptr);
  }
}
const decoder = new TextDecoder();
const modelEntry = (entry) =>
  entry.name.endsWith('.model') && decoder.decode(entry.content).includes('<triangle ');
const withPaint = writeStoredZip(
  archiveEntries().map((entry) =>
    modelEntry(entry)
      ? {
          ...entry,
          content: new TextEncoder().encode(
            decoder
              .decode(entry.content)
              .replace(/<triangle\b[^>]*\/>/g, (triangle) => triangle.replace('/>', ' paint_color="0C"/>')),
          ),
        }
      : entry,
  ),
);
const ptr = module._malloc(withPaint.length);
module.HEAPU8.set(withPaint, Number(ptr));
assert.equal(
  call(
    'orc_load_project',
    ['pointer', 'number', 'number', 'string'],
    [ptr, withPaint.length, 0, 'painted.3mf'],
  ).ok,
  true,
);
module._free(ptr);
function assertPaint(code) {
  const xml = decoder.decode(archiveEntries().find(modelEntry).content);
  assert.deepEqual(
    [...xml.matchAll(/paint_color="([^"]+)"/g)].map((match) => match[1]),
    Array((xml.match(/<triangle\b/g) ?? []).length).fill(code),
  );
}
assertPaint('0C');
// A tray remap is a read-only blend. Restoring printer memory preserves the
// exact serialized recipe, including independently authored curve tangents.
const rememberedSlots = () => rack().slots.map(slot => ({ preset: slot.preset.name,
  colour: slot.colour.effective, native: slot.colour.native, ...(slot.mix && { mix: slot.mix.storage }) }));
const remembered = rememberedSlots();
const originalRack = rack();
const remapped = run('orc_preview_mixed_filament', { ...gradient, componentColours: ['#FF0000', '#FFFFFF'] });
const blueTray = run('orc_preview_mixed_filament', { ...gradient, componentColours: ['#FF0000', '#0000FF'] });
assert.match(remapped.colour, /^#[0-9a-f]{6}$/i);
assert.notEqual(remapped.colour, blueTray.colour);
assert.deepEqual(rack(), originalRack);
const amsSources = ['#FF0000', '#FFFFFF', '#0000FF'].map((color, i) => ({
  slotId: `tray-${i + 1}`, catalogRefs: [{ namespace: 'orca-filament', value: 'OFoiVqVM' }],
  materialType: 'PLA', colour: { kind: 'solid', color }, toolIndices: [0],
}));
const ams = { identity: { manufacturer: '', model: 'Bambu Lab P1P', externalRefs: [] }, sources: amsSources };
const preparation = run('orc_prepare_material_import', { ...ams, mapping: null });
assert.equal(preparation.ok, true, JSON.stringify(preparation));
assert.equal(preparation.references.length, 2);
const synced = edit('orc_apply_material_import', { ...ams, mode: 'rebuild', colourOnly: false,
  replacements: [null, null], mapping: [], appendUnused: false });
assert.deepEqual(synced.slots.map(s => s.colour.effective), ['#FF0000', '#FFFFFF', '#0000FF', remapped.colour]);
assert.deepEqual(synced.slots[3].mix.storage, remembered[2].mix);
assert.equal(synced.assignments.objects[0].explicit_slot, 4);
assertPaint('1C');
assert.equal(call('orc_history_undo').ok, true);
assertPaint('0C');
const shrink = edit('orc_apply_material_import', { ...ams, sources: amsSources.slice(0, 1), mode: 'rebuild',
  colourOnly: false, replacements: [null, null], mapping: [], appendUnused: false });
assert.deepEqual(shrink.slots[1].mix.components, [1, 0]);
const needsRepair = rememberedSlots();
assert.equal(call('orc_history_undo').ok, true);
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const switchRack = (printer, slots) => {
  const switched = run('orc_select_printer_with_remembered_rack', { printer, history_context: context,
    remembered_bed_type: null, remembered_rack: { version: 1, slots } });
  assert.equal(switched.ok, true, JSON.stringify(switched));
};
const alternate = call('orc_get_preset_snapshot').printers.find(p => p.name.includes('Bambu Lab X1 Carbon 0.4'));
const alternateRack = structuredClone(remembered);
alternateRack[2].mix.filament_mixed_sublayer_ratios = '0.3250,0.6750';
switchRack(alternate.name, alternateRack);
assert.deepEqual(rack().slots[2].mix.storage, alternateRack[2].mix);
assert.equal(rack().assignments.objects[0].explicit_slot, 3);
assertPaint('0C');
switchRack(printer.name, remembered);
assertPaint('0C');
const restore = run('orc_apply_remembered_filament_rack', { slots: remembered });
assert.equal(restore.ok, true, JSON.stringify(restore));
assert.deepEqual(restore.slots[2].mix.storage, remembered[2].mix);
const currentPlate = call('orc_get_plate_session_snapshot').current_plate_id;
const mapping = call('orc_get_nozzle_mapping', ['string'], [currentPlate]);
assert.deepEqual(mapping.usedFilaments, [1, 2], JSON.stringify(mapping));
const tower = call('orc_get_prime_tower_projection').plates.find(p => p.plate_id === currentPlate);
assert.deepEqual(tower.used_slots, [1, 2]);
async function sliceMix(overrides = {}) {
  const events = [];
  const acceptance = call('orc_slice', ['string'], [JSON.stringify({ enable_prime_tower: false, ...overrides })]);
  const slice = await awaitAsyncTask(call, acceptance, 120000, batch => events.push(...batch));
  return { slice, events };
}
// The type used by the sidebar and slice validation must follow unsaved
// changes on the physical preset, including when another preset is selected.
const secondPreset = 'Generic PLA High Speed @BBL P1P';
edit('orc_select_filament_slot_preset', { slot: 2, preset: secondPreset });
const changedType = run('orc_mutate_preset_draft', {
  history_context: context, action: 'set-element', kind: 'filament', canonical_name: secondPreset,
  expected_revision: call('orc_history_status').revision, key: 'filament_type',
  scalar_type: 'string', index: 0, value: 'PETG',
});
assert.equal(changedType.ok, true, JSON.stringify(changedType));
assert.equal(changedType.filament_session.slots[1].material_type, 'PETG');
assert.match(changedType.filament_session.slots[2].mix.error, /same material type/);
assert.match((await sliceMix()).slice.error, /Repair mixed filament 3/);
assert.equal(call('orc_history_undo').ok, true);
assert.equal(rack().slots[2].mix.error, '');
assert.equal(call('orc_history_undo').ok, true);
const wholeLayer = await sliceMix({ enable_mixed_color_sublayer: false });
assert.equal(wholeLayer.slice.ok, true, JSON.stringify(wholeLayer.slice));
assert.match(JSON.stringify(wholeLayer.events), /gradient will not be printed/i);
const { slice } = await sliceMix({ enable_mixed_color_sublayer: true });
assert.equal(slice.ok, true, JSON.stringify(slice));
const submission = run('orc_describe_print_plate', { receipt: { ...slice.receipt, result_generation: Number(slice.receipt.result_generation) }, filename_base: 'Mixed' });
assert.equal(submission.ok, true, JSON.stringify(submission));
assert.deepEqual(submission.manifest.materials.map(m => m.index), [0, 1]);
const preview = getSliceResult(call, slice.receipt);
assert.deepEqual(preview.metadata.extruder_palette.map(entry => entry.tool), [0, 1]);
assert.ok(preview.metadata.extruder_palette.every(entry => entry.filamentLengthMeters > 0 && entry.filamentWeightGrams > 0));
const path = preview.toolpath;
const tools = module.HEAPU8.slice(Number(path.extruder_id_ptr), Number(path.extruder_id_ptr) + path.segment_count);
assert.deepEqual([...new Set(tools)].sort(), [0, 1], 'sliced paths resolve the virtual slot to both physical components');
const next = edit('orc_add_filament_slot');
assert.equal(next.slots[count].mix, null);
assert.equal(next.slots.at(-1).logical_id, restore.slots[2].logical_id);
assert.equal(next.slots.at(-1).slot, mix.slot + 1);
assert.equal(next.assignments.objects[0].explicit_slot, 4);
assertPaint('1C');
assert.equal(call('orc_history_undo').ok, true);
assert.equal(rack().assignments.objects[0].explicit_slot, 3);
assertPaint('0C');
assert.equal(rack().slots.at(-1).slot, mix.slot);
assert.deepEqual(rack().slots.at(-1).mix.points, gradient.points);
assert.equal(call('orc_history_redo').ok, true);
assertPaint('1C');
assert.equal(rack().assignments.objects[0].explicit_slot, 4);
assert.equal(call('orc_history_undo').ok, true);
const merged = edit('orc_merge_filament_slots', { source: 2, destination: 3 });
assert.deepEqual(merged.slots[1].mix.components, [1, 0]);
assert.equal(merged.assignments.objects[0].explicit_slot, 2);
assertPaint('8');
assert.equal(call('orc_history_undo').ok, true);
assertPaint('0C');
assert.deepEqual(rack().slots.at(-1).mix.components, [1, 2]);
assert.equal(call('orc_history_redo').ok, true);
assertPaint('8');
assert.deepEqual(rack().slots[1].mix, merged.slots[1].mix);
assert.equal(call('orc_history_undo').ok, true);
const archive = call('orc_export_project', ['string'], ['{}']);
assert.equal(archive.ok, true);
const loaded = call(
  'orc_load_project',
  ['pointer', 'number', 'number', 'string'],
  [archive.bytes_ptr, archive.bytes_length, 0, 'mixed.3mf'],
);
module._free(Number(archive.bytes_ptr));
assert.equal(loaded.ok, true);
assert.deepEqual(rack().slots.at(-1).mix.points, gradient.points);
assert.equal(rack().slots.at(-1).mix.perPart, true);
const broken = edit('orc_delete_filament_slot', { slot: 2 }).slots.at(-1).mix;
assert.deepEqual(broken.components, [1, 0]);
assert.deepEqual(broken.ratios, draft.ratios);
assert.ok(broken.error);
assertPaint('8');
assert.equal(call('orc_history_undo').ok, true);
assertPaint('0C');
assert.deepEqual(rack().slots.at(-1).mix.points, gradient.points);
assert.equal(call('orc_history_redo').ok, true);
assertPaint('8');
assert.deepEqual(rack().slots.at(-1).mix, broken);
assert.match((await sliceMix()).slice.error, /Repair mixed filament/);
const brokenPlate = call('orc_get_plate_session_snapshot').current_plate_id;
const newPlate = call('orc_add_plate').plates.at(-1).plate_id;
assert.equal(call('orc_select_plate', ['string'], [newPlate]).ok, true);
assert.equal(call('orc_add_shape', ['string', 'string'], ['Cube', 'Physical only']).ok, true);
const separate = await sliceMix();
assert.equal(separate.slice.ok, true, JSON.stringify(separate.slice));
assert.doesNotMatch(JSON.stringify(separate.events), /gradient will not be printed/i);
assert.equal(call('orc_select_plate', ['string'], [brokenPlate]).ok, true);
// The fixture creates the second plate and cube directly through the ABI.
// Publish that setup as the baseline before starting a new undo sequence.
assert.equal(call('orc_history_reset', ['string'], [JSON.stringify(context)]).canUndo, false);

edit('orc_edit_mixed_filament', { operation: 'delete-all' });
assert.ok(rack().slots.every((s) => s.mix === null));
assert.equal(call('orc_history_undo').ok, true);
assert.deepEqual(rack().slots.at(-1).mix.components, [1, 0]);
// Creating slot 32 is allowed. A later physical insertion can move that
// recipe to 33 only when no facet relies on the old paint state.
edit('orc_edit_mixed_filament', { operation: 'delete-all' });
while (rack().slots.length < 31) edit('orc_add_filament_slot');
const last = edit('orc_edit_mixed_filament', { recipe: draft }).slots.at(-1);
assert.equal(last.slot, 32);
assert.equal(run('orc_edit_mixed_filament', { recipe: draft }).ok, false);
assert.equal(edit('orc_add_filament_slot').slots.at(-1).slot, 33);
assert.equal(call('orc_history_undo').ok, true);
const highPaint = writeStoredZip(
  archiveEntries().map((entry) =>
    modelEntry(entry)
      ? {
          ...entry,
          content: new TextEncoder().encode(
            decoder
              .decode(entry.content)
              .replace(/<triangle\b[^>]*\/>/g, (triangle) =>
                triangle.replace(/ paint_color="[^"]*"/g, '').replace('/>', ' paint_color="EFC"/>'),
              ),
          ),
        }
      : entry,
  ),
);
const highPtr = module._malloc(highPaint.length);
module.HEAPU8.set(highPaint, Number(highPtr));
assert.equal(
  call(
    'orc_load_project',
    ['pointer', 'number', 'number', 'string'],
    [highPtr, highPaint.length, 0, 'high-mix.3mf'],
  ).ok,
  true,
);
module._free(highPtr);
assertPaint('EFC');
const highBefore = rack();
const rejected = run('orc_add_filament_slot');
assert.equal(rejected.ok, false, JSON.stringify(rejected));
assert.deepEqual(rack(), highBefore);
const sourcePaint = writeStoredZip(archiveEntries().map(entry => modelEntry(entry) ? { ...entry,
  content: new TextEncoder().encode(decoder.decode(entry.content).replace(/<triangle\b[^>]*\/>/g,
    triangle => triangle.replace(/ paint_color="[^"]*"/g, '').replace('/>', ' paint_color="4"/>'))) } : entry));
const sourcePtr = module._malloc(sourcePaint.length);
module.HEAPU8.set(sourcePaint, Number(sourcePtr));
assert.equal(call('orc_load_project', ['pointer', 'number', 'number', 'string'],
  [sourcePtr, sourcePaint.length, 0, 'merge-boundary.3mf']).ok, true);
module._free(sourcePtr);
assertPaint('4');
edit('orc_add_filament_slot');
edit('orc_add_filament_slot');
assert.equal(rack().slots.at(-1).slot, 34);
const beforeMerge = rack();
const overflow = run('orc_merge_filament_slots', { source: 1, destination: 34 });
assert.equal(overflow.ok, false);
assert.match(overflow.error, /32/);
assert.deepEqual(rack(), beforeMerge);
assertPaint('4');
assert.equal(call('orc_clear_model').ok, true);
const restoredBroken = run('orc_apply_remembered_filament_rack', { slots: needsRepair });
assert.equal(restoredBroken.ok, true, JSON.stringify(restoredBroken));
assert.deepEqual(restoredBroken.slots[1].mix.storage, needsRepair[1].mix);
console.log('Mixed filament transactions, insertion, history and 3MF round trip passed.');
process.exit(0);
