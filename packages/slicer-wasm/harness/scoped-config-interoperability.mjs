// Step 7 native scoped-configuration interoperability gate.
//
// The harness creates one native golden project with every approved scope,
// reloads it through the real bridge, and optionally verifies an archive saved
// by a fixed OrcaSlicer build. IDs are intentionally normalized by object,
// volume, and plate display order because native 3MF readers allocate fresh
// runtime IDs on every open. The source archive supplied with --orca-project is
// copied to a temporary directory before it is opened.
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { argv } from 'node:process';

import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
import {
  readZipEntries,
  replaceEntry,
  writeStoredZip,
} from './native-3mf-parser.mjs';

const repoRoot = resolve(import.meta.dirname, '../../..');
const opts = {};
for (let i = 2; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const key = argv[i].slice(2);
  const value = argv[i + 1];
  if (value && !value.startsWith('--')) { opts[key] = value; i++; }
  else opts[key] = true;
}

const modulePath = opts.module ? resolve(opts.module) : null;
const profileRoot = resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`);
const fixtureRoot = resolve(opts['fixture-root'] ?? `${repoRoot}/packages/slicer-wasm/fixtures/scoped-config-interoperability`);
const manifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8'));
if (!modulePath) {
  console.error('usage: node scoped-config-interoperability.mjs --module out/{serial,threaded}/orca_slice.js [--orca-project path] [--require-orca]');
  process.exit(2);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const legacySidecar = manifest.legacySidecar;
const privateNeoEntries = manifest.legacyPrivateEntries ?? [
  legacySidecar,
  'Metadata/orca_neo_plate_session_v1.json',
  'Metadata/orca_neo_filament_state_v1.json',
];
const unknownKey = manifest.unknownKeyFallback.key;

function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

function sortedValues(value = {}) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function exactSelected(values, expected) {
  return Object.entries(expected).every(([key, value]) => values?.[key] === value);
}

function callJson(Module, name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  try { return JSON.parse(Module.UTF8ToString(ptr)); }
  finally { Module._free(ptr); }
}

function writeBytes(Module, bytes) {
  const ptr = Number(Module._malloc(bytes.byteLength));
  Module.HEAPU8.set(bytes, ptr);
  return ptr;
}

function readAndFree(Module, result) {
  const bytes = Module.HEAPU8.slice(Number(result.bytes_ptr), Number(result.bytes_ptr) + Number(result.bytes_length));
  Module._free(Number(result.bytes_ptr));
  return bytes;
}

function requireOk(label, value) {
  if (!value?.ok) throw new Error(`${label}: ${JSON.stringify(value)}`);
  return value;
}

function configMutation(Module, scope, id, key, value) {
  const result = setNativeScopedConfig((name, types, args) => callJson(Module, name, types, args), scope, id, key, value);
  return requireOk(`set ${scope}.${key}`, result);
}

function normalizedSnapshot(Module) {
  const structure = requireOk('model structure', callJson(Module, 'orc_get_model_structure')).objects ?? [];
  const session = requireOk('plate session', callJson(Module, 'orc_get_plate_session_snapshot'));
  const snapshot = requireOk('native scoped config', callJson(Module, 'orc_get_native_scoped_config')).native_scoped_config.snapshot;
  const objects = structure.map((object) => ({
    index: object.index,
    name: object.name,
    values: sortedValues(snapshot.objects?.[String(object.id)] ?? {}),
    volumes: (object.volumes ?? []).map((volume) => ({
      index: volume.index,
      name: volume.name,
      type: volume.type,
      values: sortedValues(snapshot.parts?.[String(volume.id)] ?? {}),
    })),
  }));
  const plates = (session.plates ?? []).map((plate) => ({
    display_index: plate.display_index,
    name: plate.name,
    values: sortedValues(snapshot.plates?.[plate.plate_id] ?? {}),
  }));
  return {
    project: sortedValues(snapshot.project ?? {}),
    objects,
    plates,
    snapshot,
    structure,
    session,
  };
}

function selectedScope(normalized) {
  const expected = manifest.golden;
  const object = normalized.objects[0];
  return {
    project: Object.fromEntries(Object.keys(expected.project).map((key) => [key, normalized.project[key]])),
    plates: normalized.plates.map((plate) => Object.fromEntries(
      Object.keys(expected.plate).map((key) => [key, plate.values[key]]))),
    object: Object.fromEntries(Object.keys(expected.object).map((key) => [key, object?.values[key]])),
    volumes: (object?.volumes ?? []).map((volume) => ({
      type: volume.type,
      values: Object.fromEntries(Object.keys(expected.volumes[volume.index] ?? {}).filter((key) => key !== 'type')
        .map((key) => [key, volume.values[key]])),
    })),
  };
}

function parseLayerRanges(bytes) {
  const entry = readZipEntries(bytes).find(({ name }) => name === 'Metadata/layer_config_ranges.xml');
  if (!entry) return [];
  const xml = decoder.decode(entry.content);
  const unescape = (value) => value.replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const attr = (text, key) => text.match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? '';
  const ranges = [];
  for (const objectMatch of xml.matchAll(/<object\b[\s\S]*?<\/object>/g)) {
    const objectText = objectMatch[0];
    const objectId = Number(attr(objectText.slice(0, objectText.indexOf('>') + 1), 'id'));
    for (const rangeMatch of objectText.matchAll(/<range\b[\s\S]*?<\/range>/g)) {
      const rangeText = rangeMatch[0];
      const head = rangeText.slice(0, rangeText.indexOf('>') + 1);
      const values = {};
      for (const option of rangeText.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/g))
        values[unescape(attr(option[0], 'opt_key'))] = unescape(option[1]);
      ranges.push({ object_id: objectId, min_z: Number(attr(head, 'min_z')), max_z: Number(attr(head, 'max_z')), values });
    }
  }
  return ranges;
}

function compareLayerRanges(actual, expected) {
  if (actual.length !== expected.length) return false;
  return expected.every((wanted) => actual.some((candidate) =>
    Math.abs(candidate.min_z - wanted.min_z) < 1e-6 &&
    Math.abs(candidate.max_z - wanted.max_z) < 1e-6 &&
    JSON.stringify(sortedValues(candidate.values)) === JSON.stringify(sortedValues(wanted.values))));
}

function withLayerRange(bytes) {
  const entries = readZipEntries(bytes).filter(({ name }) => name !== 'Metadata/layer_config_ranges.xml');
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<objects>\n <object id="1">\n  <range min_z="0.4" max_z="0.8">\n   <option opt_key="layer_height">0.16</option>\n  </range>\n </object>\n</objects>\n`;
  entries.push({ name: 'Metadata/layer_config_ranges.xml', content: encoder.encode(xml) });
  return writeStoredZip(entries.map(({ name, content }) => ({ name, content })));
}

