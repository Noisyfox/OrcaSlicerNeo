// Bounded real-WASM observations; numbers are samples, not performance limits.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { meshBooleanSphereFixture } from './mesh-boolean-fixtures.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [modulePath, levelArg = '6'] = process.argv.slice(2);
const level = Number(levelArg);
if (!modulePath || !Number.isInteger(level) || level < 0 || level > 7)
  throw new Error('usage: measure-profile.mjs <orca_slice.js> [icosphere subdivision level 0..7]');
const absoluteModulePath = resolve(modulePath);
const fixture = meshBooleanSphereFixture(level);
const started = performance.now();
const module = await (await loadModuleFactory(absoluteModulePath))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(module.ccall(name, 'number', types, args));
  try { return JSON.parse(module.UTF8ToString(pointer)); } finally { module._free(pointer); }
}
const command = (name, value) => call(name, ['string'], [JSON.stringify(value)]);
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const elapsed = operation => { const begin = performance.now(); const result = operation(); return { result, ms: performance.now() - begin }; };
ok(command('orc_init', JSON.parse(fixtureProfileOptions(module))));
const initMs = performance.now() - started;
const pointer = Number(module._malloc(fixture.bytes.length));
module.HEAPU8.set(fixture.bytes, pointer);
const imported = elapsed(() => call('orc_add_model', ['pointer', 'number', 'string', 'string'],
  [pointer, fixture.bytes.length, 'stl', 'icosphere.stl']));
module._free(pointer);
ok(imported.result);
const object = ok(call('orc_get_model_structure')).objects[0];
const target = { objectId: object.id, instanceId: object.instances[0].id, volumeId: object.volumes[0].id };
const mesh = ok(call('orc_get_model_mesh'));
const offset = mesh.renderables[0].offset;
assert.equal(mesh.geometries.find(geometry => geometry.volume_id === target.volumeId)?.index_count, fixture.triangles * 3);
for (const geometry of [...mesh.geometries, ...mesh.paint_geometries]) {
  if (geometry.vertex_ptr) module._free(Number(geometry.vertex_ptr));
  if (geometry.index_ptr) module._free(Number(geometry.index_ptr));
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const projection = [...identity]; projection[0] = .025; projection[5] = .025; projection[10] = -.01;
const view = [...identity]; view[12] = -offset[0]; view[13] = -offset[1]; view[14] = -100;
const event = { pointer: [(3 + 40) * 1.25, (40 - 4) * 1.25], viewport: [0, 0, 100, 100], projection, view };
const heapBefore = module.HEAPU8.length, rssBefore = process.memoryUsage().rss, samples = [];
for (let repeat = 0; repeat < 3; ++repeat) {
  const opening = elapsed(() => command('orc_measure_open', { version: 1, targets: [target] }));
  const opened = ok(opening.result);
  const handle = { version: 1, sessionId: opened.sessionId, targetRevision: opened.targetRevision };
  const hoverMs = [];
  for (let index = 0; index < 10; ++index) {
    const display = elapsed(() => command('orc_measure_display', { ...handle, event }));
    const result = ok(display.result);
    assert.ok(result.hover, 'the sampled ray must hit the sphere');
    hoverMs.push(display.ms);
    module.ccall('orc_measure_display_release', 'void', ['string'],
      [JSON.stringify({ version: 1, sessionId: opened.sessionId, displayId: result.displayId })]);
  }
  const closing = elapsed(() => command('orc_measure_close', { version: 1, sessionId: opened.sessionId }));
  ok(closing.result);
  assert.equal(typeof command('orc_measure_read', handle).error, 'string');
  samples.push({ openMs: opening.ms, hoverMs, closeMs: closing.ms, heapBytesAfterClose: module.HEAPU8.length,
    rssBytesAfterClose: process.memoryUsage().rss });
}
console.log(JSON.stringify({ module: absoluteModulePath, platform: process.platform, arch: process.arch,
  cpu: cpus()[0]?.model, node: process.version, model: `closed icosphere level ${level}`,
  triangles: fixture.triangles, initMs, importMs: imported.ms, heapBytesBeforeMeasure: heapBefore, rssBytesBeforeMeasure: rssBefore,
  maxRssKiB: process.resourceUsage().maxRSS, samples }, null, 2));
process.exit(0);
