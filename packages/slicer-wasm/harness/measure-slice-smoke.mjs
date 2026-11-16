// Exercise measurement while a real threaded plate slice is still running.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { awaitAsyncTask, getSliceResult } from './async-task-mailbox.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: measure-slice-smoke.mjs <threaded orca_slice.js>');
const module = await (await loadModuleFactory(resolve(modulePath)))({ noInitialRun: true, print: () => {}, printErr: () => {} });
assert.ok(module.HEAPU8.buffer instanceof SharedArrayBuffer, 'the concurrency test requires threaded WASM');
await installProfilePackages(module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(pointer)); } finally { module._free(pointer); }
}
const command = (name, value) => call(name, ['string'], [JSON.stringify(value)]);
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
ok(command('orc_init', JSON.parse(fixtureProfileOptions(module))));
ok(command('orc_select_printer_with_remembered_rack', { history_context: context,
  printer: 'Bambu Lab X1 Carbon 0.4 nozzle', remembered_bed_type: null, remembered_rack: null }));
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Concurrent Measure']));
assert.equal(command('orc_history_reset', context).disabled, false);
const object = ok(call('orc_get_model_structure')).objects[0];
const target = { objectId: object.id, instanceId: object.instances[0].id, volumeId: object.volumes[0].id };
const plate = ok(call('orc_get_plate_session_snapshot'));
const plateId = plate.current_plate_id;
const mesh = ok(call('orc_get_model_mesh'));
const offset = mesh.renderables[0].offset;
for (const geometry of [...mesh.geometries, ...mesh.paint_geometries]) {
  if (geometry.vertex_ptr) module._free(Number(geometry.vertex_ptr));
  if (geometry.index_ptr) module._free(Number(geometry.index_ptr));
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const projection = [...identity]; projection[0] = .025; projection[5] = .025; projection[10] = -.01;
const view = [...identity]; view[12] = -offset[0]; view[13] = -offset[1]; view[14] = -100;
const event = { pointer: [(3 + 40) * 1.25, (40 - 4) * 1.25], viewport: [0, 0, 100, 100], projection, view };

const slice = call('orc_slice_plate', ['string', 'string', 'number', 'string'],
  ['{}', plateId, plate.input_revisions[plateId], 'null']);
assert.equal(slice.accepted, true, JSON.stringify(slice));
const initial = call('orc_drain_async_task_mailbox');
assert.ok(!(initial.messages ?? []).some(message => message.type === 'task-terminal' && message.task_id === slice.task_id),
  'slice must still be active before opening Measure');
const opened = ok(command('orc_measure_open', { version: 1, targets: [target] }));
const handle = { version: 1, sessionId: opened.sessionId, targetRevision: opened.targetRevision };
const display = ok(command('orc_measure_display', { ...handle, event }));
assert.equal(display.hover.feature.type, 'plane');
const selected = ok(command('orc_measure_click', { ...handle, displayId: display.displayId, event, shift: true }));
assert.equal(selected.first.kind, 'pointOnFeature');
ok(command('orc_measure_close', { version: 1, sessionId: opened.sessionId }));
const result = ok(await awaitAsyncTask(call, slice));
ok(getSliceResult(call, result.receipt));
console.log('Measure threaded slice concurrency passed');
process.exit(0);
