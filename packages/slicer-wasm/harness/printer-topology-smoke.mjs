import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages, fixtureProfileOptions } from './profile-installer.mjs';
import { callAsyncTask } from './async-task-mailbox.mjs';

const root = resolve(import.meta.dirname, '../../..');
const factory = await loadModuleFactory(resolve(process.argv[2] ?? `${root}/packages/slicer-wasm/out/serial/orca_slice.js`));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(`${root}/packages/profile-resources/dist`));
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
function call(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  const result = JSON.parse(Module.UTF8ToString(pointer)); Module._free(pointer); return result;
}
const must = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
must(call('orc_init', ['string'], [fixtureProfileOptions(Module)]));
must(call('orc_add_shape', ['string', 'string'], ['Cube', 'Topology']));
let printer = 'Snapmaker U1 (0.4+0.6 nozzle)';
const select = name => {
  must(call('orc_select_printer_with_remembered_rack', ['string'], [JSON.stringify({ history_context: context, printer: name, remembered_rack: null, remembered_bed_type: null })]));
  printer = name;
};
select(printer);
const read = (name = printer) => must(call('orc_get_preset_draft', ['string', 'string'], ['printer', name]));
const rack = () => must(call('orc_get_filament_session_snapshot'));
const scoped = () => must(call('orc_get_native_scoped_config')).native_scoped_config.snapshot;
const count = () => read().editor_vectors.nozzle_diameter.effective_values.length;
function mutate(body, accepted = true, name = printer) {
  console.log(`topology command: ${name}: ${body.action} ${body.key ?? ''} ${body.value ?? ''}`);
  const result = call('orc_mutate_preset_draft', ['string'], [JSON.stringify({ history_context: context, kind: 'printer', canonical_name: name,
    expected_revision: read(name).revision, ...body })]);
  if (accepted) {
    must(result); assert.equal(result.history_entry_delta, 1);
    assert.equal(result.filament_session.revisions.project, result.revision_after);
  } else assert.equal(result.ok, false, JSON.stringify(body));
  return result;
}
const setCount = value => mutate({ action: 'set', key: 'extruders_count', value: String(value) });
const semm = value => mutate({ action: 'set', key: 'single_extruder_multi_material', value: value ? '1' : '0' });
const initial = read();
const objectId = must(call('orc_get_model_structure')).objects[0].id;
must(call('orc_assign_filament', ['string'], [JSON.stringify({version:1,revision:rack().revisions.session,slot:4,targets:[{kind:'object',id:objectId}]})]));
must(call('orc_set_filament_routing', ['string'], [JSON.stringify({version:1,revision:rack().revisions.session,selector:'support-base',slot:4,targets:[{kind:'project',id:0}]})]));
mutate({action:'set-element',key:'nozzle_diameter',scalar_type:'float',index:0,value:0.5});
const before = read();
const beforeRack = rack();
const beforeScoped = scoped();
assert.equal(beforeScoped.objects[String(objectId)].extruder, '4');
setCount(2);
assert.equal(count(), 2);
assert.deepEqual(read().editor_vectors.nozzle_diameter.effective_values, [0.5,0.4]);
assert.equal(read().editor_vectors.retraction_length.index_count, 4);
assert.equal(rack().slots.length, 2);
assert.equal(scoped().objects[String(objectId)].extruder, '1');
assert.equal(scoped().project.support_filament, '0');
mutate({action:'set',key:'nozzle_diameter',value:'0.5'});
assert.equal(count(), 2, 'ordinary whole-vector edits retain the current topology');
mutate({action:'reset-field',key:'nozzle_diameter',index:0});
assert.equal(count(), 2, 'element reset retains physical cardinality');
must(call('orc_history_undo'));
must(call('orc_history_undo'));
must(call('orc_history_undo'));
assert.deepEqual(read().effective_values, before.effective_values);
assert.deepEqual(rack().slots, beforeRack.slots);
assert.deepEqual(scoped(), beforeScoped, 'Undo restores all scoped material references');
must(call('orc_history_redo'));
assert.equal(count(), 2);
setCount(4);
assert.equal(count(), 4);
assert.equal(rack().slots.length, 4);
assert.equal(read().editor_vectors.retraction_length.index_count, 8);
assert.equal(read().editor_vectors.nozzle_diameter.effective_values[0], 0.5);
const stable = read();
for (const value of ['0','65','-1','2.5','NaN','1e1',''])
  mutate({ action:'set',key:'extruders_count',value }, false);
