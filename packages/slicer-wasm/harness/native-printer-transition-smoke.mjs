import { fixtureProfileOptions } from './profile-installer.mjs';
// Focused real-WASM coverage for one atomic Printer + remembered-filament-rack
// transition, native history restoration of the Printer source, and project
// load priority over the app's separate remembered-rack preference.
// node harness/native-printer-transition-smoke.mjs <out/serial/orca_slice.js>
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { buildIndependentReader3mf } from './multi-filament-fixture-builder.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';

const editingContext = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };

const [moduleArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node harness/native-printer-transition-smoke.mjs <out/serial/orca_slice.js>');
const repoRoot = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(moduleArg))({ noInitialRun: true, print: () => {}, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(repoRoot, 'packages/profile-resources/dist')));

function callJson(name, argTypes = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
}
function request(name, body) {
  return callJson(name, ['string'], [JSON.stringify(body)]);
}
function must(condition, label, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`printer-transition PASS ${label}`);
}
function session() {
  const value = callJson('orc_get_filament_session_snapshot');
  assert.equal(value.ok, true, JSON.stringify(value));
  return value;
}
function presets() {
  const value = callJson('orc_get_preset_snapshot');
  assert.equal(value.ok, true, JSON.stringify(value));
  return value;
}
function draft(kind, name) {
  const value = callJson('orc_get_preset_draft', ['string', 'string'], [kind, name]);
  assert.equal(value.ok, true, JSON.stringify(value));
  return value;
}
function rackProjection(value = session()) {
  return value.slots.map((slot) => ({ preset: slot.preset.name, colour: slot.colour.effective }));
}
function historyContext() {
  return {
    selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
    activePlateId: null,
    gizmo: null,
    nativeScopedConfig: {},
  };
}
function resetHistory() {
  return callJson('orc_history_reset', ['string'], [JSON.stringify(historyContext())]);
}
function transition(printer, slots) {
  return request('orc_select_printer_with_remembered_rack', { history_context: editingContext,
    printer,
    remembered_bed_type: null, remembered_rack: slots ? { version: 1, slots } : null,
  });
}
function solidSlot(preset, colour) {
  return { preset, colour, native: { representative: colour, multi_colour: colour, type: '1' } };
}
function setDraft(kind, canonicalName, key, value) {
  const source = draft(kind, canonicalName);
  const result = request('orc_mutate_preset_draft', { history_context: editingContext,
    action: 'set', kind, canonical_name: canonicalName,
    expected_revision: source.revision, key, value,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
function sourceDefaultColour(name) {
  const values = draft('filament', name).effective_values;
  const firstConfiguredColour = (value) => {
    if (typeof value !== 'string' || value.length === 0) return '';
    // The native draft projection JSON-encodes ConfigOptionStrings, so a
    // one-item option may arrive as a quoted JSON string inside this field.
    let decoded = value;
    if (decoded.startsWith('"')) {
      try { decoded = JSON.parse(decoded); } catch { /* retain scalar form */ }
    }
    return typeof decoded === 'string' ? decoded.split(',')[0].trim() : '';
  };
  return firstConfiguredColour(values.default_filament_colour) ||
    firstConfiguredColour(values.filament_colour) || '#26A69A';
}

assert.equal(callJson('orc_init', ['string'], [fixtureProfileOptions(Module)]).ok, true);
assert.equal(callJson('orc_clear_model').ok, true);
const initial = presets();
const visibleFffPrinters = initial.printers.filter((item) => item.is_visible && /Bambu Lab/.test(item.name) && /0\.4 nozzle/.test(item.name));
assert.ok(visibleFffPrinters.length >= 2, `expected at least two flexible test printers: ${initial.printers.map((p) => p.name).join(' | ')}`);
const baselineName = initial.printer.name;
const targetName = visibleFffPrinters.find((item) => item.name !== baselineName)?.name;
assert.ok(targetName, 'expected an alternate visible FFF Printer preset');

// Create a real Printer draft, then prove that a direct draft mutation does
// not implicitly normalize or replace the rack. Keep this draft in the
// baseline whose native Printer source and registry will be restored by Undo.
const baselinePrinterDraft = draft('printer', baselineName);
assert.ok(Object.hasOwn(baselinePrinterDraft.source_values, 'nozzle_diameter'));
const beforeDirectEditRack = rackProjection();
const directEdit = setDraft('printer', baselineName, 'nozzle_diameter', '0.6');
must(JSON.stringify(rackProjection()) === JSON.stringify(beforeDirectEditRack),
  'direct Printer draft edits do not restore or normalize rack slots', rackProjection());
must(directEdit.history_entry_delta === 1, 'direct Printer draft edit remains its own single history operation');

// Find a rack preset that the target Printer itself reports as compatible.
const targetSelection = callJson('orc_select_preset', ['string', 'string'], ['printer', targetName]);
assert.equal(targetSelection.ok, true, JSON.stringify(targetSelection));
const targetCatalog = targetSelection.filament_catalog.map((item) => item.name);
assert.ok(targetCatalog.length > 0, JSON.stringify(targetSelection));
const compatiblePreset = targetCatalog.find((name) => name === 'Generic PLA @System') ?? targetCatalog[0];
const targetPrinterDraft = draft('printer', targetName);
const defaultFilamentName = (targetPrinterDraft.effective_values.default_filament_profile ?? '').split(',')[0].trim();
// Return to the baseline without making profile-picking noise part of the
// native transaction under test. The baseline's Printer draft remains in the
// canonical draft registry.
const baselineSelection = callJson('orc_select_preset', ['string', 'string'], ['printer', baselineName]);
assert.equal(baselineSelection.ok, true, JSON.stringify(baselineSelection));

const baselinePrintName = baselineSelection.print.name;
const baselineRack = rackProjection();
const beforeTransitionStatus = resetHistory();
const rememberedColour = '#13579B';
const first = transition(targetName, [solidSlot(compatiblePreset, rememberedColour)]);
assert.equal(first.ok, true, JSON.stringify(first));
must(first.mutation.history_entry_delta === 1 &&
  first.mutation.revision_after === beforeTransitionStatus.revision + 1 &&
  first.history_status.revision === first.mutation.revision_after,
'Printer selection, remembered rack, and all-plate invalidation commit once', first.mutation);
must(first.profile_snapshot.printer.name === targetName &&
  first.native_scoped_config.revision === first.history_status.revision,
'one receipt contains the final Printer profile and committed config snapshot', first.profile_snapshot.printer);
must(first.filament_session.slots[0].preset.name === compatiblePreset &&
  first.filament_session.slots[0].colour.effective === rememberedColour,
'compatible remembered source keeps its actual colour', first.filament_session.slots[0]);
const beforeUndoPlateIds = callJson('orc_get_plate_session_snapshot').plates.map((plate) => plate.plate_id);
must(JSON.stringify([...first.mutation.affected_plate_ids].sort()) === JSON.stringify([...beforeUndoPlateIds].sort()),
  'receipt invalidates the complete native plate set', first.mutation.affected_plate_ids);

const undone = callJson('orc_history_undo');
assert.equal(undone.ok, true, JSON.stringify(undone));
must(undone.impact.profileSelection === true && undone.profile_snapshot.printer.name === baselineName,
  'Undo restores the selected native Printer source and publishes its profile snapshot', undone.impact);
must(undone.context.nativePrinterPreset.selected === baselineName &&
  JSON.stringify(rackProjection()) === JSON.stringify(baselineRack),
  'Undo restores baseline Printer root and the complete prior rack', undone.context.nativePrinterPreset);
must(undone.context.nativePrintPreset.selected === baselinePrintName &&
  undone.profile_snapshot.print.name === baselinePrintName,
  'Undo preserves the pre-transition Process selection and native Process root',
  { nativePrintPreset: undone.context.nativePrintPreset, print: undone.profile_snapshot.print });
must(draft('printer', baselineName).effective_values.nozzle_diameter === '0.6',
  'Undo preserves the pre-transition canonical Printer draft registry');

const redone = callJson('orc_history_redo');
assert.equal(redone.ok, true, JSON.stringify(redone));
must(redone.impact.profileSelection === true && redone.profile_snapshot.printer.name === targetName,
  'Redo restores the target native Printer source and publishes its profile snapshot', redone.impact);
must(redone.context.nativePrintPreset.selected === first.profile_snapshot.print.name &&
  redone.profile_snapshot.print.name === first.profile_snapshot.print.name,
  'Redo restores the Process selection captured with the target Printer',
  { nativePrintPreset: redone.context.nativePrintPreset, print: redone.profile_snapshot.print });
must(session().slots[0].preset.name === compatiblePreset && session().slots[0].colour.effective === rememberedColour,
  'Redo restores the complete remembered rack and actual colour');

// A missing remembered name first resolves to the Printer's effective
// default_filament_profile when that default is present in the candidate set.
// The return remains native-authoritative if the profile has no installed
// default: in that case the compatible fallback below is the acceptance path.
const knownDefault = targetCatalog.includes(defaultFilamentName) ? defaultFilamentName : '';
const incompatibleColour = '#E1A72B';
const targetDraftNow = draft('printer', targetName);
const canSetDefault = Object.hasOwn(targetDraftNow.source_values, 'default_filament_profile');
if (canSetDefault && !knownDefault)
  setDraft('printer', targetName, 'default_filament_profile', compatiblePreset);
const defaultResult = transition(targetName, [solidSlot('Missing remembered preset for default path', incompatibleColour)]);
assert.equal(defaultResult.ok, true, JSON.stringify(defaultResult));
const defaultSlot = defaultResult.filament_session.slots[0];
must(defaultSlot.preset.name !== 'Missing remembered preset for default path' &&
  (knownDefault ? defaultSlot.preset.name === knownDefault :
    (canSetDefault ? defaultSlot.preset.name === compatiblePreset : targetCatalog.includes(defaultSlot.preset.name))),
  (knownDefault || canSetDefault)
    ? 'missing remembered source selects the effective Printer default filament'
    : 'missing remembered source is replaced by a native compatible fallback', defaultSlot.preset.name);
const replacementDefaultColour = sourceDefaultColour(defaultSlot.preset.name);
must(defaultSlot.colour.effective === replacementDefaultColour && defaultSlot.colour.effective !== incompatibleColour,
  'replaced source initializes actual colour from its effective Filament default',
  { slot: defaultSlot, expected: replacementDefaultColour, incompatibleColour });

// Force the target's configured default unavailable to exercise Orca's
// compatible-candidate fallback instead of the configured default branch.
if (canSetDefault) {
  setDraft('printer', targetName, 'default_filament_profile', 'Missing configured default for fallback path');
  const fallback = transition(targetName, [solidSlot('Missing remembered preset for fallback path', incompatibleColour)]);
  assert.equal(fallback.ok, true, JSON.stringify(fallback));
  const fallbackSlot = fallback.filament_session.slots[0];
  must(fallbackSlot.preset.name !== 'Missing remembered preset for fallback path' &&
    fallbackSlot.preset.name !== 'Missing configured default for fallback path' &&
    targetCatalog.includes(fallbackSlot.preset.name),
    'unavailable configured default selects the native compatible fallback candidate', fallbackSlot.preset.name);
  must(fallbackSlot.colour.effective === sourceDefaultColour(fallbackSlot.preset.name) &&
    fallbackSlot.colour.effective !== incompatibleColour,
    'compatible fallback source also initializes its effective default colour', fallbackSlot);
} else {
  console.log('printer-transition INFO target Printer has no editable default_filament_profile option; explicit fallback forcing skipped');
}

// Export a real project with the effective rack, then load it after changing
// the live profile. Project data must remain authoritative; preferences are
// only applied by the application for a later explicit Printer selection.
const finalRack = rackProjection();
assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Printer transition fixture']).ok, true);
const exported = callJson('orc_export_project', ['string'], ['{}']);
assert.equal(exported.ok, true, JSON.stringify(exported));
const projectBytes = Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + Number(exported.bytes_length));
Module._free(Number(exported.bytes_ptr));
const otherPrinterName = visibleFffPrinters.find((item) => item.name !== presets().printer.name)?.name;
if (otherPrinterName) assert.equal(callJson('orc_select_preset', ['string', 'string'], ['printer', otherPrinterName]).ok, true);
const projectPointer = Number(Module._malloc(projectBytes.length));
Module.HEAPU8.set(projectBytes, projectPointer);
let loaded;
try {
  loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [projectPointer, projectBytes.length, 0, 'printer-transition-priority.3mf']);
} finally { Module._free(projectPointer); }
assert.equal(loaded.ok, true, JSON.stringify(loaded));
must(JSON.stringify(rackProjection()) === JSON.stringify(finalRack),
  'initial project load retains its embedded rack instead of replaying remembered preferences', rackProjection());

console.log(`native Printer transition smoke passed (${moduleArg})`);

// These sources share Process/rack defaults and bed dimensions. Only Printer
// identity changes, which must still invalidate every slice input on restore.
assert.equal(callJson('orc_clear_model').ok, true);
assert.equal(transition('Bambu Lab X1 Carbon 0.4 nozzle').ok, true);
assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Printer-only undo']).ok, true);
assert.equal(resetHistory().error, undefined);
const carbon = presets();
const carbonRack = rackProjection();
const x1 = transition('Bambu Lab X1 0.4 nozzle');
assert.equal(x1.ok, true, JSON.stringify(x1));
assert.equal(x1.profile_snapshot.print.name, carbon.print.name);
assert.deepEqual(rackProjection(), carbonRack);
for (const command of ['orc_history_undo', 'orc_history_redo']) {
  const before = callJson('orc_get_plate_session_snapshot');
  const restored = callJson(command);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.impact.profileSelection, true);
  assert.deepEqual([...restored.affected_plate_ids].sort(), before.plates.map(p => p.plate_id).sort());
  const after = callJson('orc_get_plate_session_snapshot');
  for (const plate of after.plates)
    assert.ok(after.input_revisions[plate.plate_id] > before.input_revisions[plate.plate_id]);
}
const tx = callJson('orc_history_begin', ['string', 'string', 'string', 'string'],
  ['No-op abort', 'project', JSON.stringify(historyContext()), '']);
