// Usage: node harness/mixed-filament-smoke.mjs out/serial/orca_slice.js
import assert from 'node:assert/strict';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';

const factory = await loadModuleFactory(resolve(process.argv[2]));
const module = await factory({ noInitialRun: true, print() {}, printErr() {} });
function call(name, types = [], args = []) {
  const ptr = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(ptr)); }
  finally { module._free(ptr); }
}
await installProfilePackages(module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
assert.equal(call('orc_init', ['string'], [fixtureProfileOptions(module)]).ok, true);
const printer = call('orc_get_preset_snapshot').printers.find(p => p.name.includes('Bambu Lab P1P 0.4 nozzle'));
assert.equal(call('orc_select_preset', ['string', 'string'], ['printer', printer.name]).ok, true);
const rack = () => call('orc_get_filament_session_snapshot');
const run = (name, fields = {}) => call(name, ['string'], [JSON.stringify({ version: 1, revision: rack().revisions.session, ...fields })]);
function edit(name, fields) {
  const r = run(name, fields);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.mutation.history_entry_delta, 1);
  return r.result.snapshot;
}
while (rack().slots.length < 2) edit('orc_add_filament_slot');
const initial = rack();
const count = initial.slots.length;
const draft = { components: [1,2], ratios: [60,40], gradient: false, reverse: false, perPart: false, points: [] };
const saved = edit('orc_edit_mixed_filament', { recipe: draft });
const mix = saved.slots.at(-1);
assert.deepEqual(mix.mix.components, draft.components);
assert.deepEqual(mix.mix.ratios, draft.ratios);
assert.equal(mix.mix.error, '');
const before = rack().revisions.session;
assert.equal(run('orc_edit_mixed_filament', { slot: mix.slot, recipe: { ...draft, components: [1,1] } }).ok, false);
assert.equal(rack().revisions.session, before);
const gradient = { ...draft, gradient: true, reverse: true, perPart: true,
  points: [{x:0,y:0.1,in:null,out:null}, {x:0.7,y:0.2,in:null,out:null}, {x:1,y:0.9,in:null,out:null}] };
edit('orc_edit_mixed_filament', { slot: mix.slot, recipe: gradient });
assert.deepEqual(rack().slots.at(-1).mix.points, gradient.points);
assert.equal(rack().slots.at(-1).mix.ramp.length, 17);
assert.equal(call('orc_add_shape', ['string','string'], ['Cube','Painted mix']).ok, true);
const objectId = rack().assignments.objects[0].id;
edit('orc_assign_filament', { targets: [{kind:'object', id:objectId}], slot:mix.slot });
function archiveEntries() {
  const archive = call('orc_export_project', ['string'], ['{}']);
  assert.equal(archive.ok, true);
  const ptr = Number(archive.bytes_ptr);
  try { return readZipEntries(module.HEAPU8.slice(ptr, ptr + archive.bytes_length)); }
  finally { module._free(ptr); }
}
const decoder = new TextDecoder();
const modelEntry = entry => entry.name.endsWith('.model') && decoder.decode(entry.content).includes('<triangle ');
const withPaint = writeStoredZip(archiveEntries().map(entry => modelEntry(entry) ? { ...entry,
  content:new TextEncoder().encode(decoder.decode(entry.content).replace(/<triangle\b[^>]*\/>/g,
    triangle => triangle.replace('/>', ' paint_color="0C"/>'))) } : entry));
const ptr = module._malloc(withPaint.length);
module.HEAPU8.set(withPaint, Number(ptr));
assert.equal(call('orc_load_project', ['pointer','number','number','string'], [ptr,withPaint.length,0,'painted.3mf']).ok, true);
module._free(ptr);
const importedId = rack().slots.at(-1).logical_id;
function assertPaint(code) {
  const xml = decoder.decode(archiveEntries().find(modelEntry).content);
  assert.deepEqual([...xml.matchAll(/paint_color="([^"]+)"/g)].map(match => match[1]), Array(12).fill(code));
}
assertPaint('0C');
const next = edit('orc_add_filament_slot');
assert.equal(next.slots[count].mix, null);
assert.equal(next.slots.at(-1).logical_id, importedId);
assert.equal(next.slots.at(-1).slot, mix.slot + 1);
assert.equal(next.assignments.objects[0].explicit_slot, 4);
assertPaint('1C');
assert.equal(call('orc_history_undo').ok, true);
assert.equal(rack().assignments.objects[0].explicit_slot, 3);
assertPaint('0C');
assert.equal(rack().slots.at(-1).slot, mix.slot);
assert.deepEqual(rack().slots.at(-1).mix.points, gradient.points);
const archive = call('orc_export_project', ['string'], ['{}']);
assert.equal(archive.ok, true);
const loaded = call('orc_load_project', ['pointer','number','number','string'], [archive.bytes_ptr,archive.bytes_length,0,'mixed.3mf']);
module._free(Number(archive.bytes_ptr));
assert.equal(loaded.ok, true);
assert.deepEqual(rack().slots.at(-1).mix.points, gradient.points);
assert.equal(rack().slots.at(-1).mix.perPart, true);
const broken = edit('orc_delete_filament_slot', {slot: 2}).slots.at(-1).mix;
assert.deepEqual(broken.components, [1,0]);
assert.deepEqual(broken.ratios, draft.ratios);
assert.ok(broken.error);
edit('orc_edit_mixed_filament', {operation:'delete-all'});
assert.ok(rack().slots.every(s => s.mix === null));
assert.equal(call('orc_history_undo').ok, true);
assert.deepEqual(rack().slots.at(-1).mix.components, [1,0]);
console.log('Mixed filament transactions, insertion, history and 3MF round trip passed.');
process.exit(0);
