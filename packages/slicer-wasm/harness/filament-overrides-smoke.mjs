import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';

const root = resolve(import.meta.dirname, '../../..');
const Module = await (await loadModuleFactory(resolve(process.argv[2] ?? `${root}/packages/slicer-wasm/out/serial/orca_slice.js`)))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(`${root}/packages/profile-resources/dist`));
function call(name, typesOrArgs = [], explicitArgs) {
  const args = explicitArgs ?? typesOrArgs;
  const types = explicitArgs ? typesOrArgs : args.map(() => 'string');
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
}
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
ok(call('orc_init', [fixtureProfileOptions(Module)]));
const profile = ok(call('orc_get_preset_snapshot'));
const printer = profile.printer.name, filament = 'Generic PLA @System';
const history = () => call('orc_history_status');
const read = (kind = 'filament', name = filament) => ok(call('orc_get_preset_draft', [kind, name]));
const mutate = (kind, canonical_name, fields) => ok(call('orc_mutate_preset_draft', [JSON.stringify({ history_context: context,
  kind, canonical_name, expected_revision: history().revision, ...fields })]));
const element = (kind, name, key, scalar_type, index, value) => mutate(kind, name, { action: 'set-element', key, scalar_type, index, value });
if (!process.argv.includes('--slice-only')) {
const first = read(), beforeReads = history();
assert.equal(Object.keys(first.filament_override_context).length, 23);
assert.deepEqual(read('printer', printer).filament_override_context, {});
const count = first.editor_vectors.filament_retraction_length.index_count;
assert.ok(count > 1, 'fixture exercises a non-first Filament variant');
for (const [key, entries] of Object.entries(first.filament_override_context)) {
  assert.equal(entries.length, first.editor_vectors[key].index_count);
  for (const entry of entries) {
    assert.equal(typeof entry.visible, 'boolean'); assert.equal(typeof entry.enabled, 'boolean');
    assert.ok(Object.hasOwn(entry, 'reference_value'));
  }
}
assert.deepEqual(history(), beforeReads, 'reference reads are history-neutral');
element('printer', printer, 'retraction_length', 'float', 0, 0.7);
let current = read();
assert.ok(current.filament_override_context.filament_retraction_length.every(entry => entry.reference_value === 0.7), 'short Printer reference vector falls back to its first value');
const originals = current.editor_vectors.filament_retraction_length.effective_values;
for (let index = 0; index < count; index++) element('filament', filament, 'filament_retraction_length', 'float', index, null);
element('printer', printer, 'retraction_length', 'float', 0, 0);
assert.ok(read().filament_override_context.filament_retraction_speed.every(entry => !entry.enabled), 'inherited zero disables retraction controls');
const last = count - 1;
const receipt = element('filament', filament, 'filament_retraction_length', 'float', last, 1.2);
current = read();
assert.deepEqual(receipt.filament_override_context, current.filament_override_context, 'Get and mutation publish identical context');
assert.equal(current.filament_override_context.filament_retraction_speed[last].enabled, true);
assert.equal(current.filament_override_context.filament_retraction_speed[0].enabled, false);
assert.equal(current.editor_vectors.filament_retraction_length.effective_values[0], null);
ok(call('orc_history_undo'));
assert.equal(read().filament_override_context.filament_retraction_speed[last].enabled, false);
ok(call('orc_history_redo'));
assert.equal(read().filament_override_context.filament_retraction_speed[last].enabled, true);
mutate('printer', printer, { action: 'set', key: 'enable_long_retraction_when_cut', value: '2' });
element('printer', printer, 'long_retractions_when_cut', 'bool', 0, true);
element('filament', filament, 'filament_long_retractions_when_cut', 'bool', last, null);
assert.equal(read().filament_override_context.filament_retraction_distances_when_cut[last].visible, true, 'inherited true exposes the distance field');
element('filament', filament, 'filament_long_retractions_when_cut', 'bool', last, false);
assert.equal(read().filament_override_context.filament_retraction_distances_when_cut[last].visible, false);
mutate('printer', printer, { action: 'set', key: 'enable_long_retraction_when_cut', value: '0' });
assert.ok(read().filament_override_context.filament_long_retractions_when_cut.every(entry => !entry.visible));
for (const key of ['filament_ironing_flow', 'filament_ironing_spacing', 'filament_ironing_inset', 'filament_ironing_speed']) {
  const entry = read().filament_override_context[key][last];
  assert.equal(typeof entry.reference_value, 'number'); assert.equal(entry.visible, true); assert.equal(entry.enabled, true);
}
console.log('Filament Setting Overrides native projection: passed');

const beforeKey = 'filament_retract_before_wipe', afterKey = 'filament_retract_after_wipe';
element('printer', printer, 'retract_before_wipe', 'percent', 0, 50);
element('printer', printer, 'retract_after_wipe', 'percent', 0, 40);
element('filament', filament, beforeKey, 'percent', last, 50);
element('filament', filament, afterKey, 'percent', last, null);
const beforeCorrection = read(), beforeHistory = history();
const corrected = element('filament', filament, beforeKey, 'percent', last, 80);
assert.deepEqual(corrected.editor_vectors[afterKey].override_values[last], { value: 20 });
assert.equal(history().undoEntries.length, beforeHistory.undoEntries.length + 1);
assert.deepEqual(corrected.editor_vectors[afterKey].override_values.slice(0,last), beforeCorrection.editor_vectors[afterKey].override_values.slice(0,last), 'companion correction preserves other variants');
ok(call('orc_history_undo')); assert.deepEqual(read().overrides, beforeCorrection.overrides);
ok(call('orc_history_redo')); assert.deepEqual(read().overrides, corrected.overrides);
const unchecked = element('filament', filament, afterKey, 'percent', last, null);
assert.deepEqual(unchecked.editor_vectors[afterKey].override_values[last], { value: 20 });
const resetAfter = mutate('filament', filament, { action:'reset-field',key:afterKey,index:last });
assert.deepEqual(resetAfter.editor_vectors[afterKey].override_values[last], { value: 20 });
const resetCategory = mutate('filament', filament, { action:'reset-category',fields:[{key:afterKey,kind:'indexed',index:last}] });
assert.equal(resetCategory.editor_vectors[afterKey].override_values[last], null, 'category Reset does not correct');
element('filament', filament, beforeKey, 'percent', last, 80);
const resetBefore = mutate('filament', filament, { action:'reset-field',key:beforeKey,index:last });
assert.deepEqual(resetBefore.editor_vectors[afterKey].override_values[last], { value: 20 }, 'before Reset preserves after ownership');
const stable = read(), stableHistory = history();
for (const fields of [
  { key:beforeKey,scalar_type:'percent',index:last,value:101 },
  { key:beforeKey,scalar_type:'percent',index:count,value:80 },
]) {
  const rejected = call('orc_mutate_preset_draft', [JSON.stringify({history_context:context,kind:'filament',canonical_name:filament,action:'set-element',expected_revision:history().revision,...fields})]);
  assert.equal(rejected.ok,false); assert.deepEqual(read(),stable); assert.deepEqual(history(),stableHistory);
}
mutate('filament', filament, {action:'reset-preset'});
assert.deepEqual(read().overrides, {}, 'preset Reset still removes the complete overlay');
console.log('Filament Setting Overrides atomic wipe correction: passed');
}

