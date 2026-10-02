// Direct native timings complement host RPC and renderer measurements. This
// harness never installs hooks or profiling branches in production artifacts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';

const root = resolve(import.meta.dirname, '../../..');
const project = resolve(root, 'packages/slicer-wasm/fixtures/big-proj.3mf');
const modulePath = resolve(process.argv[2] ?? resolve(root, 'packages/slicer-wasm/out/serial/orca_slice.js'));
const output = resolve(process.argv[3] ?? resolve(root, 'packages/slicer-wasm/.work/painting-close/native.json'));
const Module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(root, 'packages/profile-resources/dist')));
const timings = [];
function call(name, types = [], args = []) {
  const start = performance.now();
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const nativeMs = performance.now() - start;
  try {
    const result = JSON.parse(Module.UTF8ToString(ptr));
    assert.equal(result.error, undefined, JSON.stringify(result));
    if ('ok' in result) assert.equal(result.ok, true, JSON.stringify(result));
    timings.push({ name, nativeMs });
    return result;
  } finally { Module._free(ptr); }
}
const command = (name, value) => call(name, ['string'], [JSON.stringify(value)]);
command('orc_init', { log_level: 'error' });
const bytes = await readFile(project), ptr = Number(Module._malloc(bytes.length));
Module.HEAPU8.set(bytes, ptr);
try { call('orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, bytes.length, 0, 'big-proj.3mf']); }
finally { Module._free(ptr); }
command('orc_history_reset', { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} });
const objects = call('orc_get_model_structure').objects;
const cycles = [];
function releaseMesh(result) {
  for (const resource of [...result.geometries, ...result.paint_geometries]) {
    if (resource.vertex_ptr) Module._free(resource.vertex_ptr);
    if (resource.index_ptr) Module._free(resource.index_ptr);
  }
}
for (let i = 0; i < 3; i++) {
  const hs = command('orc_history_session_open', {}).sessionId;
  const session = command('orc_painting_session_open', { version: 1, channel: 'mmu', historySessionId: hs,
    objectId: objects[0].id, instanceId: objects[0].instances[0].id }).session;
  const before = timings.length;
  command('orc_history_session_close', { sessionId: hs, label: 'Paint' });
  const mesh = call('orc_get_model_mesh');
  const uniqueSourceTriangles = mesh.geometries.reduce((n, g) => n + g.index_count / 3, 0);
  const exportedBytes = [...mesh.geometries, ...mesh.paint_geometries].reduce((n, g) => n + g.vertex_count * 12 + g.index_count * 4, 0);
  releaseMesh(mesh);
  cycles.push({ index: i, parts: session.parts.map((p) => ({ volumeId: p.volumeId, sourceTriangleCount: p.sourceTriangleCount, facetCounts: p.facetCounts })),
    timings: timings.slice(before), geometryCount: mesh.geometries.length, volumeInstanceCount: mesh.renderables.length, uniqueSourceTriangles, exportedBytes });
}
const report = { project, projectSha256: createHash('sha256').update(bytes).digest('hex'),
  modulePath, wasmSha256: createHash('sha256').update(await readFile(modulePath.replace(/\.js$/, '.wasm'))).digest('hex'),
  objectCount: objects.length, cycles };
await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
