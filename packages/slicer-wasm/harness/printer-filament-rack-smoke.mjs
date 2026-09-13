import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const moduleArg = argv[2];
if (!moduleArg) {
  console.error('usage: node printer-filament-rack-smoke.mjs <out/orca_slice.js> [profile-package-root]');
  process.exit(2);
}

const profileRoot = resolve(argv[3] ?? resolve(import.meta.dirname, '../../profile-resources/dist'));
const factory = await loadModuleFactory(moduleArg);
const Module = await factory({ noInitialRun: true, print: console.error, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));

function callJson(name, argTypes = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  const value = JSON.parse(Module.UTF8ToString(ptr));
  Module._free(ptr);
  return value;
}

assert.equal(callJson('orc_init', ['string'], ['{"log_level":"error"}']).ok, true);
const initial = callJson('orc_get_preset_snapshot');
const names = new Set(initial.printers.map((printer) => printer.name));
const dual = 'Bambu Lab H2D Pro 0.8 nozzle';
const single = 'Bambu Lab H2S 0.2 nozzle';
assert.ok(names.has(dual) && names.has(single), 'regression printer profiles are missing');
const historyAtStart = callJson('orc_history_status');

const dualSelected = callJson('orc_select_preset', ['string', 'string'], ['printer', dual]);
assert.equal(dualSelected.ok, true, JSON.stringify(dualSelected));
const before = callJson('orc_get_filament_session_snapshot');
assert.equal(before.ok, true, JSON.stringify(before));
assert.equal(before.capabilities.nozzle_count, 2);

const selected = callJson('orc_select_preset', ['string', 'string'], ['printer', single]);
assert.equal(selected.ok, true, JSON.stringify(selected));
let rack = callJson('orc_get_filament_session_snapshot');
assert.equal(rack.ok, true, JSON.stringify(rack));
assert.equal(rack.revisions.session, before.revisions.session + 1,
  'printer transition must advance the filament session fence exactly once');
assert.ok(rack.slots.length > 0);
assert.equal(rack.capabilities.nozzle_count, 1);
assert.equal(rack.flushing.plane_count, 1);
assert.equal(rack.flushing.matrix.length, rack.slots.length ** 2);
const compatible = new Set(selected.filament_catalog.map((entry) => entry.name));
assert.ok(rack.slots.every((slot) => compatible.has(slot.preset.name)));

const staleMutation = callJson('orc_add_filament_slot', ['string'], [JSON.stringify({
  version: 1, revision: before.revisions.session,
})]);
assert.equal(staleMutation.ok, false);
assert.equal(staleMutation.error_code, 'stale_revision');
assert.deepEqual(callJson('orc_get_filament_session_snapshot'), rack,
  'stale pre-transition revision must not mutate the post-transition rack');

const nextPrint = selected.prints.find((preset) => preset.name !== selected.print.name);
assert.ok(nextPrint, 'regression printer must expose another compatible print profile');
const beforePrint = rack;
const printSelected = callJson('orc_select_preset', ['string', 'string'], ['print', nextPrint.name]);
assert.equal(printSelected.ok, true, JSON.stringify(printSelected));
rack = callJson('orc_get_filament_session_snapshot');
assert.equal(rack.revisions.session, beforePrint.revisions.session + 1,
  'print transition must advance the filament session fence exactly once');
const staleAfterPrint = callJson('orc_add_filament_slot', ['string'], [JSON.stringify({
  version: 1, revision: beforePrint.revisions.session,
})]);
assert.equal(staleAfterPrint.ok, false);
assert.equal(staleAfterPrint.error_code, 'stale_revision');
assert.deepEqual(callJson('orc_get_filament_session_snapshot'), rack,
  'stale pre-print revision must not mutate the post-transition rack');
const historyAfterProfiles = callJson('orc_history_status');
assert.equal(historyAfterProfiles.cursor, historyAtStart.cursor);
assert.equal(historyAfterProfiles.dirty, historyAtStart.dirty);
assert.deepEqual(historyAfterProfiles.undoEntries, historyAtStart.undoEntries);
assert.deepEqual(historyAfterProfiles.redoEntries, historyAtStart.redoEntries);

const historyBefore = callJson('orc_history_status');
const request = { version: 1, revision: rack.revisions.session,
  slots: rack.slots.map((slot, index) => ({ preset: slot.preset.name, colour: index === 0 ? '#123456' : slot.colour.effective })) };
const applied = callJson('orc_apply_remembered_filament_rack', ['string'], [JSON.stringify(request)]);
assert.equal(applied.ok, true, JSON.stringify(applied));
assert.equal(applied.slots[0].colour.effective, '#123456');
const historyAfter = callJson('orc_history_status');
assert.deepEqual(historyAfter.undoEntries, historyBefore.undoEntries);
assert.deepEqual(historyAfter.redoEntries, historyBefore.redoEntries);
assert.equal(historyAfter.cursor, historyBefore.cursor);
assert.ok(![...historyAfter.undoEntries, ...historyAfter.redoEntries]
  .some((entry) => entry.label === 'Restore remembered filament rack'));

const stale = callJson('orc_apply_remembered_filament_rack', ['string'], [JSON.stringify(request)]);
assert.equal(stale.ok, false);
assert.equal(stale.error_code, 'stale_revision');
assert.equal(JSON.stringify(callJson('orc_get_filament_session_snapshot')), JSON.stringify(applied));

const reset = callJson('orc_history_reset', ['string'], [JSON.stringify({
  selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null,
  projectConfigOverlay: { project: {}, objects: {}, parts: {}, plates: {} },
})]);
assert.equal(reset.dirty, false);
assert.equal(reset.canUndo, false);
assert.equal(reset.canRedo, false);
assert.equal(reset.undoEntries.length, 0);
assert.equal(reset.redoEntries.length, 0);

console.log(`printer filament rack smoke OK: ${dual} -> ${single}; remembered rack baseline is clean`);
