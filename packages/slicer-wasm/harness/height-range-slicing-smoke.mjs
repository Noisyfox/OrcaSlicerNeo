import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';
import { openProject, saveProject } from './height-range-project.mjs';
import { parseLayerRanges, readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';

const { module, call } = await createMixedFilamentFixture(process.argv[2]);
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
const object = () => ok(call('orc_get_model_structure')).objects[0];
const rows = () => object().heightRanges ?? [];
function edit(cmd) {
  return ok(call('orc_edit_height_ranges', ['string'], [JSON.stringify({ objectId: object().id, ...cmd })]));
}
async function layers() {
  const plate = ok(call('orc_get_plate_session_snapshot'));
  const id = plate.current_plate_id;
  const sliced = ok(await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number', 'string'],
    ['{}', id, plate.input_revisions[id], 'null']));
  const result = ok(exportGcode(call, { receipt: sliced.receipt, filenameBase: 'ranges' }));
  const gcode = module.FS.readFile(result.path, { encoding: 'utf8' });
  return layerComments(gcode);
}
function layerComments(gcode) {
  const z = [...gcode.matchAll(/^;\s*(?:Z_HEIGHT|Z):\s*([\d.]+)/gm)].map(match => Number(match[1]));
  assert.ok(z.length > 40, 'expected exported per-layer Z comments');
  return z;
}
function spacing(z, low, high, expected) {
  const deltas = z.slice(1).flatMap((h, i) => z[i] >= low && h <= high ? [h - z[i]] : []);
  assert.ok(deltas.length >= 4 && deltas.every(delta => Math.abs(delta - expected) < 0.003),
    JSON.stringify({ low, high, expected, deltas }));
}
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Layer spacing']));
edit({ operation: 'initialize' });
edit({ operation: 'max', targets: rows(), value: 6 });
edit({ operation: 'set', targets: rows(), key: 'layer_height', value: 0.12 });
edit({ operation: 'append', targets: rows() });
edit({ operation: 'min', targets: [rows()[1]], value: 4 });
edit({ operation: 'max', targets: [rows()[1]], value: 40 });
edit({ operation: 'set', targets: [rows()[1]], key: 'layer_height', value: 0.24 });
const ranged = saveProject(module, call);
const z = await layers();
assert.ok(Math.abs(z[0] - 0.2) < 0.001, 'fixed first layer');
spacing(z, 1, 5.5, 0.12);
spacing(z, 7, 16, 0.24);
const name = 'Metadata/layer_heights_profile.txt';
const profile = 'object_id=1|0.000000;0.200000;0.200000;0.200000;0.400000;0.160000;25.600000;0.160000\n';
const withProfile = writeStoredZip([...readZipEntries(ranged), { name, content: new TextEncoder().encode(profile) }]);
openProject(module, call, withProfile);
const curveZ = await layers();
spacing(curveZ, 2, 14, 0.16);
edit({ operation: 'set', targets: rows(), key: 'layer_height', value: 0.28 });
edit({ operation: 'set', targets: [rows()[0]], key: 'outer_wall_filament_id', value: 1 });
const saved = saveProject(module, call);
assert.equal(new TextDecoder().decode(readZipEntries(saved).find(entry => entry.name === name).content), profile);
openProject(module, call, saved);
assert.deepEqual(await layers(), curveZ);
const reset = writeStoredZip(readZipEntries(saved).filter(entry => entry.name !== name));
openProject(module, call, reset);
const rangeZ = await layers();
spacing(rangeZ, 2, 14, 0.28);
// An optional desktop Orca executable exercises its real importer, slicer and exporter.
if (process.argv[3]) {
  const exe = resolve(process.argv[3]);
  const dir = mkdtempSync(join(tmpdir(), 'neo-orca-height-ranges-'));
  try {
    for (const [name, bytes, expectedZ] of [['curve', saved, curveZ], ['ranges', reset, rangeZ]]) {
      const input = join(dir, name + '.3mf');
      const output = 'desktop-' + name + '.3mf';
      writeFileSync(input, bytes);
      execFileSync(exe, ['--datadir', join(dir, 'preferences'), '--allow-newer-file',
        '--outputdir', dir, '--slice', '1', '--export-3mf', output, input], { cwd: dir, timeout: 180000 });
      const archive = readFileSync(join(dir, output));
      const toolpath = readZipEntries(archive).find(entry => entry.name.endsWith('.gcode'));
      assert.ok(toolpath, 'desktop Orca exported a sliced plate');
      assert.deepEqual(layerComments(new TextDecoder().decode(toolpath.content)), expectedZ);
      openProject(module, call, archive);
      assert.deepEqual(parseLayerRanges(saveProject(module, call)), parseLayerRanges(bytes));
      assert.deepEqual(await layers(), expectedZ);
    }
    console.log('PASS desktop Orca slice, export and reopen in Neo with and without a saved curve');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log('PASS fixed first layer, overlap, clipped top, imported curve, unchanged curve Z and reset spacing');
process.exit(0);
