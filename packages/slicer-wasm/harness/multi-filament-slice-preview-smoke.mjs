// Step 7 real-WASM slice/Preview semantics smoke.
// node multi-filament-slice-preview-smoke.mjs --module out/serial/orca_slice.js
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const options = {};
for (let i = 2; i < argv.length; i += 2) options[argv[i]?.replace(/^--/, '')] = argv[i + 1];
if (!options.module) throw new Error('usage: node multi-filament-slice-preview-smoke.mjs --module out/serial/orca_slice.js');
const repoRoot = resolve(import.meta.dirname, '../../..');
const factory = await loadModuleFactory(resolve(options.module));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(options['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`)));

function callJson(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const value = JSON.parse(Module.UTF8ToString(ptr));
  Module._free(ptr);
  return value;
}
function request(name, body) { return callJson(name, ['string'], [JSON.stringify(body)]); }
function readBytes(ptr, bytes) {
  if (!ptr || bytes <= 0) return new Uint8Array();
  const result = Module.HEAPU8.slice(Number(ptr), Number(ptr) + bytes);
  Module._free(ptr);
  return result;
}

const init = callJson('orc_init', ['string'], ['{"log_level":"error"}']);
assert.equal(init.ok, true, JSON.stringify(init));
const presets = callJson('orc_get_preset_snapshot');
const printer = presets.printers.find((entry) => /Bambu Lab P1P 0\.4 nozzle/.test(entry.name))
  ?? presets.printers.find((entry) => /Bambu Lab/.test(entry.name));
assert.ok(printer, 'a Bambu multi-material-capable fixture printer is required');
assert.equal(callJson('orc_select_preset', ['string', 'string'], ['printer', printer.name]).ok, true);

let session = callJson('orc_get_filament_session_snapshot');
const primary = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Primary material']);
assert.equal(primary.ok, true, JSON.stringify(primary));
const oneSlotSlice = callJson('orc_slice', ['string'], ['{}']);
assert.equal(oneSlotSlice.ok, true, JSON.stringify(oneSlotSlice));
const oneSlotPreview = callJson('orc_get_slice_result');
assert.equal(oneSlotPreview.ok, true, JSON.stringify(oneSlotPreview));
const oneSlotCount = Number(oneSlotPreview.toolpath?.segment_count ?? 0);
const oneSlotTools = [...new Set(new Uint8Array(readBytes(oneSlotPreview.toolpath.extruder_id_ptr, oneSlotCount)))];
assert.ok(oneSlotCount > 0 && oneSlotTools.length === 1 && oneSlotTools[0] === 0,
  JSON.stringify({ oneSlotCount, oneSlotTools }));

while (session.slots.length < 2) {
  const added = request('orc_add_filament_slot', { version: 1, revision: session.revisions.session });
  assert.equal(added.ok, true, JSON.stringify(added));
  session = added.result.snapshot;
}
const alternate = session.slots[1];
assert.ok(alternate, JSON.stringify(session));
for (const [slot, colour] of [[1, '#FF0000'], [alternate.slot, '#0000FF']]) {
  const coloured = request('orc_set_filament_slot_colour', {
    version: 1, revision: session.revisions.session, slot, colour,
  });
  assert.equal(coloured.ok, true, JSON.stringify(coloured));
  session = coloured.result.snapshot;
}
// Deliberately make the two slots' recommended temperature ranges disjoint.
// The first slice still uses only slot 1 and must pass; after the second
// object is assigned slot 2, native Print::validate must reject the same
// inputs with its existing mixed-temperature error.
const mixedTemperatureConfig = {
  nozzle_temperature: [200, 300],
  nozzle_temperature_initial_layer: [200, 300],
  nozzle_temperature_range_low: [190, 290],
  nozzle_temperature_range_high: [210, 310],
  filament_type: ['PLA', 'ABS'],
};
const unusedIncompatible = callJson('orc_slice', ['string'], [JSON.stringify(mixedTemperatureConfig)]);
assert.equal(unusedIncompatible.ok, true, JSON.stringify(unusedIncompatible));
const secondary = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Secondary material']);
assert.equal(secondary.ok, true, JSON.stringify(secondary));
const structure = callJson('orc_get_model_structure');
assert.equal(structure.ok, true, JSON.stringify(structure));
assert.ok(structure.objects.length >= 2, JSON.stringify(structure));
session = callJson('orc_get_filament_session_snapshot');
const second = structure.objects[1];
const assigned = request('orc_assign_filament', {
  version: 1, revision: session.revisions.session, slot: alternate.slot,
  targets: [{ kind: 'object', id: second.id }],
});
assert.equal(assigned.ok, true, JSON.stringify(assigned));
session = assigned.result.snapshot;
assert.equal(session.assignments.objects.find((entry) => entry.id === second.id)?.effective_slot, alternate.slot);

const tower = callJson('orc_set_project_config_override', ['string', 'string', 'string', 'string'],
  ['project', '', 'enable_prime_tower', '1']);
assert.equal(tower.ok, true, JSON.stringify(tower));

const sliced = callJson('orc_slice', ['string'], [JSON.stringify(mixedTemperatureConfig)]);
// Native bridge errors use the existing error-only envelope (the typed client
// interprets it as SliceResultStatus.ok === false); preserve that contract
// while asserting the exact Print::validate message below.
assert.equal(Boolean(sliced.ok), false, JSON.stringify(sliced));
assert.equal(sliced.error,
  "Selected nozzle temperatures are incompatible. Each filament's nozzle temperature must fall within the recommended nozzle temperature range of the other filaments. Otherwise, nozzle clogging or printer damage may occur. If you still want to print, you can enable the option in Preferences / Control / Slicing / Remove mixed temperature restriction.");
// The same native error is the existing slice status; no bridge-side warning
// or bypass decision is introduced by the multi-filament integration.
const validForPreview = callJson('orc_slice', ['string'], ['{}']);
assert.equal(validForPreview.ok, true, JSON.stringify(validForPreview));
const preview = callJson('orc_get_slice_result');
assert.equal(preview.ok, true, JSON.stringify(preview));
assert.equal(preview.preview_version, 2, JSON.stringify(preview));
const count = Number(preview.toolpath?.segment_count ?? 0);
assert.ok(count > 0, JSON.stringify(preview));
const extruderIds = new Uint8Array(readBytes(preview.toolpath.extruder_id_ptr, count));
const moveTypes = new Uint8Array(readBytes(preview.toolpath.move_type_ptr, count));
// Slic3r::EMoveType::Extrude is 10 in the pinned Orca source. Travel and
// tool-change moves carry an extruder id too, so only extrusion moves prove
// that both assigned objects retained their native tool through export.
const extrusionTools = [...new Set(extruderIds.filter((_, index) => moveTypes[index] === 10))]
  .sort((a, b) => a - b);
const uniqueTools = [...new Set(extruderIds)].sort((a, b) => a - b);
assert.ok(uniqueTools.includes(0) && uniqueTools.includes(alternate.slot - 1), JSON.stringify({ uniqueTools, alternate: alternate.slot }));
assert.ok(extrusionTools.includes(0) && extrusionTools.includes(alternate.slot - 1), JSON.stringify({ extrusionTools, uniqueTools }));
const palette = preview.metadata?.extruder_palette ?? [];
assert.deepEqual(palette.find((entry) => entry.tool === 0)?.color, [255, 0, 0], JSON.stringify(palette));
assert.deepEqual(palette.find((entry) => entry.tool === alternate.slot - 1)?.color, [0, 0, 255], JSON.stringify(palette));
assert.notDeepEqual(
  palette.find((entry) => entry.tool === 0)?.color,
  palette.find((entry) => entry.tool === alternate.slot - 1)?.color,
  JSON.stringify(palette),
);

const gcode = Buffer.from(Module.FS.readFile('/out.gcode')).toString('utf8');
const toolChanges = [...gcode.matchAll(/^T(\d+)\s*$/gm)]
  .map((match) => Number(match[1]))
  .filter((tool) => tool >= 0 && tool < 64);
assert.ok(toolChanges.includes(alternate.slot - 1), `tool change for slot ${alternate.slot} missing`);
assert.ok(/(?:M104|M109)\s+S\d+/i.test(gcode), 'temperature commands missing');
assert.match(gcode, /(?:wipe tower|prime tower|flush)/i, 'flushing/prime-tower semantics missing from generated G-code');

console.log(JSON.stringify({
  printer: printer.name,
  slots: session.slots.length,
  layers: preview.layers,
  segments: count,
  oneSlot: { segments: oneSlotCount, tools: oneSlotTools },
  tools: uniqueTools,
  extrusionTools,
  toolChanges,
  palette,
  gcodeSemantics: { temperature: true, flushingOrPrimeTower: true },
}, null, 2));