assert.equal(typeof tx.transactionId, 'string', JSON.stringify(tx));
const aborted = callJson('orc_history_abort', ['string'], [tx.transactionId]);
assert.equal(aborted.ok, true, JSON.stringify(aborted));
assert.equal(aborted.impact.model, 'none');
assert.equal(aborted.impact.profileSelection, false);
assert.equal(aborted.native_scoped_config.kind, 'full');
console.log('printer-only restore invalidation and complete no-op abort passed');

// Regression: the target Printer remembers fewer slots than the open model uses.
assert.equal(callJson('orc_clear_model').ok, true);
assert.equal(resetHistory().error, undefined);
const seed = rackProjection()[0];
const threeSlots = [solidSlot(seed.preset, seed.colour), solidSlot(seed.preset, '#234567'), solidSlot(seed.preset, '#345678')];
const expandedRack = transition('Bambu Lab X1 Carbon 0.4 nozzle', threeSlots);
assert.equal(expandedRack.ok, true, JSON.stringify(expandedRack));
for (const name of ['Removed object slot', 'Surviving object slot', 'Removed part slot'])
  assert.equal(callJson('orc_add_shape', ['string', 'string'], ['Cube', name]).ok, true);
let refs = session();
const [removed, surviving, partOwner] = refs.assignments.objects;
const part = refs.assignments.parts.find(p => p.object_id === partOwner.id);
function assign(target, slot) {
  const result = request('orc_assign_filament', { version: 1, revision: session().revisions.session,
    slot, targets: [target] });
  assert.equal(result.ok, true, JSON.stringify(result));
}
function route(target, selector, slot) {
  const result = request('orc_set_filament_routing', { version: 1, revision: session().revisions.session,
    selector, slot, targets: [target] });
  assert.equal(result.ok, true, JSON.stringify(result));
}
assign({ kind: 'object', id: removed.id }, 3);
assign({ kind: 'object', id: surviving.id }, 2);
assign({ kind: 'object', id: partOwner.id }, 2);
assign({ kind: 'model-part', id: part.id }, 3);
route({ kind: 'project', id: 0 }, 'support-interface', 3);
route({ kind: 'project', id: 0 }, 'support-base', 2);
route({ kind: 'object', id: removed.id }, 'outer-wall', 3);
route({ kind: 'model-part', id: part.id }, 'outer-wall', 3);
const beforeShortRack = session();
const beforeShortStatus = resetHistory();
const shortRack = transition('Bambu Lab X1 0.4 nozzle', threeSlots.slice(0, 2));
assert.equal(shortRack.ok, true, JSON.stringify(shortRack));
assert.equal(shortRack.mutation.revision_after, beforeShortStatus.revision + 1);
assert.equal(shortRack.mutation.history_entry_delta, 1);
const short = session();
assert.equal(short.slots.length, 2);
assert.equal(short.assignments.objects.find(o => o.id === removed.id).effective_slot, 1);
assert.equal(short.assignments.objects.find(o => o.id === surviving.id).effective_slot, 2);
assert.equal(short.assignments.parts.find(p => p.id === part.id).explicit_slot, 0);
assert.equal(short.assignments.parts.find(p => p.id === part.id).effective_slot, 2);
assert.equal(short.routing.find(r => r.target === 'project' && r.selector === 'support-interface').explicit_slot, 0);
assert.equal(short.routing.find(r => r.target === 'project' && r.selector === 'support-base').explicit_slot, 2);
assert.equal(short.routing.find(r => r.id === removed.id && r.selector === 'outer-wall').explicit_slot, 0);
assert.equal(short.routing.find(r => r.id === part.id && r.selector === 'outer-wall').explicit_slot, 0);
const referenceProjection = value => ({ rack: rackProjection(value), assignments: value.assignments, routing: value.routing });
assert.equal(callJson('orc_history_undo').ok, true);
assert.deepEqual(referenceProjection(session()), referenceProjection(beforeShortRack));
assert.equal(callJson('orc_history_redo').ok, true);
assert.deepEqual(referenceProjection(session()), referenceProjection(short));
const oneSlot = transition('Bambu Lab X1 Carbon 0.4 nozzle', [solidSlot(seed.preset, seed.colour)]);
assert.equal(oneSlot.ok, true, JSON.stringify(oneSlot));
assert.equal(session().slots.length, 1);
assert.ok(session().assignments.objects.every(o => o.effective_slot === 1));
assert.ok(session().assignments.parts.every(p => p.effective_slot === 1));
console.log('shorter remembered rack normalizes references atomically and round-trips through Undo/Redo');