// Exercise the ordinary native composition and slicing path, rather than
// accepting a config echo in the G-code footer as proof of application.
mutate('printer', printer, {action:'reset-preset'});
const rack = ok(call('orc_get_filament_session_snapshot'));
ok(call('orc_select_filament_slot_preset', [JSON.stringify({version:1,revision:rack.revisions.session,slot:1,preset:filament})]));
for (const [key, type, value] of [
  ['retraction_length','float',0.65], ['retract_when_changing_layer','bool',true],
  ['wipe','bool',false],
]) element('printer', printer, key, type, 0, value);
mutate('printer', printer, {action:'set',key:'use_relative_e_distances',value:'1'});
for (const [key,value] of [['ironing_type','top'],['ironing_speed','12']])
  ok(call('orc_mutate_native_scoped_config',[JSON.stringify({version:1,operation:'set',targets:[{scope:'project'}],key,value})]));
ok(call('orc_add_shape', ['Cube','Filament overrides proof']));
async function sliceMoves() {
  const session=ok(call('orc_get_plate_session_snapshot')), plate=session.current_plate_id;
  const sliced=ok(await callAsyncTask(call,'orc_slice_plate',['string','string','number'],['{}',plate,session.input_revisions[plate]]));
  const exported=ok(exportGcode(call,{receipt:sliced.receipt,filenameBase:''}));
  const gcode=new TextDecoder().decode(Module.FS.readFile(exported.path));
  if (exported.bytes_ptr) Module._free(Number(exported.bytes_ptr));
  const retractions=[], ironingFeeds=[]; let type='',feed=0;
  assert.match(gcode,/^M83\b/m,'fixture uses relative extrusion');
  for(const line of gcode.split('\n')) {
    if(line.startsWith(';TYPE:')) type=line.slice(6).trim();
    const f=/\bF([\d.]+)/.exec(line); if(f) feed=Number(f[1]);
    if(/^G1\s+E-/.test(line)) retractions.push(Number(/\bE(-[\d.]+)/.exec(line)[1]));
    if(type==='Ironing' && /^G1\b/.test(line) && /\b[XY]/.test(line) && /\bE[\d.]+/.test(line)) ironingFeeds.push(feed);
  }
  return {retractions,ironingFeeds};
}
const has=(values,value)=>values.some(actual=>Math.abs(actual-value)<0.001);
const baseline=await sliceMoves();
assert.ok(has(baseline.retractions,-0.65),'Printer reference reaches actual retract moves');
assert.ok(has(baseline.ironingFeeds,720),'Process reference reaches actual ironing moves');
element('filament',filament,'filament_retraction_length','float',0,1.23);
element('filament',filament,'filament_ironing_speed','float',0,7);
const overridden=await sliceMoves();
assert.ok(has(overridden.retractions,-1.23),'Filament override reaches actual retract moves');
assert.ok(!has(overridden.retractions,-0.65),'Printer retract length is replaced');
assert.ok(has(overridden.ironingFeeds,420),'Filament override reaches actual ironing moves');
assert.ok(!has(overridden.ironingFeeds,720),'Process ironing speed is replaced');
element('filament',filament,'filament_retraction_length','float',0,null);
element('filament',filament,'filament_ironing_speed','float',0,null);
const inherited=await sliceMoves();
assert.ok(has(inherited.retractions,-0.65),'disabling override restores Printer retract moves');
assert.ok(has(inherited.ironingFeeds,720),'disabling override restores Process ironing moves');
console.log('Filament Setting Overrides native G-code override and inheritance: passed');
