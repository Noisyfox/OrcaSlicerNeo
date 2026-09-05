// Step 9 is deliberately opt-in. Run this file directly for each production
// wasm64 module; it is not imported by tests or referenced by package scripts.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { readZipEntries, removeEntries, replaceEntry, verifyNativeProjectArchive } from './native-3mf-parser.mjs';

const opts = {};
for (let i = 2; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const key = argv[i].slice(2);
  const next = argv[i + 1];
  if (next && !next.startsWith('--')) { opts[key] = next; i++; }
  else opts[key] = true;
}
const repoRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(opts['fixture-root'] ?? `${repoRoot}/packages/slicer-wasm/fixtures/native-interoperability`);
const manifest = JSON.parse(await readFile(resolve(fixtureRoot, 'manifest.json'), 'utf8'));
const fixture = manifest.fixture;
const fixturePath = resolve(fixtureRoot, opts.fixture ?? fixture.filename);
const modulePath = opts.module;
if (!modulePath && !opts['generate-fixture']) {
  console.error('usage: node native-interoperability.mjs --module out/{serial,threaded}/orca_slice.js [--negative-checksum]');
  process.exit(2);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const neoEntryName = 'Metadata/orca_neo_plate_session_v1.json';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function close(a, b) { return Math.abs(Number(a) - Number(b)) <= 1e-5; }
function equalCanonical(a, b) {
  if (!a || !b || a.plate_count !== b.plate_count || a.current_plate_index !== b.current_plate_index ||
      a.plates?.length !== b.plates?.length) return false;
  return a.plates.every((plate, index) => {
    const other = b.plates[index];
    if (plate.display_index !== other.display_index || plate.name !== other.name || plate.locked !== other.locked ||
        JSON.stringify(plate.opaque_metadata) !== JSON.stringify(other.opaque_metadata) ||
        JSON.stringify(plate.instance_membership) !== JSON.stringify(other.instance_membership) ||
        plate.local_offsets?.length !== other.local_offsets?.length) return false;
    return plate.local_offsets.every((offset, i) => offset.every((value, axis) => close(value, other.local_offsets[i][axis])));
  });
}

function canonicalState(snapshot, mesh) {
  const transforms = new Map();
  for (const item of mesh.objects ?? []) {
    const key = `${item.object_idx}:${item.instance_idx}`;
    if (!transforms.has(key)) transforms.set(key, item.offset);
  }
  const current = snapshot.plates.findIndex((plate) => plate.plate_id === snapshot.current_plate_id);
  return {
    plate_count: snapshot.plates.length,
    current_plate_index: current,
    plates: snapshot.plates.map((plate) => {
      const members = (snapshot.instances ?? []).filter((item) => item.plate_id === plate.plate_id)
        .map((item) => ({ object_index: item.object_index, instance_index: item.instance_index }));
      return {
        display_index: plate.display_index,
        name: plate.name,
        locked: plate.locked,
        instance_membership: members,
        local_offsets: members.map((member) => {
          const world = transforms.get(`${member.object_index}:${member.instance_index}`) ?? [0, 0, 0];
          return world.map((value, axis) => Number(value) - Number(plate.origin[axis]));
        }),
        opaque_metadata: plate.opaque_metadata,
      };
    }),
  };
}

function checkFixture(bytes) {
  const actual = sha256(bytes);
  return Number.isSafeInteger(fixture.size) && fixture.size > 0 &&
    /^[0-9a-f]{64}$/.test(fixture.sha256) && bytes.length === fixture.size && actual === fixture.sha256;
}

function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

function callJson(Module, name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const text = Module.UTF8ToString(ptr);
  Module._free(ptr);
  return JSON.parse(text);
}

function writeBytes(Module, bytes) {
  const ptr = Number(Module._malloc(bytes.byteLength));
  Module.HEAPU8.set(bytes, ptr);
  return ptr;
}

async function generateFixture(Module) {
  check('fixture generation init', callJson(Module, 'orc_init', ['string'], ['']).ok === true);
  const model = await readFile(resolve(repoRoot, 'packages/slicer-wasm/fixtures/cube.stl'));
  let ptr = writeBytes(Module, model);
  const added = callJson(Module, 'orc_add_model', ['pointer', 'number', 'string', 'string'], [ptr, model.length, 'stl', 'cube.stl']);
  Module._free(ptr);
  check('fixture generation first model', added.ok === true && added.objects === 1);
  const plate = callJson(Module, 'orc_add_plate');
  check('fixture generation second plate', plate.ok === true && plate.plates?.length === 2);
  const second = callJson(Module, 'orc_add_shape', ['string', 'string'], ['Cube', 'Second Plate Cube']);
  check('fixture generation second model', second.ok === true && second.objects === 2);
  const exported = callJson(Module, 'orc_export_project');
  if (!exported.ok) throw new Error(`fixture generation export failed: ${JSON.stringify(exported)}`);
  const bytes = Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + Number(exported.bytes_length));
  Module._free(Number(exported.bytes_ptr));
  const nativeSettings = readZipEntries(bytes).find((entry) => entry.name === 'Metadata/model_settings.config');
  if (!nativeSettings) throw new Error('generated archive has no native model settings');
  let settingsXml = decoder.decode(nativeSettings.content)
    .replace('value="Plate 1"', 'value="Native Plate 1"')
    .replace('value="Plate 2"', 'value="Native Plate 2"')
    .replace('<metadata key="locked" value="false"/>', '<metadata key="lock" value="false"/>')
    .replace('<metadata key="locked" value="false"/>', '<metadata key="lock" value="true"/>');
  let plateIndex = 0;
  settingsXml = settingsXml.replace(/<plate\b[\s\S]*?<\/plate>/g, (block) => {
    const suffix = plateIndex++ === 0 ? ['native_future_key', 'native-future-value'] : ['native_second_key', 'native-second-value'];
    return block.replace('</plate>', `    <metadata key="${suffix[0]}" value="${suffix[1]}"/>\n  </plate>`);
  });
  const fixtureBytes = replaceEntry(removeEntries(bytes, (name) => name === neoEntryName),
    'Metadata/model_settings.config', settingsXml);
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(fixturePath, fixtureBytes);
  console.log(`WROTE ${fixturePath} size=${fixtureBytes.length} sha256=${sha256(fixtureBytes)}`);
  console.error('Copy the reported size/sha256 into the fixture manifest before using --check.');
}