// Imported painting, tool events and per-plate maps must not retain removed slots.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const entries = readZipEntries(buildIndependentReader3mf());
let facet = 0;
for (const entry of entries) if (entry.name === '3D/3dmodel.model') {
  const painted = decoder.decode(entry.content).replace(/<triangle\b[^>]*\/>/g,
    triangle => triangle.replace('/>', ` paint_color="${facet++ % 2 ? '8' : '4'}"/>`));
  entry.content = encoder.encode(painted);
}
assert.equal(facet, 12);
entries.push({ name: 'Metadata/custom_gcode_per_layer.xml', content: encoder.encode(
  '<custom_gcodes_per_layer><plate><plate_info id="1"/>' +
  '<layer top_z="0.2" type="2" extruder="1" color="#FF0000" extra="" gcode="tool_change"/>' +
  '<layer top_z="0.4" type="2" extruder="2" color="#00FF00" extra="" gcode="tool_change"/>' +
  '<mode value="MultiExtruder"/></plate></custom_gcodes_per_layer>') });
const importedBytes = writeStoredZip(entries);
const importedPointer = Number(Module._malloc(importedBytes.length));
Module.HEAPU8.set(importedBytes, importedPointer);
try {
  const imported = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [importedPointer, importedBytes.length, 0, 'short-rack-painted.3mf']);
  assert.equal(imported.ok, true, JSON.stringify(imported));
} finally { Module._free(importedPointer); }
// The minimal reader fixture omits newer runtime slot arrays. Establish a
// complete two-slot native baseline before testing history restoration.
const importedBaseline = transition('Bambu Lab X1 Carbon 0.4 nozzle', [
  solidSlot(seed.preset, '#FF0000'), solidSlot(seed.preset, '#00FF00'),
]);
assert.equal(importedBaseline.ok, true, JSON.stringify(importedBaseline));
function exportedReferences() {
  const result = callJson('orc_export_project', ['string'], ['{}']);
  assert.equal(result.ok, true, JSON.stringify(result));
  let archive;
  try {
    archive = readZipEntries(Module.HEAPU8.slice(Number(result.bytes_ptr),
      Number(result.bytes_ptr) + Number(result.bytes_length)));
  } finally { Module._free(Number(result.bytes_ptr)); }
  const text = name => decoder.decode(archive.find(e => e.name === name).content);
  return {
    paint: [...text('3D/3dmodel.model').matchAll(/paint_color="([^"]+)"/g)].map(m => m[1]),
    tools: [...text('Metadata/custom_gcode_per_layer.xml').matchAll(/extruder="(\d+)"/g)].map(m => Number(m[1])),
    // Plate routing may inherit the project map instead of serializing a redundant override.
    maps: callJson('orc_get_plate_session_snapshot').plates.map(p => p.settings.filament_map
      ?? callJson('orc_get_filament_session_snapshot').mappings.filament.join(',')),
  };
}
const importedRefs = exportedReferences();
assert.ok(importedRefs.paint.includes('8'));
assert.deepEqual(importedRefs.tools, [1, 2]);
assert.deepEqual(importedRefs.maps, ['1,1']);
assert.equal(resetHistory().error, undefined);
const paintedShortRack = transition('Bambu Lab X1 0.4 nozzle', [solidSlot(seed.preset, seed.colour)]);
assert.equal(paintedShortRack.ok, true, JSON.stringify(paintedShortRack));
const shortenedRefs = exportedReferences();
assert.ok(shortenedRefs.paint.length > 0);
assert.ok(shortenedRefs.paint.every(p => p === '4'));
assert.deepEqual(shortenedRefs.tools, [1]);
assert.deepEqual(shortenedRefs.maps, ['1']);
const importedUndo = callJson('orc_history_undo');
assert.equal(importedUndo.ok, true, JSON.stringify(importedUndo));
assert.deepEqual(exportedReferences(), importedRefs);
const importedRedo = callJson('orc_history_redo');
assert.equal(importedRedo.ok, true, JSON.stringify(importedRedo));
assert.deepEqual(exportedReferences(), shortenedRefs);
console.log('shorter rack normalizes imported painting/tool events/plate maps with complete Undo/Redo');

