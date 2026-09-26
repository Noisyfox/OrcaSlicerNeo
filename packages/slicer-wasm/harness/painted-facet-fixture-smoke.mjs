import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildPaintedFacetProject } from './painted-facet-fixture-builder.mjs';
import { readZipEntries, verifyNativeProjectArchive } from './native-3mf-parser.mjs';

const fixtureDir = resolve(import.meta.dirname, '../fixtures/painted-facet');
const manifest = JSON.parse(await readFile(resolve(fixtureDir, 'manifest.json'), 'utf8'));
const fixturePath = resolve(fixtureDir, manifest.path);
const fixture = new Uint8Array(await readFile(fixturePath));
const rebuilt = await buildPaintedFacetProject();
const digest = createHash('sha256').update(fixture).digest('hex');
assert.deepEqual(fixture, rebuilt, 'checked-in project must match its deterministic builder');
assert.equal(fixture.byteLength, manifest.expected.bytes);
assert.equal(digest, manifest.expected.sha256);

const archive = readZipEntries(fixture);
const entries = new Map(archive.map((entry) => [entry.name, new TextDecoder().decode(entry.content)]));
const model = entries.get('3D/3dmodel.model');
const settings = entries.get('Metadata/model_settings.config');
const project = JSON.parse(entries.get('Metadata/project_settings.config'));
assert.ok(model && settings, 'fixture must contain its model and BBS model settings');
const triangles = [...model.matchAll(/<triangle\b[^>]*\/>/g)];
assert.equal(triangles.length, manifest.expected.triangleCount);
const paints = triangles.map((match) => match[0].match(/paint_color="([^"]+)"/)?.[1]).filter(Boolean);
assert.ok(paints.includes(manifest.expected.splitPaintState), 'fixture must include a split source facet');
assert.ok(paints.some((paint) => paint === '4') && paints.some((paint) => paint === '8'),
  'fixture must include both numbered paint states');
assert.equal((model.match(/<item\b/g) ?? []).length, manifest.expected.instanceCount);
assert.equal((model.match(/transform="[^"]* 100 100 10"/g) ?? []).length, 1,
  'the first fixture instance must start inside the positive-coordinate H2D bed');
assert.equal((model.match(/transform="[^"]* 130 100 10"/g) ?? []).length, 1,
  'the second fixture instance must start inside the positive-coordinate H2D bed');
assert.equal((settings.match(/<model_instance>/g) ?? []).length, manifest.expected.instanceCount);
assert.equal((settings.match(/<filament\b/g) ?? []).length, manifest.expected.slotCount);
assert.deepEqual(project.filament_colour, ['#FF0000', '#00FF00']);
for (const key of ['filament_colour', 'filament_multi_colour', 'filament_colour_type', 'filament_map',
  'filament_volume_map', 'filament_nozzle_map', 'filament_map_2', 'filament_self_index',
  'filament_extruder_variant']) {
  assert.equal(project[key]?.length, manifest.expected.slotCount, `${key} must match the native slot count`);
}
const verified = verifyNativeProjectArchive(fixture);
assert.equal(verified.plates.length, manifest.expected.plateCount);
assert.equal(verified.plates[0].instances.length, manifest.expected.instanceCount);
assert.deepEqual(verified.derivedArtifacts, []);

console.log(`painted facet fixture self-test passed (${fixture.byteLength} bytes; sha256 ${digest})`);
