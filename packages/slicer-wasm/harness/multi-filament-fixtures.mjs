// Step 0 fixture/schema/builder self-test. No Emscripten or product code required.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndependentReader3mf } from './multi-filament-fixture-builder.mjs';
import { readZipEntries } from './native-3mf-parser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', 'fixtures', 'multi-filament');
const manifest = JSON.parse(await readFile(join(fixtureDir, 'manifest.json'), 'utf8'));
const schema = JSON.parse(await readFile(join(fixtureDir, 'schema.json'), 'utf8'));
const decoder = new TextDecoder();

function exactKeys(value, required, context) {
  assert.equal(typeof value, 'object', `${context} must be an object`);
  assert.ok(value !== null, `${context} must not be null`);
  const actual = Object.keys(value).sort();
  const allowed = [...required].sort();
  assert.deepEqual(actual, allowed, `${context} has unexpected or missing keys`);
  for (const key of required) assert.ok(Object.prototype.hasOwnProperty.call(value, key), `${context}.${key} is required`);
}

function validateInventory() {
  exactKeys(manifest, ['schema', 'schemaVersion', 'nativeCore', 'sourcePolicy', 'builder', 'fixtures'], 'manifest');
  exactKeys(manifest.nativeCore, ['repository', 'commit'], 'manifest.nativeCore');
  exactKeys(manifest.sourcePolicy, ['kind', 'externalDownloadsAllowed', 'readerFixtureProvenance'], 'manifest.sourcePolicy');
  exactKeys(manifest.builder, ['path', 'export', 'callsExporter'], 'manifest.builder');
  assert.equal(manifest.nativeCore.repository, schema.properties.nativeCore.properties.repository.const);
  assert.equal(manifest.sourcePolicy.kind, schema.properties.sourcePolicy.properties.kind.const);
  assert.equal(manifest.sourcePolicy.readerFixtureProvenance, schema.properties.sourcePolicy.properties.readerFixtureProvenance.const);
  assert.equal(manifest.builder.callsExporter, schema.properties.builder.properties.callsExporter.const);
  assert.ok(Array.isArray(manifest.fixtures));
  assert.ok(manifest.fixtures.length >= schema.properties.fixtures.minItems);
  const ids = new Set();
  for (const fixture of manifest.fixtures) {
    exactKeys(fixture, ['id', 'kind', 'status', 'provenance', 'path', 'expected'], `fixture ${fixture.id ?? '<missing>'}`);
    assert.match(fixture.id, /^mf\.[a-z0-9-]+$/);
    assert.equal(ids.has(fixture.id), false, `duplicate fixture id ${fixture.id}`);
    ids.add(fixture.id);
    assert.ok(['reader-3mf', 'state-matrix', 'writer-roundtrip-matrix'].includes(fixture.kind));
    assert.ok(['executable', 'matrix-only'].includes(fixture.status));
    assert.equal(typeof fixture.provenance, 'string');
    assert.equal(typeof fixture.expected, 'object');
    assert.ok(fixture.expected !== null);
    if (fixture.status === 'matrix-only') assert.equal(fixture.path, null);
    else assert.equal(typeof fixture.path, 'string');
  }
  const selectors = manifest.fixtures.find(({ id }) => id === 'mf.assignment-routing');
  assert.deepEqual(selectors.expected.selectors, ['outer-wall', 'inner-wall', 'sparse-infill', 'internal-solid-infill', 'top-surface', 'bottom-surface']);
  assert.deepEqual(selectors.expected.supportSelectors, ['support-base', 'support-interface']);
  const readers = manifest.fixtures.filter(({ kind }) => kind === 'reader-3mf');
  assert.equal(readers.length, 1, 'exactly one executable reader fixture is required');
  assert.equal(readers[0].status, 'executable');
  assert.equal(readers[0].provenance, 'independent-low-level-3mf-builder');
}

assert.equal(schema.$id, 'orca://slicer-wasm/multi-filament-fixture-manifest/v1');
assert.equal(manifest.schema, schema.properties.schema.const);
assert.equal(manifest.schemaVersion, schema.properties.schemaVersion.const);
assert.equal(manifest.nativeCore.commit, 'b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde');
assert.equal(manifest.sourcePolicy.externalDownloadsAllowed, false);
assert.equal(manifest.builder.path, 'packages/slicer-wasm/harness/multi-filament-fixture-builder.mjs');
assert.equal(manifest.builder.export, 'buildIndependentReader3mf');
assert.equal(manifest.builder.callsExporter, false);
validateInventory();
const reader = manifest.fixtures.find(({ kind }) => kind === 'reader-3mf');
assert.ok(reader, 'manifest must contain an executable reader fixture');
assert.equal(reader.status, 'executable');
assert.equal(reader.provenance, 'independent-low-level-3mf-builder');
assert.equal(reader.path, 'independent-reader-basic.3mf');
const builtA = buildIndependentReader3mf();
const builtB = buildIndependentReader3mf();
assert.deepEqual(builtA, builtB, 'builder output must be byte deterministic');
const archive = new Uint8Array(await readFile(join(fixtureDir, reader.path)));
assert.deepEqual(archive, builtA, 'checked-in reader fixture must be builder output');
assert.equal(archive[0], 0x50); assert.equal(archive[1], 0x4b);
const entries = readZipEntries(archive);
assert.deepEqual(entries.map(({ name }) => name), reader.expected.zipEntries);
const byName = new Map(entries.map((entry) => [entry.name, decoder.decode(entry.content)]));
const settings = byName.get('Metadata/model_settings.config');
assert.ok(settings?.includes('<metadata key="extruder" value="2"/>'));
assert.ok(settings?.includes('<part id="1" subtype="normal_part"><metadata key="name" value="Two Material Cube"/><metadata key="extruder" value="2"/>'));
assert.equal((settings.match(/<filament\b/g) ?? []).length, reader.expected.slotCount);
assert.ok(settings.includes('color="#FF0000"') && settings.includes('color="#00FF00"'));
assert.ok(settings.includes('<metadata key="filament_maps" value="1 1"/>'));
const project = JSON.parse(byName.get('Metadata/project_settings.config'));
assert.deepEqual(project.filament_settings_id, reader.expected.embeddedPresetIds);
assert.deepEqual(project.filament_colour, reader.expected.filamentColours);
assert.deepEqual(project.filament_map.map(Number), reader.expected.filamentMaps);
for (const [index, id] of reader.expected.embeddedPresetIds.entries()) {
  const embedded = JSON.parse(byName.get(`Metadata/filament_settings_${index + 1}.config`));
  assert.equal(embedded.filament_settings_id[0], id);
  assert.equal(embedded.filament_colour[0], reader.expected.filamentColours[index]);
}
const modelEntry = entries.find(({ name }) => name === '3D/3dmodel.model');
assert.ok(modelEntry);
const modelXml = decoder.decode(modelEntry.content);
assert.equal((modelXml.match(/<object\b/g) ?? []).length, reader.expected.objectCount);
assert.equal((modelXml.match(/<vertex\b/g) ?? []).length, 8, 'reader fixture must use a closed cube mesh');
assert.equal((modelXml.match(/<triangle\b/g) ?? []).length, 12, 'reader fixture must use a closed cube mesh');
assert.ok(!byName.has('Metadata/filament_slots.json'), 'custom non-native slot metadata must not be authoritative');
const digest = createHash('sha256').update(archive).digest('hex');
assert.equal(archive.length, reader.expected.byteLength);
assert.equal(digest, reader.expected.sha256);
console.log(`multi-filament fixture self-test passed (${manifest.fixtures.length} entries, sha256 ${digest})`);
