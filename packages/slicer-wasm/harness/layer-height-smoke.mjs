import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';
import { saveProject, openProject } from './height-range-project.mjs';
import { readZipEntries } from './native-3mf-parser.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
import { callAsyncTask, exportGcode } from './async-task-mailbox.mjs';

const desktop = process.argv[3] && resolve(process.argv[3]);
const { module, call } = await createMixedFilamentFixture(process.argv[2]);
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
const plate = () => ok(call('orc_get_plate_session_snapshot'));
const target = () => ({
  objectId: ok(call('orc_get_model_structure')).objects[0].id,
  plateId: plate().current_plate_id,
});
const command = request => call('orc_layer_height', ['string'], [JSON.stringify({ ...target(), ...request })]);
const read = () => ok(command({ operation: 'read' })).profile;
const edit = action => ok(command({ stamp: read().stamp, ...action }));
const warningApplies = () => ok(call('orc_get_model_structure')).objects.some(object => object.hasVariableLayerHeight === true);
const profileName = 'Metadata/layer_heights_profile.txt';
const file = (archive, name) => readZipEntries(archive).find(entry => entry.name === name)?.content;
const decode = bytes => new TextDecoder().decode(bytes);
const levels = gcode => [...gcode.matchAll(/^;\s*(?:Z_HEIGHT|Z):\s*([\d.]+)/gm)].map(match => Number(match[1]));

ok(call('orc_add_shape', ['string', 'string'], ['Sphere', 'Variable layers']));
const base = read();
assert.equal(base.canReset, false);
assert.equal(warningApplies(), false);
assert.equal(base.hasSavedCurve, false);
assert.equal(file(saveProject(module, call), profileName), undefined);
assert.equal(edit({ operation: 'smooth', radius: 5, keepMin: false }).changed, true);
assert.deepEqual(read().curve, base.curve);
assert.equal(warningApplies(), false);
assert.ok(file(saveProject(module, call), profileName));
assert.equal(command({ stamp: base.stamp, operation: 'adaptive', quality: 0.5 }).ok === true, false);
assert.equal(edit({ operation: 'adaptive', quality: 0.3 }).changed, true);
const adaptive = read();
assert.equal(adaptive.canReset, true);
assert.equal(adaptive.curve[1], base.firstHeight);
assert.ok(new Set(adaptive.curve.filter((_, i) => i % 2)).size > 4);
assert.ok(edit({ operation: 'smooth', radius: 4, keepMin: true }).changed);
const smooth = read().curve;
const bytes = saveProject(module, call);
const exported = file(bytes, profileName);
const stored = decode(exported).trim().split('|')[1].split(';').map(Number);
assert.deepEqual(stored, smooth.map(v => Number(v.toFixed(6))));
ok(setNativeScopedConfig(call, 'project', undefined, 'initial_layer_print_height', '0.24'));
assert.equal(read().firstHeight, 0.24);
assert.equal(warningApplies(), true);
assert.equal(read().canReset, false);
assert.deepEqual(file(saveProject(module, call), profileName), exported);
ok(setNativeScopedConfig(call, 'project', undefined, 'initial_layer_print_height', String(base.firstHeight)));
assert.deepEqual(read().curve, smooth);
openProject(module, call, bytes);
assert.deepEqual(read().curve, stored);
const p = plate();
const sliced = ok(await callAsyncTask(call, 'orc_slice_plate', ['string', 'string', 'number', 'string'],
  ['{}', p.current_plate_id, p.input_revisions[p.current_plate_id], 'null']));
const output = ok(exportGcode(call, { receipt: sliced.receipt, filenameBase: 'variable-layers' }));
const z = levels(module.FS.readFile(output.path, { encoding: 'utf8' }));
assert.ok(z.length > 40 && Math.abs(z[0] - base.firstHeight) < 0.001);
if (desktop) {
  const dir = mkdtempSync(join(tmpdir(), 'neo-variable-layers-'));
  try {
    const input = join(dir, 'neo.3mf');
    writeFileSync(input, bytes);
    execFileSync(desktop, ['--datadir', join(dir, 'prefs'), '--allow-newer-file', '--outputdir', dir,
      '--slice', '1', '--export-3mf', 'orca.3mf', input], { cwd: dir, timeout: 180000 });
    const archive = readFileSync(join(dir, 'orca.3mf'));
    assert.deepEqual(levels(decode(readZipEntries(archive).find(e => e.name.endsWith('.gcode')).content)), z);
    openProject(module, call, archive);
    assert.deepEqual(read().curve, stored);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
assert.equal(edit({ operation: 'reset' }).changed, true);
assert.equal(warningApplies(), false);
assert.deepEqual(read().curve.map(v => Number(v.toFixed(6))), base.curve.map(v => Number(v.toFixed(6))));
assert.equal(file(saveProject(module, call), profileName), undefined);
console.log('PASS native layer height edits, 3MF and', z.length, 'G-code layers', desktop ? '(desktop Orca matched)' : '');
process.exit(0);
