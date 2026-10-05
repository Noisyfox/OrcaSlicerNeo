// Real native capability projection. No test-only native API is needed.
// node harness/bed-type-capabilities-smoke.mjs <out/serial/orca_slice.js>
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const moduleArg = process.argv[2];
if (!moduleArg) throw new Error('usage: bed-type-capabilities-smoke.mjs <module.js>');
const repoRoot = resolve(import.meta.dirname, '../../..');
const diagnostics = [];
const Module = await (await loadModuleFactory(moduleArg))({
  noInitialRun: true, print: () => {}, printErr: (message) => diagnostics.push(message),
});
await installProfilePackages(Module, createNodeProfileSource(resolve(repoRoot, 'packages/profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
}
function must(value) { assert.equal(value.ok, true, JSON.stringify(value)); return value; }
function select(name) { return must(call('orc_select_preset', ['string', 'string'], ['printer', name])); }
function snapshot() { return must(call('orc_get_preset_snapshot')); }
function setDraft(printer, key, value) {
  const draft = must(call('orc_get_preset_draft', ['string', 'string'], ['printer', printer]));
  return must(call('orc_mutate_preset_draft', ['string'], [JSON.stringify({
    action: 'set', kind: 'printer', canonical_name: printer,
    expected_revision: draft.revision, key, value,
  })]));
}
function pass(label) { console.log(`bed-type-capabilities PASS ${label}`); }
must(call('orc_init', ['string'], ['{"log_level":"error"}']));
const metadata = call('orc_get_option_metadata');
const definition = metadata.curr_bed_type;
assert.ok(definition?.enum_values?.length > 0, JSON.stringify(metadata));
const allChoices = definition.enum_values.map((value, index) => ({ value, label: definition.enum_labels[index] }));

const u1 = 'Snapmaker U1 (0.4 nozzle)';
let selected = select(u1);
assert.deepEqual(selected.bed_type, {
  supports_selection: true, default_value: 'Textured PEI Plate', choices: allChoices,
});
pass('U1 native string default and ordered labels/serialized values');
const projectBefore = selected.project_config;
setDraft(u1, 'support_multi_bed_types', '0');
assert.equal(snapshot().bed_type.supports_selection, false);
assert.deepEqual(snapshot().project_config.curr_bed_type, projectBefore.curr_bed_type);
pass('effective draft disables selector without mutating project bed type');
setDraft(u1, 'support_multi_bed_types', '1');
assert.equal(snapshot().bed_type.supports_selection, true);
setDraft(u1, 'default_bed_type', '3');
assert.equal(snapshot().bed_type.default_value, 'High Temp Plate');
setDraft(u1, 'default_bed_type', 'Engineering Plate');
assert.equal(snapshot().bed_type.default_value, 'Engineering Plate');
setDraft(u1, 'default_bed_type', '');
assert.equal(snapshot().bed_type.default_value, 'High Temp Plate');
pass('effective numeric/string defaults and native empty-default fallback');

selected = select('Bambu Lab X1 Carbon 0.4 nozzle');
assert.equal(selected.bed_type.default_value, 'Cool Plate');
assert.deepEqual(selected.bed_type.choices, allChoices);
setDraft(selected.printer.name, 'support_multi_bed_types', '0');
assert.equal(snapshot().bed_type.supports_selection, true);
pass('Bambu visibility and model default override ordinary support flag');

selected = select('Bambu Lab A1 mini 0.4 nozzle');
// Orca compares labels. The bundled model's legacy "Cool Plate" string
// does not match today's "Smooth Cool Plate" label; retain the native rule.
assert.deepEqual(selected.bed_type.choices, allChoices.filter((choice) => choice.label !== 'Engineering Plate'));
assert.ok(selected.bed_type.choices.some((choice) => choice.value === 'Cool Plate'));
pass('real model exclusions compare labels and preserve native order');

selected = select('Snapmaker J1 (0.4 nozzle)');
assert.equal(selected.bed_type.supports_selection, false);
assert.equal(selected.bed_type.default_value, 'High Temp Plate');
pass('single-bed non-Bambu printer hides selection with native default');
console.log('bed-type-capabilities PASS all native projections');
process.exit(0);