// Manual Sidebar flow is a narrow project command. It keeps Printer drafts,
// canonical selection and every unrelated flushing plane intact.
const flowEntries = readZipEntries(buildIndependentReader3mf());
for (const entry of flowEntries) {
  if (entry.name === 'Metadata/project_settings.config') {
    const config = JSON.parse(decoder.decode(entry.content));
    Object.assign(config, { printer_settings_id: 'Bambu Lab H2D 0.4 nozzle',
      nozzle_volume_type: ['Standard', 'Standard'], filament_map: ['1', '2'],
      filament_volume_map: ['0', '0'], filament_nozzle_map: ['0', '0'] });
    entry.content = encoder.encode(JSON.stringify(config));
  }
  if (entry.name === 'Metadata/model_settings.config') {
    entry.content = encoder.encode(decoder.decode(entry.content)
      .replace('filament_maps" value="1 1"', 'filament_maps" value="1 2"')
      .replace('</plate><assemble>', '</plate><plate><metadata key="plater_id" value="2"/>' +
        '<metadata key="plater_name" value="Empty flow plate"/><metadata key="filament_maps" value="2 1"/>' +
        '<metadata key="filament_volume_maps" value="1 1"/></plate><assemble>'));
  }
}
const flowBytes = writeStoredZip(flowEntries);
const flowPointer = Number(Module._malloc(flowBytes.length));
Module.HEAPU8.set(flowBytes, flowPointer);
try {
  const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [flowPointer, flowBytes.length, 0, 'dual-head-flow.3mf']);
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
} finally { Module._free(flowPointer); }
const flowPrinter = 'Bambu Lab H2D 0.4 nozzle';
const flowSeed = transition(flowPrinter, [solidSlot(seed.preset, '#FF0000'), solidSlot(seed.preset, '#00FF00')]);
assert.equal(flowSeed.ok, true, JSON.stringify(flowSeed));
setDraft('printer', flowPrinter, 'extruder_max_nozzle_count', '2,2');
const plateRead = () => callJson('orc_get_plate_session_snapshot');
assert.equal(plateRead().plates.length, 2, 'flow changes include a separate empty Plate');
assert.deepEqual(plateRead().plates.map(plate => plate.settings.filament_map), ['1,2', '2,1']);
const flowCommand = (index, flow, extra = {}) => request('orc_set_project_flow', { history_context: editingContext,
  index, flow, expected_revision: callJson('orc_history_status').revision, ...extra });
// Optional real-host fixtures use the same native exporter and two-head
// all-Plate contract as this harness. No private archive fields are introduced.
const fixtureArgument = argv.indexOf('--flow-fixtures');
if (fixtureArgument >= 0) {
  const directory = resolve(repoRoot, argv[fixtureArgument + 1]);
  await mkdir(directory, { recursive: true });
  assert.equal(flowCommand(0, 1).ok, true);
  assert.equal(flowCommand(1, 2).ok, true);
  const exported = callJson('orc_export_project', ['string'], ['{}']);
  assert.equal(exported.ok, true, JSON.stringify(exported));
  let bytes;
  try { bytes = Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + Number(exported.bytes_length)); }
  finally { Module._free(Number(exported.bytes_ptr)); }
  await writeFile(resolve(directory, 'valid-flow.3mf'), bytes);
  const invalid = readZipEntries(bytes);
  for (const entry of invalid) if (entry.name === 'Metadata/project_settings.config') {
    const config = JSON.parse(decoder.decode(entry.content));
    config.nozzle_volume_type = ['TPU High Flow', 'High Flow'];
    entry.content = encoder.encode(JSON.stringify(config));
  }
  await writeFile(resolve(directory, 'invalid-flow.3mf'), writeStoredZip(invalid));
  assert.equal(callJson('orc_history_undo').ok, true);
  assert.equal(callJson('orc_history_undo').ok, true);
}
const flushRead = () => request('orc_get_flushing_volumes', { version: 1, revision: session().revisions.session });
const policy = value => assert.equal(callJson('orc_set_auto_flush_policy', ['string'], [value]).ok, true);
const flowState = () => ({ profile: presets().project_config,
  printer: presets().printer, print: presets().print, modified: presets().modified_presets,
  mappings: session().mappings, flushing: session().flushing,
  plates: plateRead().plates.map(plate => ({ id: plate.plate_id, settings: plate.settings, origin: plate.origin })),
  draft: draft('printer', flowPrinter).effective_values });
