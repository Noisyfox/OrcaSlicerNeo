// Real AMF/Expat import and ArcFittingMode output gates for either WASM variant.
// Cases mirror cpp/tests/libslic3r/test_amf.cpp and the sparse-only arc case in
// cpp/tests/fff_print/test_gcode.cpp; no desktop GUI or test-only ABI is needed.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';
import { readZipEntries } from './native-3mf-parser.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('usage: node amf-arc-fitting-smoke.mjs <out/orca_slice.js> [comparison-output-directory]');
// Resolve before loadModuleFactory changes CWD to the artifact directory.
const outputDirectory = process.argv[3] ? resolve(process.argv[3]) : undefined;
const Module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, print() {}, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
function call(name, types = [], args = []) {
  const pointer = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
}
function ok(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function amf(vertices, triangles, metadata = '<metadata type="name">tetra</metadata>') {
  return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<amf unit="millimeter"><object id="0">${metadata}<mesh><vertices>${vertices.map(([x, y, z]) =>
    `<vertex><coordinates><x>${x}</x><y>${y}</y><z>${z}</z></coordinates></vertex>`).join('')}</vertices>
<volume>${triangles.map(([a, b, c]) => `<triangle><v1>${a}</v1><v2>${b}</v2><v3>${c}</v3></triangle>`).join('')}</volume>
</mesh></object></amf>`);
}
function importAmf(bytes, filename) {
  const pointer = Number(Module._malloc(bytes.length));
  Module.HEAPU8.set(bytes, pointer);
  try { return call('orc_add_model', ['pointer', 'number', 'string', 'string'], [pointer, bytes.length, 'amf', filename]); }
  finally { Module._free(pointer); }
}
function checkGeometry(triangleCount, dimensions) {
  const structure = ok(call('orc_get_model_structure'));
  assert.equal(structure.objects.length, 1);
  assert.equal(structure.objects[0].volumes.length, 1);
  const mesh = ok(call('orc_get_model_mesh'));
  try {
    assert.equal(mesh.geometries.length, 1);
    const geometry = mesh.geometries[0];
    assert.equal(geometry.index_count, triangleCount * 3);
    const bytes = Module.HEAPU8.slice(Number(geometry.vertex_ptr),
      Number(geometry.vertex_ptr) + geometry.vertex_count * 3 * Float32Array.BYTES_PER_ELEMENT);
    const vertices = new Float32Array(bytes.buffer);
    assert.ok(vertices.every(Number.isFinite));
    for (let axis = 0; axis < 3; ++axis) {
      let min = Infinity, max = -Infinity;
      for (let i = axis; i < vertices.length; i += 3) {
        min = Math.min(min, vertices[i]); max = Math.max(max, vertices[i]);
      }
      assert.ok(Math.abs(max - min - dimensions[axis]) < 1e-4, `axis ${axis}: ${max - min}`);
    }
  } finally {
    for (const geometry of [...mesh.geometries, ...mesh.paint_geometries]) {
      Module._free(Number(geometry.vertex_ptr)); Module._free(Number(geometry.index_ptr));
    }
  }
}
ok(call('orc_init', ['string'], [fixtureProfileOptions(Module)]));
ok(call('orc_select_preset', ['string', 'string'], ['printer', 'Bambu Lab P1P 0.4 nozzle']));
const tetraVertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
const tetraTriangles = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
ok(importAmf(amf(tetraVertices, tetraTriangles), 'tetra.amf'));
checkGeometry(4, [1, 1, 1]);
const before = ok(call('orc_get_model_structure'));
const rejected = importAmf(amf(tetraVertices, tetraTriangles, '<metadata>tetra</metadata>'), 'missing-metadata-type.amf');
assert.notEqual(rejected.ok, true);
assert.equal(typeof rejected.error, 'string');
assert.deepEqual(ok(call('orc_get_model_structure')), before, 'invalid AMF must preserve the live scene and stable IDs');
console.log('PASS: ordinary AMF tetrahedron and atomic rejection of missing metadata type');

// Match the upstream arc fixture: radius 25 mm, height 10 mm, 360 segments.
// The same AMF loader feeds this geometry into the real slicing pipeline.
const vertices = [[0, 0, 0], [0, 0, 10]], triangles = [];
for (let i = 0; i < 360; ++i) {
  const angle = i * 2 * Math.PI / 360;
  const x = -25 * Math.sin(angle), y = 25 * Math.cos(angle);
  vertices.push([x, y, 0], [x, y, 10]);
}
for (let i = 0; i < 360; ++i) {
  const a = 2 + i * 2, b = 2 + ((i + 1) % 360) * 2;
  triangles.push([0, b, a], [b + 1, 1, a + 1], [b + 1, a + 1, a], [b + 1, a, b]);
}
ok(call('orc_clear_model'));
ok(importAmf(amf(vertices, triangles, '<metadata type="name">arc cylinder</metadata>'), 'arc-cylinder.amf'));
checkGeometry(1440, [50, 50, 10]);
const printerConfig = { z_hop: '0', gcode_flavor: 'marlin2',
  machine_start_gcode: 'G28\nG90\nM83', machine_end_gcode: 'M104 S0' };
const processConfig = { sparse_infill_pattern: 'concentric', sparse_infill_density: '20%',
  layer_height: '0.2', initial_layer_print_height: '0.2', enable_prime_tower: '0',
  enable_wrapping_detection: '0', skirt_loops: '0', brim_type: 'no_brim', gcode_comments: '1' };
const historyContext = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
// Use saved configuration, so the optional pre-slice 3MF and Neo's slice consume
// the same settings. Per-slice overrides would be absent from that archive.
for (const [key, value] of Object.entries(printerConfig))
  ok(call('orc_mutate_preset_draft', ['string'], [JSON.stringify({ kind: 'printer',
    canonical_name: 'Bambu Lab P1P 0.4 nozzle', expected_revision: call('orc_history_status').revision,
    history_context: historyContext, action: 'set', key, value })]));
for (const [key, value] of Object.entries(processConfig))
  ok(setNativeScopedConfig(call, 'project', undefined, key, value));
assert.equal(call('orc_get_option_metadata').z_hop.type, 'floats');
const printerDraft = ok(call('orc_get_preset_draft', ['string', 'string'], ['printer', 'Bambu Lab P1P 0.4 nozzle']));
const zHop = printerDraft.editor_vectors.z_hop;
assert.equal(zHop.scalar_type, 'float');
assert.ok(Number.isInteger(zHop.index_count) && zHop.index_count > 0);
assert.deepEqual(zHop.effective_values, Array(zHop.index_count).fill(0));
function zeroHopValues(values) {
  assert.ok(Array.isArray(values) && values.length > 0, 'Z-hop must contain numeric slots');
  return values.map(value => {
    assert.equal(typeof value, 'string');
    assert.match(value, /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/);
    assert.equal(Number(value), 0, 'every Z-hop slot must disable lifting');
    return Number(value);
  });
}
if (outputDirectory) await mkdir(outputDirectory, { recursive: true });
for (const mode of ['enabled', 'sparse_infill', 'disabled']) {
  ok(setNativeScopedConfig(call, 'project', undefined, 'enable_arc_fitting', mode));
  if (outputDirectory) {
    const resolvedSettings = ok(call('orc_get_preset_snapshot')).project_config;
    const project = ok(call('orc_export_project', ['string'], ['{}']));
    assert.ok(project.bytes_ptr > 0 && project.bytes_length > 0);
    const bytes = Module.HEAPU8.slice(Number(project.bytes_ptr), Number(project.bytes_ptr) + project.bytes_length);
    Module._free(Number(project.bytes_ptr));
    const settingsEntry = readZipEntries(bytes).find(entry => entry.name === 'Metadata/project_settings.config');
    assert.ok(settingsEntry, 'comparison input must contain native project settings');
    const settings = JSON.parse(new TextDecoder().decode(settingsEntry.content));
    for (const [key, value] of Object.entries({ ...printerConfig, ...processConfig, enable_arc_fitting: mode })) {
      if (key === 'z_hop') {
        const savedHop = zeroHopValues(settings.z_hop);
        const resolvedHop = zeroHopValues(resolvedSettings.z_hop.split(','));
        assert.deepEqual(savedHop, zHop.effective_values, 'archive must preserve every effective Z-hop slot');
        // Native ConfigOptionVector::get_at broadcasts its first value when a
        // short resolved vector is indexed by the Standard/High Flow slots.
        assert.deepEqual(savedHop, Array.from({ length: zHop.index_count }, (_, i) => resolvedHop[i] ?? resolvedHop[0]));
      } else {
        assert.equal(Array.isArray(settings[key]) ? settings[key].join(',') : String(settings[key]), value,
          `comparison archive must preserve ${key}`);
        // ConfigOptionString::serialize C-escapes this fixed three-line snippet.
        const resolvedExpected = key === 'machine_start_gcode' ? 'G28\\nG90\\nM83' : value;
        assert.equal(resolvedSettings[key], resolvedExpected, `Neo's resolved settings must preserve ${key}`);
      }
    }
    console.log(`comparison ${mode} Z-hop ${JSON.stringify({ nozzle_count: printerDraft.editor_selection.nozzles.length,
      slot_count: zHop.index_count, resolved: resolvedSettings.z_hop, saved: settings.z_hop })}`);
    await writeFile(resolve(outputDirectory, `arc-${mode}.3mf`), bytes);
    await writeFile(resolve(outputDirectory, `arc-${mode}.neo-resolved.json`), JSON.stringify(resolvedSettings, null, 2));
  }
  const sliced = ok(await callAsyncTask(call, 'orc_slice', ['string'], ['{}']));
  const exported = ok(exportGcode(call, { receipt: sliced.receipt, filenameBase: '' }));
  const gcode = Module.FS.readFile(exported.path, { encoding: 'utf8' });
  if (outputDirectory) await writeFile(resolve(outputDirectory, `arc-${mode}.neo.gcode`), gcode);
  const arcs = new Map();
  let type = '<untyped>';
  for (const line of gcode.split(/\r?\n/)) {
    if (line.startsWith('; FEATURE: ')) type = line.slice('; FEATURE: '.length).trim();
    else if (/^G[23]\s/.test(line)) arcs.set(type, (arcs.get(type) ?? 0) + 1);
  }
  // Count every arc, including any before the first FEATURE marker, so custom
  // startup moves cannot accidentally prove the sparse-infill-only behavior.
  if (mode === 'enabled') assert.ok(arcs.get('Outer wall') > 0, JSON.stringify([...arcs]));
  else if (mode === 'sparse_infill') {
    assert.ok(arcs.get('Sparse infill') > 0, JSON.stringify([...arcs]));
    assert.deepEqual([...arcs.keys()], ['Sparse infill']);
  } else assert.equal(arcs.size, 0, JSON.stringify([...arcs]));
  console.log(`PASS: ${mode} arc fitting ${JSON.stringify(Object.fromEntries(arcs))}`);
}
if (Module.PThread?.terminateAllThreads) Module.PThread.terminateAllThreads();