mutate({action:'set',key:'extruders_count',value:'2',expected_revision:0}, false);
mutate({action:'reset-category',fields:[{key:'extruders_count',kind:'shared'},{key:'invalid_option',kind:'shared'}]},false);
assert.deepEqual(read(), stable, 'invalid inputs and stale revisions do not mutate');
semm(true);
assert.equal(count(), 1, 'generic SEMM transition has one physical head');
assert.equal(rack().slots.length, 4, 'SEMM preserves flexible material rack');
mutate({action:'set',key:'extruders_count',value:'2'}, false);
semm(false);
assert.equal(count(), 1);
assert.equal(rack().slots.length, 1, 'fixed rack follows physical heads');
assert.equal(read().effective_values.purge_in_prime_tower, '0');
setCount(3);
mutate({action:'reset-field',key:'extruders_count'});
assert.equal(count(), 4);
setCount(2);
mutate({action:'reset-category',fields:[{key:'single_extruder_multi_material',kind:'shared'},{key:'extruders_count',kind:'shared'}]});
assert.equal(count(), 4, 'one category reset restores source cardinality');
mutate({action:'reset-preset'});
assert.deepEqual(read().effective_values, initial.effective_values);
assert.equal(read().draft_exists, false);

// Inactive Printer editing must never resize or remap the active project.
const inactive = 'Snapmaker U1 (0.4 nozzle)';
const active = read(); const activeRack = rack();
mutate({action:'set',key:'extruders_count',value:'2'}, true, inactive);
assert.equal(read(inactive).editor_vectors.nozzle_diameter.effective_values.length, 2);
assert.deepEqual(read().effective_values, active.effective_values);
assert.deepEqual(rack().slots, activeRack.slots);
mutate({action:'set',key:'extruders_count',value:'64'}, true, inactive);
assert.equal(read(inactive).editor_vectors.nozzle_diameter.effective_values.length, 64);
mutate({action:'reset-preset'}, true, inactive);

// Bambu SEMM and physical head count are independent, including after toggles.
select('Bambu Lab H2D 0.4 nozzle');
assert.equal(count(), 2);
assert.equal(read().effective_values.single_extruder_multi_material, '1');
const bambuRack = rack().slots;
semm(false); assert.equal(count(), 2);
semm(true); assert.equal(count(), 2);
setCount(3); assert.equal(count(), 3);
assert.deepEqual(rack().slots, bambuRack);
setCount(1); assert.equal(count(), 1);
assert.deepEqual(rack().slots, bambuRack);
mutate({action:'reset-preset'});
assert.equal(count(), 2);
assert.equal(read().effective_values.single_extruder_multi_material, '1');
setCount(3);
const exported = must(call('orc_export_project', ['string'], ['{}']));
console.log('topology export passed');
const archive = Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + Number(exported.bytes_length));
Module._free(Number(exported.bytes_ptr));
const pointer = Number(Module._malloc(archive.length));
Module.HEAPU8.set(archive, pointer);
try { must(call('orc_load_project', ['pointer','number','number','string'], [pointer,archive.length,0,'topology.3mf'])); }
finally { Module._free(pointer); }
printer = must(call('orc_get_preset_snapshot')).printer.name;
console.log('topology 3MF reload passed');
assert.equal(count(), 3, '3MF retains a structural draft differing from its installed source');
assert.equal(read().effective_values.single_extruder_multi_material, '1');
const prepared = must(call('orc_prepare_user_preset', ['string'], [JSON.stringify({history_context:context,action:'save-as',kind:'printer',canonical_name:printer,name:'Topology H2D',expected_revision:read().revision})]));
assert.equal(JSON.parse(prepared.change.content).nozzle_diameter.length, 3);
must(call('orc_finish_user_preset', ['string'], [JSON.stringify({token:prepared.token,commit:true})]));
printer = must(call('orc_get_preset_snapshot')).printer.name;
assert.equal(count(), 3, 'saved user preset retains physical cardinality');
console.log('topology user preset save passed');
const plateSession = must(call('orc_get_plate_session_snapshot'));
const plateId = plateSession.current_plate_id;
must(await callAsyncTask(call, 'orc_slice_plate', ['string','string','number'], ['{}',plateId,plateSession.input_revisions[plateId]]));
console.log('printer topology smoke passed: resize, variants, rack, invalid/stale, history, inactive drafts, Bambu SEMM, 3MF');