for (const flushPolicy of ['all', 'color change', 'disabled']) {
  policy(flushPolicy);
  const resetFlow = flowCommand(1, 0);
  assert.equal(resetFlow.ok, true, JSON.stringify(resetFlow));
  const editor = flushRead();
  assert.equal(editor.ok, true, JSON.stringify(editor));
  assert.equal(editor.planes, 2);
  const planeSize = editor.dimension ** 2;
  const custom = editor.matrix.map((_, index) => Math.floor(index / editor.dimension) % editor.dimension === index % editor.dimension ? 0 : 900 + index);
  const saved = request('orc_set_flushing_volumes', { version: 1, revision: session().revisions.session,
    matrix: custom, multipliers: [0.75, 1.25] });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const beforeFlow = flowState();
  const beforeHistory = callJson('orc_history_status');
  const changed = flowCommand(1, 1);
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(changed.mutation.kind, 'set-project-flow');
  assert.equal(changed.mutation.history_entry_delta, 1);
  assert.equal(changed.mutation.revision_before, beforeHistory.revision);
  assert.equal(changed.mutation.revision_after, beforeHistory.revision + 1);
  assert.equal(changed.history_status.dirty, true);
  assert.equal(changed.native_scoped_config.kind, 'full');
  assert.equal(changed.native_scoped_config.revision, changed.history_status.revision);
  assert.deepEqual(changed.mutation.affected_plate_ids, plateRead().plates.map(plate => plate.plate_id).sort());
  assert.deepEqual(changed.plate_session.affected_plate_ids, changed.mutation.affected_plate_ids);
  assert.deepEqual(changed.profile_snapshot.printer, beforeFlow.printer, 'flow command keeps canonical Printer');
  assert.equal(changed.profile_snapshot.project_config.nozzle_volume_type, 'Standard,High Flow');
  assert.deepEqual(changed.filament_session.mappings.volume, [0, 1]);
  assert.deepEqual(plateRead().plates.map(plate => plate.settings.filament_volume_map), ['0,1', '1,1'], 'all Plates use their own head routing');
  const afterFlush = flushRead();
  assert.deepEqual(afterFlush.matrix.slice(0, planeSize), custom.slice(0, planeSize), 'unaffected custom flushing plane survives');
  assert.deepEqual(afterFlush.multipliers, [0.75, 1.25], 'flow does not normalize flushing multipliers');
  if (flushPolicy === 'all') {
    assert.deepEqual(afterFlush.matrix.slice(planeSize), afterFlush.defaults.slice(planeSize));
    assert.notDeepEqual(afterFlush.matrix.slice(planeSize), custom.slice(planeSize));
  } else assert.deepEqual(afterFlush.matrix, custom, `${flushPolicy} does not recalculate for flow`);
  const afterFlow = flowState();
  assert.deepEqual(afterFlow.draft, beforeFlow.draft, 'flow selection does not edit or browse Printer draft');
  const flowUndoReceipt = callJson('orc_history_undo');
  assert.equal(flowUndoReceipt.ok, true);
  assert.equal(flowUndoReceipt.impact.profileSelection, false);
  assert.equal(flowUndoReceipt.impact.presetDrafts, false);
  assert.equal(flowUndoReceipt.profile_snapshot.printer_picker.flows[1].actual, 0, 'flow-only Undo publishes actual SF in its native receipt');
  assert.deepEqual(flowState(), beforeFlow, 'one Undo restores flow, every Plate mapping and custom flushing together');
  const flowRedoReceipt = callJson('orc_history_redo');
  assert.equal(flowRedoReceipt.ok, true);
  assert.equal(flowRedoReceipt.impact.profileSelection, false);
  assert.equal(flowRedoReceipt.profile_snapshot.printer_picker.flows[1].actual, 1, 'flow-only Redo publishes actual HF in its native receipt');
  assert.deepEqual(flowState(), afterFlow, 'one Redo restores the complete accepted flow state');
}
const hybrid = flowCommand(1, 2);
assert.equal(hybrid.ok, true, JSON.stringify(hybrid));
assert.equal(hybrid.profile_snapshot.project_config.nozzle_volume_type, 'Standard,Hybrid');
assert.deepEqual(hybrid.filament_session.mappings.volume, [0, 0]);
assert.deepEqual(plateRead().plates.map(plate => plate.settings.filament_volume_map), ['0,0', '0,1'], 'Hybrid uses concrete Standard on every Plate');
const headZero = flowCommand(0, 1);
assert.equal(headZero.ok, true, JSON.stringify(headZero));
assert.equal(headZero.profile_snapshot.project_config.nozzle_volume_type, 'High Flow,Hybrid', 'physical head zero leaves the other actual flow intact');
assert.deepEqual(plateRead().plates.map(plate => plate.settings.filament_volume_map), ['1,0', '0,1']);
const e3d = flowCommand(0, 5);
assert.equal(e3d.ok, true, JSON.stringify(e3d));
assert.equal(e3d.profile_snapshot.project_config.nozzle_volume_type, 'E3D High Flow,Hybrid', 'E3D uses native enum 5 rather than combo position 4');
assert.deepEqual(e3d.filament_session.mappings.volume, [5, 0]);
assert.deepEqual(plateRead().plates.map(plate => plate.settings.filament_volume_map), ['5,0', '0,5']);
const sameChoiceBefore = flowState();
const sameChoiceRevision = callJson('orc_history_status').revision;
const sameChoice = flowCommand(0, 5);
assert.equal(sameChoice.ok, true, JSON.stringify(sameChoice));
assert.equal(sameChoice.mutation.history_entry_delta, 1, 'an explicit repeated selection keeps the existing manual-command receipt contract');
assert.equal(sameChoice.history_status.revision, sameChoiceRevision + 1);
assert.deepEqual(flowState(), sameChoiceBefore, 'reselecting the actual flow keeps semantic values unchanged');
policy('all'); // The late injected failure must also roll back recalculated flushing.
for (const invalid of [{ index: -1 }, { index: 2 }, { flow: 4 }, { flow: 0.5 },
  { expected_revision: callJson('orc_history_status').revision - 1 }, { inject_failure_stage: 'before-publication' }]) {
  const before = { state: flowState(), plates: plateRead(), history: callJson('orc_history_status') };
  const rejected = flowCommand(1, 1, invalid);
  assert.equal(rejected.ok, false, JSON.stringify(rejected));
  assert.deepEqual(flowState(), before.state, 'rejection restores every flow/mapping/flush value');
  assert.deepEqual(plateRead(), before.plates, 'rejection restores plate input revisions and presentation lifecycle');
  assert.deepEqual(callJson('orc_history_status'), before.history, 'rejection leaves history and dirty status untouched');
}
console.log('manual project flow passed: both heads, all Plates, Hybrid mappings, per-head flushing policies, atomic rejection/publication rollback, exact Undo/Redo');

