// node mixed-filament-interop-smoke.mjs <wasm.js> <OrcaSlicer executable>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { awaitAsyncTask, getSliceResult } from './async-task-mailbox.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';

const [, , wasmPath, orcaPath] = process.argv;
if (!wasmPath || !orcaPath) throw new Error('Supply the WASM module and an OrcaSlicer executable with mixed filament support.');
const orca = resolve(orcaPath);
const { module, call, rack, edit } = await createMixedFilamentFixture(wasmPath);
const dir = await mkdtemp(join(tmpdir(), 'neo-orca-mixes-'));
const decoder = new TextDecoder(), encoder = new TextEncoder();
function ok(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function archive() {
  const { bytes_ptr, bytes_length } = ok(call('orc_export_project', ['string'], ['{}']));
  try { return module.HEAPU8.slice(Number(bytes_ptr), Number(bytes_ptr) + bytes_length); }
  finally { module._free(Number(bytes_ptr)); }
}
function open(bytes, name) {
  const ptr = module._malloc(bytes.length);
  try {
    module.HEAPU8.set(bytes, Number(ptr));
    ok(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, bytes.length, 0, name]));
  } finally { module._free(ptr); }
}
function facetStates(bytes) {
  return readZipEntries(bytes).filter(e => e.name.endsWith('.model')).flatMap(e =>
    [...decoder.decode(e.content).matchAll(/<triangle\b[^>]*\/>/g)].map(m => m[0].match(/paint_color="([^"]+)"/)?.[1] ?? '0')).sort();
}
function projection() {
  const snapshot = rack();
  const objects = ok(call('orc_get_model_structure')).objects.map(object => {
    const assignment = snapshot.assignments.objects.find(o => o.id === object.id);
    const parts = object.volumes.map(volume => snapshot.assignments.parts.find(p => p.id === volume.id));
    // Single-part files in Orca express the material on their parent.
    return { name: object.name, slot: parts.length === 1 ? parts[0].effective_slot : assignment.explicit_slot,
      parts: parts.length === 1 ? [] : parts.map(p => p.explicit_slot) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { recipes: snapshot.slots.filter(s => s.mix).map(s => s.mix.storage),
    colours: snapshot.slots.map(s => s.colour.effective.toUpperCase()), objects };
}
async function neoTools() {
  const result = ok(await awaitAsyncTask(call, call('orc_slice', ['string'], ['{}'])));
  const path = ok(getSliceResult(call, result.receipt)).toolpath;
  const data = module.HEAPU8.subarray(Number(path.extruder_id_ptr), Number(path.extruder_id_ptr) + path.segment_count);
  return [...new Set(data)].sort();
}

async function orcaRoundTrip(bytes, source, target, paint) {
  const input = join(dir, source + '.3mf'), filename = target + '.3mf';
  await writeFile(input, bytes);
  const logPath = join(dir, target + '.log');
  const cli = spawnSync(orca, ['--debug', '3', '--logfile', logPath, '--datadir', join(dir, 'preferences'),
    '--allow-newer-file', '--arrange', '1', '--outputdir', dir, '--slice', '1', '--export-3mf', filename, input],
  { cwd: dir, timeout: 180000, maxBuffer: 16 << 20, encoding: 'utf8' });
  if (cli.error) throw cli.error;
  if (cli.status !== 0) throw new Error(`Orca exited ${cli.status}: ${[cli.stderr, cli.stdout,
    await readFile(logPath, 'utf8').catch(() => '')].join('\n').slice(-4000)}`);
  const saved = await readFile(join(dir, filename));
  assert.deepEqual(facetStates(saved), paint);
  const gcode = readZipEntries(saved).find(e => e.name.endsWith('.gcode'));
  assert.ok(gcode, 'Orca exported a sliced plate');
  const tools = new Set([...decoder.decode(gcode.content).matchAll(/^T(\d+)\b/gm)].map(m => Number(m[1])));
  // Bambu adds firmware unload selectors outside the project's tool range.
  assert.deepEqual([...tools].filter(t => t < 64).sort(), [0, 1]);
  return saved;
}

try {
  const fixed = { components: [1, 2], ratios: [60, 40], gradient: false, perPart: false, reverse: false, points: [] };
  const gradient = { ...fixed, gradient: true, perPart: true, reverse: true, points: [
    { x: 0, y: .1, in: null, out: .4 }, { x: .55, y: .72, in: .3, out: .2 }, { x: 1, y: .9, in: .4, out: null },
  ] };
  for (const [i, color] of ['#FF0000', '#0000FF'].entries())
    edit('orc_set_filament_slot_colour', { slot: i + 1, colour: { kind: 'solid', color } });
  edit('orc_edit_mixed_filament', { recipe: fixed });
  edit('orc_edit_mixed_filament', { recipe: gradient });
  ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Painted fixed ratio']));
  // Seed the face data independently of the writer. Subsequent archives are
  // written exclusively by each application's production exporter.
  const entries = readZipEntries(archive()).map(entry => {
    if (entry.name.endsWith('.model')) return { ...entry, content: encoder.encode(decoder.decode(entry.content)
      .replace(/<triangle\b[^>]*\/>/g, t => t.replace('/>', ' paint_color="0C"/>'))) };
    if (entry.name === 'Metadata/project_settings.config') {
      const config = JSON.parse(decoder.decode(entry.content));
      return { ...entry, content: encoder.encode(JSON.stringify({ ...config, enable_prime_tower: '0', enable_mixed_color_sublayer: '1' })) };
    }
    return entry;
  });
  open(writeStoredZip(entries), 'painted.3mf');
  const added = ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Per-part gradient']));
  const z = added.plate_session.instance_transforms.at(-1).world_transform.offset[2];
  ok(call('orc_set_instance_offset', ['number', 'number', 'number', 'number', 'number'], [1, 0, 60, 60, z]));
  edit('orc_assign_filament', { targets: [{ kind: 'model-part', id: rack().assignments.parts[1].id }], slot: 4 });
  const paintedObject = ok(call('orc_get_model_structure')).objects[0];
  const extra = ok(call('orc_add_volume', ['string', 'pointer', 'number'], [JSON.stringify({
    objectId: paintedObject.id, instanceId: paintedObject.instances[0].id, volumeType: 'model_part', shape: 'Cube',
  }), 0, 0]));
  edit('orc_assign_filament', { targets: [{ kind: 'model-part', id: extra.volumeId }], slot: 4 });
  const beforeSave = rack();
  const reference = projection(), authored = archive(), paint = facetStates(authored);
  assert.deepEqual(rack(), beforeSave, 'single-part export must leave the live assignments alone');
  assert.deepEqual(reference.objects, [
    { name: 'Painted fixed ratio', slot: 1, parts: [0, 4] }, { name: 'Per-part gradient', slot: 4, parts: [] },
  ]);
  assert.equal(reference.recipes.length, 2);
  assert.equal(paint.filter(value => value === '0C').length, 12);
  assert.equal(paint.filter(value => value === '0').length, 24);
  assert.deepEqual(await neoTools(), [0, 1]);
  const fromOrca = await orcaRoundTrip(authored, 'neo', 'orca', paint);
  edit('orc_edit_mixed_filament', { operation: 'delete-all' });
  assert.ok(rack().slots.every(s => s.mix === null));
  open(fromOrca, 'orca.3mf');
  assert.deepEqual(projection(), reference);
  assert.deepEqual(await neoTools(), [0, 1]);
  const returned = archive();
  open(returned, 'neo-return.3mf');
  assert.deepEqual(projection(), reference);
  assert.deepEqual(facetStates(returned), paint);
  open(await orcaRoundTrip(returned, 'neo-return', 'orca-return', paint), 'orca-return.3mf');
  assert.deepEqual(projection(), reference);
  console.log('Orca and Neo preserved both recipes, part assignments, painted facets and physical tools 0/1.');
} finally {
  if (process.env.ORCA_KEEP_INTEROP_FIXTURE) console.log(dir);
  else await rm(dir, { recursive: true, force: true });
}
process.exit(0);
