// Step 3 real serial-WASM assignment/routing smoke.
// node multi-filament-assignment-routing-smoke.mjs --module out/serial/orca_slice.js
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let i = 2; i < argv.length; i += 2) opts[argv[i]?.replace(/^--/, '')] = argv[i + 1];
if (!opts.module) throw new Error('usage: node multi-filament-assignment-routing-smoke.mjs --module out/serial/orca_slice.js');
const repoRoot = resolve(import.meta.dirname, '../../..');
const factory = await loadModuleFactory(resolve(opts.module));
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`)));
function callJson(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const out = JSON.parse(Module.UTF8ToString(ptr)); Module._free(ptr); return out;
}
function request(name, body) { return callJson(name, ['string'], [JSON.stringify(body)]); }
const init = callJson('orc_init', ['string'], ['']); assert.equal(init.ok, true, JSON.stringify(init));
const presets = callJson('orc_get_preset_snapshot');
const printer = presets.printers.find((p) => /Bambu Lab P1P 0\.4 nozzle/.test(p.name)) ?? presets.printers.find((p) => /Bambu Lab/.test(p.name));
assert.ok(printer); assert.equal(callJson('orc_select_preset', ['string', 'string'], ['printer', printer.name]).ok, true);
let snapshot = callJson('orc_get_filament_session_snapshot');
while (snapshot.slots.length < 3) {
  const added = request('orc_add_filament_slot', { version: 1, revision: snapshot.revisions.session });
  assert.equal(added.ok, true, JSON.stringify(added)); snapshot = added.result.snapshot;
}
const sourceStl = (await readFile(resolve(repoRoot, 'packages/slicer-wasm/fixtures/cube.stl'), 'utf8'));
const shiftedStl = sourceStl.replace(/^solid cube/m, 'solid shifted-cube')
  .replace(/^\s*vertex\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)/gm,
    (_line, x, y, z) => `      vertex ${Number(x) + 50} ${Number(y)} ${Number(z)}`)
  .replace(/endsolid cube\s*$/m, 'endsolid shifted-cube');
const stl = Buffer.from(`${sourceStl}\n${shiftedStl}`);
const ptr = Number(Module._malloc(stl.length)); Module.HEAPU8.set(stl, ptr);
const loaded = callJson('orc_add_model', ['pointer', 'number', 'string', 'string'], [ptr, stl.length, 'stl', '']); Module._free(ptr);
assert.equal(loaded.ok, true, JSON.stringify(loaded));
let structure = callJson('orc_get_model_structure');
const object = structure.objects[0]; const part = object.volumes[0];
assert.equal(callJson('orc_set_volume_type', ['number', 'string'], [part.id, 'model_part']).ok, true);
const split = callJson('orc_split_volume_to_parts', ['number', 'number', 'number'], [part.id, 1, 0]);
assert.equal(split.ok, true, JSON.stringify(split));
structure = callJson('orc_get_model_structure');
const splitObject = structure.objects[0];
const modifierCandidate = splitObject.volumes.find((volume) => volume.id !== part.id) ?? splitObject.volumes.at(-1);
assert.ok(modifierCandidate, JSON.stringify(splitObject));
assert.equal(callJson('orc_set_volume_type', ['number', 'string'], [modifierCandidate.id, 'parameter_modifier']).ok, true);
const addedInstance = callJson('orc_add_instance', ['number'], [object.id]); assert.equal(addedInstance.ok, true, JSON.stringify(addedInstance));
const cloned = callJson('orc_clone_objects', ['string'], [JSON.stringify([object.id])]); assert.equal(cloned.ok, true, JSON.stringify(cloned));
structure = callJson('orc_get_model_structure');
snapshot = callJson('orc_get_filament_session_snapshot');
assert.equal(snapshot.assignments.objects.length, 2, JSON.stringify(snapshot.assignments));
const addedPlate2 = callJson('orc_add_plate'); assert.equal(addedPlate2.ok, true, JSON.stringify(addedPlate2));
const addedPlate3 = callJson('orc_add_plate'); assert.equal(addedPlate3.ok, true, JSON.stringify(addedPlate3));
const plates = callJson('orc_get_plate_session_snapshot');
assert.equal(plates.plates.length, 3, JSON.stringify(plates));
const originalPart = snapshot.assignments.parts.find((entry) => entry.object_id === object.id);
const modifierProjection = snapshot.assignments.modifiers.find((entry) => entry.object_id === object.id);
assert.ok(originalPart && modifierProjection, JSON.stringify(snapshot.assignments));
const modifierAssigned = request('orc_assign_filament', { version: 1, revision: snapshot.revisions.session, slot: 3,
  targets: [{ kind: 'parameter-modifier', id: modifierProjection.id }] });
assert.equal(modifierAssigned.ok, true, JSON.stringify(modifierAssigned)); snapshot = modifierAssigned.result.snapshot;
let result;
for (const targets of [
  [{ kind: 'model-part', id: originalPart.id }, { kind: 'object', id: object.id }],
  [{ kind: 'object', id: object.id }, { kind: 'model-part', id: originalPart.id }],
]) {
  result = request('orc_assign_filament', { version: 1, revision: snapshot.revisions.session, slot: 2, targets });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.mutation.accepted_targets.length, 1, JSON.stringify(result));
  snapshot = result.result.snapshot;
  assert.equal(snapshot.assignments.parts.find((entry) => entry.id === originalPart.id).explicit_slot, 0,
    'owning object must dominate model-part regardless of request order');
}
const objectTargets = [{ kind: 'instance', id: structure.objects[0].instances[0].id }, { kind: 'instance', id: structure.objects[0].instances[1].id }, { kind: 'object', id: object.id }];
result = request('orc_assign_filament', { version: 1, revision: snapshot.revisions.session, slot: 2, targets: objectTargets });
assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.mutation.accepted_targets.length, 1, JSON.stringify(result));
snapshot = result.result.snapshot;
const assignedObject = snapshot.assignments.objects.find((entry) => entry.id === object.id);
const assignedPart = snapshot.assignments.parts.find((entry) => entry.id === originalPart.id);
const assignedModifier = snapshot.assignments.modifiers.find((entry) => entry.id === modifierProjection.id);
assert.equal(assignedObject.effective_slot, 2); assert.equal(assignedPart.explicit_slot, 0); assert.equal(assignedPart.effective_slot, 2);
assert.equal(assignedModifier.explicit_slot, 3, 'object assignment must preserve modifier config');
const inherited = request('orc_assign_filament', { version: 1, revision: snapshot.revisions.session, slot: 0, targets: [{ kind: 'model-part', id: originalPart.id }] });
assert.equal(inherited.ok, true, JSON.stringify(inherited));
assert.equal(inherited.result.snapshot.assignments.parts.find((entry) => entry.id === originalPart.id).inherited, true);
const bad = request('orc_assign_filament', { version: 1, revision: inherited.result.snapshot.revisions.session, slot: 1, targets: [{ kind: 'negative_volume', id: part.id }] });
assert.equal(bad.ok, false); assert.equal(bad.error_code, 'ineligible_target');
snapshot = inherited.result.snapshot;
const malformedAssignmentId = request('orc_assign_filament', { version: 1, revision: snapshot.revisions.session, slot: 1,
  targets: [{ kind: 'object', id: 'not-an-id' }] });
assert.equal(malformedAssignmentId.ok, false); assert.equal(malformedAssignmentId.error_code, 'invalid_command');
for (const [index, selector] of ['outer-wall', 'inner-wall', 'sparse-infill', 'internal-solid-infill', 'top-surface', 'bottom-surface'].entries()) {
  result = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session, selector, slot: index % 3 + 1,
    targets: [{ kind: 'object', id: object.id }] });
  assert.equal(result.ok, true, `${selector}: ${JSON.stringify(result)}`); snapshot = result.result.snapshot;
}
for (const selector of ['support-base', 'support-interface']) {
  result = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session, selector, slot: 0,
    targets: [{ kind: 'project', id: 0 }] });
  assert.equal(result.ok, true, `${selector}: ${JSON.stringify(result)}`); snapshot = result.result.snapshot;
}
const projectSupportBefore = snapshot.revisions;
result = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session, selector: 'support-base', slot: 2,
  targets: [{ kind: 'project', id: 0 }] });
assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.result.mutation.all_plate_results_invalidated, true);
assert.deepEqual(result.result.mutation.affected_plate_ids, plates.plates.map((entry) => entry.plate_id));
for (const plate of plates.plates)
  assert.equal(result.result.snapshot.revisions.plates[plate.plate_id], projectSupportBefore.plates[plate.plate_id] + 1,
    `project route must revise every plate: ${plate.plate_id}`);
snapshot = result.result.snapshot;
result = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session, selector: 'support-base', slot: 0,
  targets: [{ kind: 'object', id: object.id }] });
assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.result.mutation.all_plate_results_invalidated, false);
const inheritedSupport = result.result.snapshot.routing.find((entry) => entry.target === 'object' && entry.id === object.id && entry.selector === 'support-base');
assert.deepEqual({ effective: inheritedSupport.effective_slot, inherited: inheritedSupport.inherited, defaulted: inheritedSupport.defaulted },
  { effective: 2, inherited: true, defaulted: false });
snapshot = result.result.snapshot;
for (const [selector, target] of [['outer-wall', { kind: 'project', id: 0 }], ['support-base', { kind: 'model-part', id: originalPart.id }],
  ['outer-wall', { kind: 'parameter-modifier', id: modifierProjection.id }]]) {
  const rejected = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session, selector, slot: 1, targets: [target] });
  assert.equal(rejected.ok, false, `${selector} ${target.kind} should be rejected`);
  assert.equal(rejected.error_code, 'ineligible_target');
}
for (const target of [{ kind: 'object', id: 'not-an-id' }, { kind: 'object', id: 0 }, { kind: 'project', id: 1 }]) {
  const malformed = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session,
    selector: 'support-base', slot: 1, targets: [target] });
  assert.equal(malformed.ok, false, JSON.stringify(malformed));
  assert.equal(malformed.error_code, 'invalid_command', JSON.stringify(malformed));
}
result = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session, selector: 'support-base', slot: 0,
  targets: [{ kind: 'project', id: 0 }] });
assert.equal(result.ok, true, JSON.stringify(result)); snapshot = result.result.snapshot;
const routes = snapshot.routing.filter((entry) => entry.target === 'object' && entry.id === object.id);
assert.equal(routes.filter((entry) => entry.selector !== 'support-base' && entry.selector !== 'support-interface' && entry.explicit_slot > 0).length, 6);
assert.equal(snapshot.routing.some((entry) => entry.target === 'parameter-modifier'), false);
assert.equal(snapshot.routing.some((entry) => entry.target === 'model-part' && entry.selector.startsWith('support-')), false);
assert.ok(snapshot.routing.some((entry) => entry.target === 'project' && entry.selector === 'support-base' && entry.defaulted === true && entry.effective_slot === 0));
const beforeFailure = JSON.stringify(snapshot);
const historyBeforeFailure = JSON.stringify(callJson('orc_history_status'));
const platesBeforeFailure = JSON.stringify(callJson('orc_get_plate_session_snapshot'));
const failure = request('orc_set_filament_routing', { version: 1, revision: snapshot.revisions.session, selector: 'outer-wall', slot: 2,
  targets: [{ kind: 'object', id: object.id }], inject_failure: true });
assert.equal(failure.ok, false); assert.equal(JSON.stringify(callJson('orc_get_filament_session_snapshot')), beforeFailure);
assert.equal(JSON.stringify(callJson('orc_history_status')), historyBeforeFailure);
assert.equal(JSON.stringify(callJson('orc_get_plate_session_snapshot')), platesBeforeFailure);
console.log('multi-filament assignment/routing smoke passed (instance dedupe, inheritance, six selectors, support Default, rollback)');