function archiveEntries(bytes) {
  return readZipEntries(bytes).map(({ name, content }) => ({ name, content }));
}

function addEntry(bytes, name, content) {
  return writeStoredZip([...archiveEntries(bytes), { name, content: content instanceof Uint8Array ? content : encoder.encode(content) }]);
}

function unknownKeyArchive(bytes) {
  const project = readZipEntries(bytes).find(({ name }) => name === 'Metadata/project_settings.config');
  if (!project) throw new Error('golden archive has no project_settings.config');
  const config = JSON.parse(decoder.decode(project.content));
  config[unknownKey] = manifest.unknownKeyFallback.value;
  return replaceEntry(bytes, project.name, JSON.stringify(config));
}

function buildGolden(Module) {
  requireOk('initialise bridge', callJson(Module, 'orc_init', ['string'], ['{"log_level":"error"}']));
  const shapeNames = ['Cube', 'Cylinder', 'Sphere', 'Cone'];
  for (const name of shapeNames)
    requireOk(`add ${name}`, callJson(Module, 'orc_add_shape', ['string', 'string'], [name, name]));
  const initial = requireOk('initial model structure', callJson(Module, 'orc_get_model_structure'));
  const sourceIds = initial.objects.map((object) => object.id);
  const merged = requireOk('assemble multipart golden', callJson(Module, 'orc_merge_objects_to_multipart',
    ['string', 'string'], [JSON.stringify(sourceIds), 'Scoped Configuration Golden']));
  let structure = requireOk('assembled structure', callJson(Module, 'orc_get_model_structure'));
  const object = structure.objects[0];
  const types = ['model_part', 'parameter_modifier', 'negative_volume', 'support_blocker'];
  for (const [volume, type] of object.volumes.map((volume, index) => [volume, types[index]]))
    requireOk(`set volume ${volume.index} type`, callJson(Module, 'orc_set_volume_type', ['number', 'string'], [volume.id, type]));

  let session = requireOk('golden first plate session', callJson(Module, 'orc_get_plate_session_snapshot'));
  requireOk('add second golden plate', callJson(Module, 'orc_add_plate'));
  session = requireOk('golden two plate session', callJson(Module, 'orc_get_plate_session_snapshot'));
  const plateIds = session.plates.map((plate) => plate.plate_id);
  const projectValues = manifest.golden.project;
  for (const [key, value] of Object.entries(projectValues)) configMutation(Module, 'project', undefined, key, value);
  for (const plateId of plateIds) {
    for (const [key, value] of Object.entries(manifest.golden.plate)) configMutation(Module, 'plate', plateId, key, value);
  }
  for (const [key, value] of Object.entries(manifest.golden.object)) configMutation(Module, 'object', String(object.id), key, value);
  for (const volume of object.volumes) {
    const expected = manifest.golden.volumes[volume.index];
    for (const [key, value] of Object.entries(expected)) {
      if (key !== 'type') configMutation(Module, 'part', String(volume.id), key, value);
    }
  }
  structure = requireOk('golden typed structure', callJson(Module, 'orc_get_model_structure'));
  const exported = requireOk('export golden project', callJson(Module, 'orc_export_project'));
  const bytes = withLayerRange(readAndFree(Module, exported));
  return { bytes, normalized: normalizedSnapshot(Module), structure };
}

