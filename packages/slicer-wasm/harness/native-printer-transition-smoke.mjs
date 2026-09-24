// Focused real-WASM coverage for one atomic Printer + remembered-filament-rack
// transition, native history restoration of the Printer source, and project
// load priority over the app's separate remembered-rack preference.
// node harness/native-printer-transition-smoke.mjs <out/serial/orca_slice.js>
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

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
  return request('orc_select_printer_with_remembered_rack', {
    printer,
    remembered_rack: slots ? { version: 1, slots } : null,
  });
}
function setDraft(kind, canonicalName, key, value) {
  const source = draft(kind, canonicalName);
  const result = request('orc_mutate_preset_draft', {
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

assert.equal(callJson('orc_init', ['string'], ['{"log_level":"error"}']).ok, true);
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
const first = transition(targetName, [{ preset: compatiblePreset, colour: rememberedColour }]);
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
const defaultResult = transition(targetName, [{ preset: 'Missing remembered preset for default path', colour: incompatibleColour }]);
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
  const fallback = transition(targetName, [{ preset: 'Missing remembered preset for fallback path', colour: incompatibleColour }]);
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
const exported = callJson('orc_export_project');
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