let failures = 0;
const factory = modulePath ? await loadModuleFactory(modulePath) : null;
const Module = factory ? await factory({ noInitialRun: true, print: console.error, printErr: console.error }) : null;
if (Module) await installProfilePackages(Module, createNodeProfileSource(resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`)));
if (opts['generate-fixture']) {
  await generateFixture(Module);
  if (!modulePath) process.exit(failures ? 1 : 0);
}

const fixtureBytes = await readFile(fixturePath);
check('fixture checksum is pinned', checkFixture(fixtureBytes), `size=${fixtureBytes.length} sha256=${sha256(fixtureBytes)}`);
if (opts['negative-checksum']) {
  const tampered = new Uint8Array(fixtureBytes);
  tampered[tampered.length - 1] ^= 1;
  check('controlled fixture checksum tampering is rejected', !checkFixture(tampered));
}

let nativeFixture;
try { nativeFixture = verifyNativeProjectArchive(fixtureBytes); check('native parser accepts pinned fixture', true); }
catch (error) { check('native parser accepts pinned fixture', false, error.message); }
if (!Module || !nativeFixture || !checkFixture(fixtureBytes)) {
  console.error(`native interoperability failed: ${failures} check(s)`);
  process.exitCode = 1;
} else {
  let ptr = writeBytes(Module, fixtureBytes);
  const loaded = callJson(Module, 'orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, fixtureBytes.length, 0, fixture.filename]);
  Module._free(ptr);
  check('native bridge opens pinned fixture', loaded.ok === true && loaded.mode === 'project' && loaded.multi_plate === true,
    JSON.stringify({ ok: loaded.ok, mode: loaded.mode, plates: loaded.plate_count, error: loaded.error }));
  const snapshot = callJson(Module, 'orc_get_plate_session_snapshot');
  const mesh = callJson(Module, 'orc_get_model_mesh');
  const actual = canonicalState(snapshot, mesh);
  const expected = fixture.expected;
  check('canonical plate state matches pinned fixture', equalCanonical(actual, expected), JSON.stringify(actual));
  for (const [label, mutate] of [
    ['order', (value) => { value.plates.reverse(); }],
    ['membership', (value) => { value.plates[0].instance_membership[0].object_index = 99; }],
    ['local coordinates', (value) => { value.plates[0].local_offsets[0][0] += 1; }],
    ['names', (value) => { value.plates[0].name += ' changed'; }],
    ['locks', (value) => { value.plates[1].locked = !value.plates[1].locked; }],
    ['opaque metadata', (value) => { value.plates[0].opaque_metadata[0].value += '-changed'; }],
  ]) {
    const changed = clone(actual); mutate(changed);
    check(`canonical comparison detects controlled ${label} difference`, !equalCanonical(actual, changed));
  }

  const exported = callJson(Module, 'orc_export_project');
  const output = exported.ok ? Module.HEAPU8.slice(Number(exported.bytes_ptr), Number(exported.bytes_ptr) + Number(exported.bytes_length)) : new Uint8Array();
  if (exported.ok) Module._free(Number(exported.bytes_ptr));
  try {
    const parsed = verifyNativeProjectArchive(output);
    check('pinned native parser accepts Neo output', parsed.plates.length === snapshot.plates.length && parsed.derivedArtifacts.length === 0,
      JSON.stringify({ plates: parsed.plates.length, derived: parsed.derivedArtifacts }));
  } catch (error) { check('pinned native parser accepts Neo output', false, error.message); }
  check('Neo output omits derived G-code and preview artifacts', output.length > 0 && verifyNativeProjectArchive(output).derivedArtifacts.length === 0);

  const legacy = removeEntries(fixtureBytes, (name) => name === neoEntryName);
  const legacySettings = readZipEntries(legacy).find((entry) => entry.name === 'Metadata/model_settings.config');
  const withoutPlates = decoder.decode(legacySettings.content).replace(/<plate\b[\s\S]*?<\/plate>/g, '');
  const legacyBytes = replaceEntry(legacy, 'Metadata/model_settings.config', encoder.encode(withoutPlates));
  ptr = writeBytes(Module, legacyBytes);
  const legacyLoad = callJson(Module, 'orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, legacyBytes.length, 0, 'legacy.3mf']);
  Module._free(ptr);
  const legacySnapshot = callJson(Module, 'orc_get_plate_session_snapshot');
  check('legacy project falls back to one Plate 1', legacyLoad.ok === true && legacySnapshot.plates.length === 1 &&
    legacySnapshot.plates[0].name === 'Plate 1');

  ptr = writeBytes(Module, fixtureBytes);
  const restored = callJson(Module, 'orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, fixtureBytes.length, 0, fixture.filename]);
  Module._free(ptr);
  const beforeReject = callJson(Module, 'orc_get_plate_session_snapshot');
  const settings = readZipEntries(fixtureBytes).find((entry) => entry.name === 'Metadata/model_settings.config');
  const overLimitXml = decoder.decode(settings.content).replace('</config>', `${'<plate>\n    <metadata key="plater_id" value="37"/>\n  </plate>\n'.repeat(35)}</config>`);
  const overLimit = replaceEntry(fixtureBytes, 'Metadata/model_settings.config', overLimitXml);
  ptr = writeBytes(Module, overLimit);
  const rejected = callJson(Module, 'orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, overLimit.length, 0, 'over-limit.3mf']);
  Module._free(ptr);
  const afterReject = callJson(Module, 'orc_get_plate_session_snapshot');
  check('over-36 project is rejected without mutating the active session', rejected.ok !== true &&
    JSON.stringify(afterReject) === JSON.stringify(beforeReject), JSON.stringify(rejected));
  check('fixture reload remains a two-plate project after rejection', restored.ok === true && beforeReject.plates.length === 2);
}

if (failures) {
  console.error(`native interoperability failed: ${failures} check(s)`);
  process.exitCode = 1;
} else {
  console.log('native interoperability OK');
}