function loadProject(Module, bytes, name) {
  const ptr = writeBytes(Module, bytes);
  try { return callJson(Module, 'orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, bytes.length, 0, name]); }
  finally { Module._free(ptr); }
}

function exportProject(Module) {
  return readAndFree(Module, requireOk('export project', callJson(Module, 'orc_export_project')));
}

let failures = 0;
const tempRoot = await mkdtemp(join(tmpdir(), 'orca-scoped-config-interoperability-'));
const moduleFactory = await loadModuleFactory(modulePath);
const Module = await moduleFactory({ noInitialRun: true, printErr: (line) => {
  if (!String(line).includes('[info]')) console.error(line);
} });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));

try {
  const golden = buildGolden(Module);
  const goldenPath = join(tempRoot, 'scoped-config-golden.3mf');
  await writeFile(goldenPath, golden.bytes);
  const entries = readZipEntries(golden.bytes);
  check('golden native archive is a ZIP with model settings', entries.some(({ name }) => name === 'Metadata/model_settings.config'));
  check('golden save has no Neo-private project metadata', !entries.some(({ name }) => privateNeoEntries.includes(name)));
  check('golden preserves inaccessible Layer Range data', compareLayerRanges(parseLayerRanges(golden.bytes), manifest.golden.layerRanges));
  check('golden covers Project, Plate, Object, and every ModelVolume type',
    golden.normalized.objects.length === 1 && golden.normalized.objects[0].volumes.length === manifest.golden.volumes.length &&
    golden.normalized.plates.length === 2 &&
    exactSelected(golden.normalized.project, manifest.golden.project) &&
    golden.normalized.plates.every((plate) => exactSelected(plate.values, manifest.golden.plate)) &&
    exactSelected(golden.normalized.objects[0].values, manifest.golden.object) &&
    golden.normalized.objects[0].volumes.every((volume, index) => volume.type === manifest.golden.volumes[index].type &&
      exactSelected(volume.values, Object.fromEntries(Object.entries(manifest.golden.volumes[index]).filter(([key]) => key !== 'type')))));

  const goldenReloaded = loadProject(Module, golden.bytes, 'scoped-config-golden.3mf');
  check('Neo reopens its golden as a project', goldenReloaded.ok === true && goldenReloaded.mode === 'project');
  const reloaded = normalizedSnapshot(Module);
  check('Neo native scoped maps survive its own 3MF round trip',
    JSON.stringify(selectedScope(reloaded)) === JSON.stringify(selectedScope(golden.normalized)),
    JSON.stringify({ before: selectedScope(golden.normalized), after: selectedScope(reloaded) }));
  const reloadedExport = exportProject(Module);
  check('Layer Range survives Neo save after reopen', compareLayerRanges(parseLayerRanges(reloadedExport), manifest.golden.layerRanges));
  check('Neo reopen/save still omits Neo-private project metadata',
    !readZipEntries(reloadedExport).some(({ name }) => privateNeoEntries.includes(name)));

  let legacy = addEntry(golden.bytes, legacySidecar,
    JSON.stringify({ schema: 'removed', version: 1, project: { layer_height: '0.42', wall_loops: '99' } }));
  legacy = addEntry(legacy, 'Metadata/orca_neo_plate_session_v1.json',
    JSON.stringify({ schema: 'removed', version: 1, current_plate_index: 1 }));
  legacy = addEntry(legacy, 'Metadata/orca_neo_filament_state_v1.json',
    JSON.stringify({ schema: 'removed', version: 1, state: { filament_presets: ['invalid'] } }));
  const legacyLoaded = loadProject(Module, legacy, 'legacy-sidecar-negative.3mf');
  const legacySnapshot = normalizedSnapshot(Module);
  check('legacy config sidecar is ignored on open', legacyLoaded.ok === true &&
    legacySnapshot.project.layer_height === manifest.golden.project.layer_height &&
    legacySnapshot.project.layer_height !== '0.42' &&
    !Object.hasOwn(legacySnapshot.project, 'wall_loops'));
  const legacyExport = exportProject(Module);
  check('legacy Neo-private metadata is not reproduced on save',
    !readZipEntries(legacyExport).some(({ name }) => privateNeoEntries.includes(name)));

  const unknown = unknownKeyArchive(golden.bytes);
  const unknownLoaded = loadProject(Module, unknown, 'unknown-key-fallback.3mf');
  const unknownSnapshot = normalizedSnapshot(Module);
  // The bridge's established compatibility path drops an unrecognized native
  // option while retaining the project. This assertion deliberately does not
  // count that file as a successful native round trip.
  check('unknown native key takes explicit compatibility fallback', unknownLoaded.ok === true &&
    unknownLoaded.compatibility === 'bambu' && unknownLoaded.project_settings_available === true &&
    !Object.hasOwn(unknownSnapshot.project, unknownKey),
    JSON.stringify({ compatibility: unknownLoaded.compatibility, projectSettingsAvailable: unknownLoaded.project_settings_available }));
  const unknownExport = readZipEntries(exportProject(Module));
  const unknownProjectEntry = unknownExport.find(({ name }) => name === 'Metadata/project_settings.config');
  const unknownProjectJson = unknownProjectEntry ? JSON.parse(decoder.decode(unknownProjectEntry.content)) : {};
  check('unknown native key is not re-emitted as a Neo-only value', !Object.hasOwn(unknownProjectJson, unknownKey));

  if (opts['orca-project']) {
    const source = resolve(opts['orca-project']);
    const copied = join(tempRoot, 'orca-roundtrip.3mf');
    await copyFile(source, copied);
    const orcaBytes = new Uint8Array(await readFile(copied));
    const orcaLoaded = loadProject(Module, orcaBytes, 'orca-roundtrip.3mf');
    const orcaNormalized = normalizedSnapshot(Module);
    check('fixed Orca archive reopens as a project', orcaLoaded.ok === true && orcaLoaded.mode === 'project',
      JSON.stringify({ ok: orcaLoaded.ok, mode: orcaLoaded.mode, compatibility: orcaLoaded.compatibility, error: orcaLoaded.error }));
    check('Orca round trip preserves every recognized scoped golden value',
      orcaLoaded.ok === true && JSON.stringify(selectedScope(orcaNormalized)) === JSON.stringify(selectedScope(golden.normalized)),
      JSON.stringify({ expected: selectedScope(golden.normalized), actual: selectedScope(orcaNormalized) }));
    check('Orca round trip preserves inaccessible Layer Range data', compareLayerRanges(parseLayerRanges(orcaBytes), manifest.golden.layerRanges));
    check('Orca round trip carries no Neo-private project metadata',
      !readZipEntries(orcaBytes).some(({ name }) => privateNeoEntries.includes(name)));
    console.log(`INFO Orca input copied to temporary path ${copied}`);
  } else if (opts['require-orca']) {
    check('fixed Orca archive is supplied', false, 'pass --orca-project <temporary or provisioned Orca save>');
  } else {
    console.log('SKIP fixed Orca save stage (pass --orca-project to run Neo -> Orca -> Neo)');
  }

  console.log(JSON.stringify({
    ok: failures === 0,
    golden_path: goldenPath,
    golden_bytes: golden.bytes.length,
    native_scope_counts: {
      plates: golden.normalized.plates.length,
      objects: golden.normalized.objects.length,
      volumes: golden.normalized.objects.reduce((sum, object) => sum + object.volumes.length, 0),
    },
    external_orca_checked: Boolean(opts['orca-project']),
    unknown_key_fallback_checked: true,
    legacy_private_metadata_negative_checked: true,
  }));
} catch (error) {
  console.error(error.stack ?? error);
  failures++;
}

if (!opts['keep-temp']) await rm(tempRoot, { recursive: true, force: true });
if (failures) process.exitCode = 1;