// Base-name memory is host-owned configuration, outside project history.
const flowMemory = { [flowPrinter]: [1, 1] };
const configureFlows = (memory, initialize_new_project = false) => {
  const result = request('orc_configure_project_flow_memory', { memory, initialize_new_project });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
const loadFlowBytes = bytes => {
  const pointer = Number(Module._malloc(bytes.length)); Module.HEAPU8.set(bytes, pointer);
  try { return callJson('orc_load_project', ['pointer', 'number', 'number', 'string'], [pointer, bytes.length, 0, 'flow-lifecycle.3mf']); }
  finally { Module._free(pointer); }
};
configureFlows(flowMemory);
let validOpen = loadFlowBytes(flowBytes);
assert.equal(validOpen.ok, true, JSON.stringify(validOpen));
assert.equal(validOpen.preset_snapshot.project_config.nozzle_volume_type, 'Standard,Standard', 'valid file flow takes priority over local memory');
assert.equal(validOpen.history_status.dirty, false);
assert.deepEqual(validOpen.history_status.undoEntries, []);
let sameBase = transition(flowPrinter, null);
assert.equal(sameBase.ok, true, JSON.stringify(sameBase));
assert.equal(sameBase.profile_snapshot.project_config.nozzle_volume_type, 'Standard,Standard', 'same-base explicit selection retains valid live file flows');
const otherBase = transition('Bambu Lab H2D 0.6 nozzle', null);
assert.equal(otherBase.ok, true, JSON.stringify(otherBase));
const restoredBase = transition(flowPrinter, null);
assert.equal(restoredBase.ok, true, JSON.stringify(restoredBase));
assert.equal(restoredBase.profile_snapshot.project_config.nozzle_volume_type, 'High Flow,High Flow', 'explicit base change restores its own memory');

// Fresh-project initialization is explicit, history-free, and uses defaults
// for unremembered physical heads; unavailable memory still follows repair.
assert.equal(callJson('orc_close_project').ok, true);
assert.equal(callJson('orc_select_preset', ['string', 'string'], ['printer', flowPrinter]).ok, true);
const freshHistory = callJson('orc_history_status');
configureFlows({ [flowPrinter]: [1] }, true);
assert.equal(presets().project_config.nozzle_volume_type, 'High Flow,Standard');
assert.deepEqual(callJson('orc_history_status'), freshHistory, 'initialization creates no history frame');
configureFlows({ [flowPrinter]: [0, 0] });
const repairFlush = flushRead();
const repairCustom = repairFlush.matrix.map((_, index) => Math.floor(index / repairFlush.dimension) % repairFlush.dimension === index % repairFlush.dimension ? 0 : 1200 + index);
assert.equal(request('orc_set_flushing_volumes', { version: 1, revision: session().revisions.session,
  matrix: repairCustom, multipliers: repairFlush.multipliers }).ok, true);
const beforeRepair = flowState();
const beforeRepairHistory = callJson('orc_history_status');
const repairedDiameter = setDraft('printer', flowPrinter, 'printer_variant', '0.2');
assert.equal(repairedDiameter.history_entry_delta, 1);
assert.equal(presets().project_config.nozzle_volume_type, 'Standard,Standard');
assert.deepEqual(session().flushing.matrix.slice(4), repairCustom.slice(4), 'candidate-only active draft repair preserves the other custom flushing plane');
assert.equal(callJson('orc_history_status').undoEntries.length, beforeRepairHistory.undoEntries.length + 1);
const afterRepair = flowState();
assert.equal(callJson('orc_history_undo').ok, true);
assert.deepEqual(flowState(), beforeRepair, 'Undo restores Printer variant, flow and mappings as one initiating transaction');
assert.equal(presets().project_config.nozzle_volume_type, 'High Flow,Standard', 'history does not apply the newer Standard memory');
assert.equal(callJson('orc_history_redo').ok, true);
assert.deepEqual(flowState(), afterRepair);
for (const flushPolicy of ['color change', 'disabled']) {
  policy(flushPolicy);
  setDraft('printer', flowPrinter, 'printer_variant', '0.4');
  assert.equal(flowCommand(0, 1).ok, true);
  const editor = flushRead();
  const custom = editor.matrix.map((_, index) => Math.floor(index / editor.dimension) % editor.dimension === index % editor.dimension ? 0 : 1300 + index);
  assert.equal(request('orc_set_flushing_volumes', { version: 1, revision: session().revisions.session,
    matrix: custom, multipliers: editor.multipliers }).ok, true);
  setDraft('printer', flowPrinter, 'printer_variant', '0.2');
  assert.deepEqual(session().flushing.matrix, custom, `${flushPolicy} suppresses automatic repair flushing`);
}
policy('all');
setDraft('printer', flowPrinter, 'printer_variant', '0.4');
assert.equal(flowCommand(0, 1).ok, true);
setDraft('printer', flowPrinter, 'default_nozzle_volume_type', 'E3D High Flow,Standard');
const nativeDefaultRepair = setDraft('printer', flowPrinter, 'printer_model', 'Bambu Lab X1E');
assert.equal(nativeDefaultRepair.history_entry_delta, 1);
assert.equal(presets().printer_picker.flows[0].actual, 5, 'repair prefers available native default E3D over first Standard');
setDraft('printer', flowPrinter, 'extruder_variant_list', '"Direct Drive High Flow";"Direct Drive Standard"');
assert.deepEqual(presets().printer_picker.flows[0].choices, []);
assert.equal(presets().printer_picker.flows[0].actual, 5, 'empty candidates preserve raw actual without repair');
setDraft('printer', flowPrinter, 'printer_model', 'Bambu Lab H2D');
assert.equal(presets().printer_picker.flows[0].actual, 1, 'unavailable default falls back to first native candidate');
const inactiveFlush = flushRead();
const inactiveCustom = inactiveFlush.matrix.map((_, index) => Math.floor(index / inactiveFlush.dimension) % inactiveFlush.dimension === index % inactiveFlush.dimension ? 0 : 1400 + index);
assert.equal(request('orc_set_flushing_volumes', { version: 1, revision: session().revisions.session,
  matrix: inactiveCustom, multipliers: inactiveFlush.multipliers }).ok, true);
const activeConfigBeforeInactiveEdit = presets().project_config;
setDraft('printer', 'Bambu Lab P1P 0.4 nozzle', 'printer_variant', '0.2');
assert.deepEqual(presets().project_config, activeConfigBeforeInactiveEdit, 'inactive Printer browsing/editing cannot repair active project flow');

// An invalid imported flow is repaired silently before the replacement root.
// This root has no saved checkpoint and no separate repair entry; only an
// explicit successful save may establish a saved checkpoint afterward.
const repairedEntries = readZipEntries(flowBytes);
for (const entry of repairedEntries) if (entry.name === 'Metadata/project_settings.config') {
  const config = JSON.parse(decoder.decode(entry.content));
  config.nozzle_volume_type = ['TPU High Flow', 'High Flow'];
  config.flush_volumes_matrix = ['0', '901', '902', '0', '0', '905', '906', '0'];
  entry.content = encoder.encode(JSON.stringify(config));
}
const repairedOpen = loadFlowBytes(writeStoredZip(repairedEntries));
assert.equal(repairedOpen.ok, true, JSON.stringify(repairedOpen));
assert.equal(repairedOpen.preset_snapshot.project_config.nozzle_volume_type, 'Standard,High Flow');
assert.equal(repairedOpen.history_status.dirty, true, 'repaired open remains unsaved');
assert.equal(repairedOpen.history_status.savedCheckpoint, null);
assert.deepEqual(repairedOpen.history_status.undoEntries, [], 'repair does not create an independently undoable entry');
assert.deepEqual(session().flushing.matrix.slice(4), [0, 905, 906, 0], 'import repair preserves the other head custom flushing plane');
assert.deepEqual(plateRead().plates.map(plate => plate.settings.filament_volume_map), ['0,0', '1,0']);
const pureRepairedOpen = { project: presets(), session: session(), plates: plateRead(), history: callJson('orc_history_status') };
assert.deepEqual({ project: presets(), session: session(), plates: plateRead(), history: callJson('orc_history_status') }, pureRepairedOpen);
const savedRepair = callJson('orc_export_project', ['string'], ['{}']);
assert.equal(savedRepair.ok, true, JSON.stringify(savedRepair));
let savedRepairBytes;
try { savedRepairBytes = Module.HEAPU8.slice(Number(savedRepair.bytes_ptr), Number(savedRepair.bytes_ptr) + Number(savedRepair.bytes_length)); }
finally { Module._free(Number(savedRepair.bytes_ptr)); }
assert.equal(callJson('orc_history_status').dirty, true, 'export preparation alone does not save the corrected file');
assert.equal(callJson('orc_history_mark_saved', ['string'], [JSON.stringify(editingContext)]).dirty, false);
const reopenedRepair = loadFlowBytes(savedRepairBytes);
assert.equal(reopenedRepair.ok, true, JSON.stringify(reopenedRepair));
assert.equal(reopenedRepair.preset_snapshot.project_config.nozzle_volume_type, 'Standard,High Flow');
assert.equal(reopenedRepair.history_status.dirty, false, 'corrected saved archive reopens clean');
assert.deepEqual(plateRead().plates.map(plate => plate.settings.filament_volume_map), ['0,0', '1,0']);
assert.ok(!decoder.decode(readZipEntries(savedRepairBytes).find(entry => entry.name === 'Metadata/project_settings.config').content).includes('sidebar_flow_memory'));
console.log('flow lifecycle passed: memory/base lifetime, active-only default/first repair, one-frame history, valid-file priority, dirty repaired open, custom flushing and native save/reopen');

// True concrete enum identities survive the native Plate metadata round-trip,
// including Plates whose map mode continues to inherit from the project.
const concreteRack = transition(flowPrinter, [solidSlot(seed.preset, '#FF0000'), solidSlot(seed.preset, '#00FF00')]);
assert.equal(concreteRack.ok, true, JSON.stringify(concreteRack));
setDraft('printer', flowPrinter, 'extruder_variant_list', '"Direct Drive Standard;Direct Drive E3D High Flow";"Direct Drive High Flow"');
const concreteFlow = flowCommand(0, 5);
assert.equal(concreteFlow.ok, true, JSON.stringify(concreteFlow));
const concreteBeforeSave = plateRead().plates.map(plate => plate.settings);
const concreteSave = callJson('orc_export_project', ['string'], ['{}']);
assert.equal(concreteSave.ok, true, JSON.stringify(concreteSave));
let concreteBytes;
try { concreteBytes = Module.HEAPU8.slice(Number(concreteSave.bytes_ptr), Number(concreteSave.bytes_ptr) + Number(concreteSave.bytes_length)); }
finally { Module._free(Number(concreteSave.bytes_ptr)); }
assert.equal(loadFlowBytes(concreteBytes).ok, true);
assert.equal(presets().project_config.nozzle_volume_type, 'E3D High Flow,High Flow');
assert.deepEqual(plateRead().plates.map(plate => plate.settings), concreteBeforeSave, 'all local maps and inherited mode survive native save/reopen');
console.log('native concrete enum and inherited Plate mode save/reopen passed');

assert.equal(callJson('orc_test_inject_project_commit_failure').ok, true);
const rejectedRepairOpen = loadFlowBytes(writeStoredZip(repairedEntries));
assert.equal(rejectedRepairOpen.ok, undefined);
assert.match(rejectedRepairOpen.error, /injected project commit failure/);
assert.equal(callJson('orc_history_status').dirty, false, 'failed repaired import rolls back to the closed clean root');
assert.deepEqual(callJson('orc_history_status').undoEntries, []);
assert.equal(callJson('orc_get_model_structure').objects.length, 0);
console.log('repaired import late publication rollback passed');

// Drive/variant bindings are real flushing inputs, even when the actual flow
// remains Standard. Inspect the native expanded configuration as the oracle.
assert.equal(loadFlowBytes(flowBytes).ok, true);
assert.equal(transition(flowPrinter, [solidSlot(seed.preset, '#FF0000'), solidSlot(seed.preset, '#00FF00')]).ok, true);
setDraft('printer', flowPrinter, 'extruder_type', 'Direct Drive,Direct Drive');
setDraft('printer', flowPrinter, 'extruder_variant_list', '"Direct Drive Standard,Bowden Standard";"Direct Drive Standard"');
setDraft('printer', flowPrinter, 'printer_extruder_variant', '"Direct Drive Standard";"Bowden Standard";"Direct Drive E3D High Flow";"Direct Drive Standard";"Direct Drive High Flow";"Direct Drive TPU High Flow";"Direct Drive E3D High Flow"');
setDraft('printer', flowPrinter, 'nozzle_volume', '130,900,133,145,148,148,148');
assert.equal(presets().project_config.nozzle_volume_type, 'Standard,Standard');
assert.equal(presets().project_config.nozzle_volume, '130,145', 'Direct Drive binds the first real nozzle-volume variant');
for (const flushPolicy of ['all', 'color change', 'disabled']) {
  policy(flushPolicy);
  setDraft('printer', flowPrinter, 'extruder_type', 'Direct Drive,Direct Drive');
  const beforeDrive = flushRead();
  const custom = beforeDrive.matrix.map((_, index) => Math.floor(index / beforeDrive.dimension) % beforeDrive.dimension === index % beforeDrive.dimension ? 0 : 1550 + index);
  assert.equal(request('orc_set_flushing_volumes', { version: 1, revision: session().revisions.session,
    matrix: custom, multipliers: beforeDrive.multipliers }).ok, true);
  setDraft('printer', flowPrinter, 'extruder_type', 'Bowden,Direct Drive');
  assert.equal(presets().project_config.nozzle_volume_type, 'Standard,Standard', 'drive change retains valid actual flows');
  assert.equal(presets().project_config.nozzle_volume, '900,145', 'Bowden binds its distinct native nozzle-volume variant');
  const afterDrive = flushRead();
  assert.notDeepEqual(afterDrive.defaults.slice(0, 4), beforeDrive.defaults.slice(0, 4), 'native minimum input changes the calculated flushing plane');
  assert.deepEqual(afterDrive.matrix, flushPolicy === 'all' ? afterDrive.defaults : custom, 'drive edits retain existing generic automatic flushing policy');
}
console.log('drive-bound native flushing passed: effective nozzle_volume 130 -> 900 with unchanged Standard flow, all three policies');

// User-preset deletion is another rollback-safe active Printer transition.
// Use its actual native fallback, with one physical head before and after.
policy('all');
assert.equal(callJson('orc_close_project').ok, true);
const deleteFallback = presets().printers.find(row => row.is_visible && !row.name.includes('[snapshot')).name;
assert.equal(callJson('orc_select_preset', ['string', 'string'], ['printer', deleteFallback]).ok, true);
let lastUserPresetChange;
const userPreset = (action, canonical_name, extra = {}, commit = true) => {
  const prepared = request('orc_prepare_user_preset', { history_context: editingContext, action, kind: 'printer',
    canonical_name, expected_revision: callJson('orc_history_status').revision, ...extra });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  lastUserPresetChange = prepared.change;
  const finished = request('orc_finish_user_preset', { token: prepared.token, commit });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  return prepared.result;
};
const localFlowPrinter = 'Neo Flow Delete Printer';
userPreset('save-as', deleteFallback, { name: localFlowPrinter });
const localFlowFile = `/user/default/${lastUserPresetChange.path}`;
const localFlowFileBeforeDelete = Module.FS.readFile(localFlowFile, { encoding: 'utf8' });
setDraft('printer', localFlowPrinter, 'printer_variant', '0.4');
setDraft('printer', localFlowPrinter, 'printer_model', 'Bambu Lab H2D');
setDraft('printer', localFlowPrinter, 'extruder_type', 'Direct Drive');
setDraft('printer', localFlowPrinter, 'extruder_variant_list', 'Direct Drive Standard,Direct Drive High Flow');
assert.equal(flowCommand(0, 1).ok, true);
const beforeDelete = { config: presets().project_config, mappings: session().mappings,
  flushing: session().flushing, plates: plateRead(), history: callJson('orc_history_status') };
userPreset('delete', localFlowPrinter, {}, false);
assert.deepEqual({ config: presets().project_config, mappings: session().mappings,
  flushing: session().flushing, plates: plateRead(), history: callJson('orc_history_status') }, beforeDelete,
  'rejected durable deletion restores flow, mappings, flushing, Plates and history');
assert.equal(presets().printer.name, localFlowPrinter);
assert.equal(Module.FS.readFile(localFlowFile, { encoding: 'utf8' }), localFlowFileBeforeDelete, 'rejected durable transaction retains the saved JSON');
const deletedFlow = userPreset('delete', localFlowPrinter);
assert.equal(deletedFlow.history_entry_delta, 1);
assert.equal(Module.FS.analyzePath(localFlowFile).exists, false, 'accepted durable deletion removes only the user head file');
assert.equal(deletedFlow.profile_snapshot.printer.name, deleteFallback);
assert.ok(!deletedFlow.profile_snapshot.printer_picker.flows[0].choices.some(choice => choice.value === 1), 'native fallback rejects the deleted source High Flow');
assert.equal(deletedFlow.profile_snapshot.printer_picker.flows[0].actual, 0);
assert.equal(deletedFlow.history_status.undoEntries.length, beforeDelete.history.undoEntries.length + 1, 'deletion repair has no extra history entry');
const afterDelete = { config: presets().project_config, mappings: session().mappings,
  flushing: session().flushing, plates: plateRead().plates.map(plate => plate.settings) };
assert.equal(callJson('orc_history_undo').ok, true);
assert.equal(presets().printer_picker.flows[0].actual, 1, 'Undo restores retained source and High Flow together');
assert.match(presets().printer.name, /Neo Flow Delete Printer \[snapshot /, 'Undo uses the existing retained source identity');
assert.deepEqual(presets().project_config, { ...beforeDelete.config,
  printer_settings_id: presets().printer.name }, 'every effective value is restored alongside the retained identity');
assert.deepEqual(session().mappings, beforeDelete.mappings);
assert.deepEqual(session().flushing, beforeDelete.flushing);
assert.equal(callJson('orc_history_redo').ok, true);
assert.deepEqual({ config: presets().project_config, mappings: session().mappings,
  flushing: session().flushing, plates: plateRead().plates.map(plate => plate.settings) }, afterDelete);
console.log('active user Printer deletion flow repair passed: native fallback, one frame, exact Undo/Redo and rejected durable transaction rollback');
