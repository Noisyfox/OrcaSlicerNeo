// ----------------------------------------------------------------
// ---- Real WASM BBS 3MF save -> clear -> load round-trip harness ----
// ----------------------------------------------------------------
// This deliberately drives the public bridge seam directly.  It is run once
// for each production wasm64 variant, so an API that only works with the mock
// module cannot accidentally become the persistence implementation.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { inflateRawSync } from 'node:zlib';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let i = 2; i < argv.length; i += 2) opts[argv[i]?.replace(/^--/, '')] = argv[i + 1];
const modulePath = opts.module;
if (!modulePath) {
  console.error('usage: node project-roundtrip.mjs --module out/orca_slice.js [--profile-root dist] [--model cube.stl]');
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, '../../..');
const modelPath = resolve(opts.model ?? `${repoRoot}/packages/slicer-wasm/fixtures/cube.stl`);
const profileRoot = resolve(opts['profile-root'] ?? `${repoRoot}/packages/profile-resources/dist`);
const factory = await loadModuleFactory(modulePath);
const Module = await factory({ noInitialRun: true, print: console.error, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));

function callJson(name, types, args) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const text = Module.UTF8ToString(ptr);
  Module._free(ptr);
  return JSON.parse(text);
}

function writeBytes(bytes) {
  const ptr = Number(Module._malloc(bytes.byteLength));
  Module.HEAPU8.set(bytes, ptr);
  return ptr;
}

function readAndFree(ptr, length) {
  const bytes = Module.HEAPU8.slice(Number(ptr), Number(ptr) + Number(length));
  Module._free(Number(ptr));
  return bytes;
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Rebuild the exported archive with stored entries while changing only the
// custom Neo metadata. This exercises the real ZIP reader with a deterministic
// duplicate plate index, rather than passing a synthetic malformed payload.
function tamperNeoPlateMetadata(bytes) {
  const source = Buffer.from(bytes);
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let offset = source.length - 22; offset >= 0; offset--) {
    if (readU32(source, offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('exported project has no ZIP end record');

  const entryCount = readU16(source, eocdOffset + 10);
  const centralOffset = readU32(source, eocdOffset + 16);
  const entries = [];
  let centralCursor = centralOffset;
  let neoMetadata = null;
  for (let index = 0; index < entryCount; index++) {
    if (readU32(source, centralCursor) !== 0x02014b50)
      throw new Error('exported project has an invalid ZIP central directory');
    const method = readU16(source, centralCursor + 10);
    const compressedSize = readU32(source, centralCursor + 20);
    const uncompressedSize = readU32(source, centralCursor + 24);
    const nameLength = readU16(source, centralCursor + 28);
    const extraLength = readU16(source, centralCursor + 30);
    const commentLength = readU16(source, centralCursor + 32);
    const localOffset = readU32(source, centralCursor + 42);
    const name = new TextDecoder().decode(source.subarray(centralCursor + 46, centralCursor + 46 + nameLength));
    if (readU32(source, localOffset) !== 0x04034b50)
      throw new Error(`ZIP entry ${name} has no local header`);
    const localNameLength = readU16(source, localOffset + 26);
    const localExtraLength = readU16(source, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = source.subarray(dataOffset, dataOffset + compressedSize);
    let content;
    if (method === 0) content = new Uint8Array(compressed);
    else if (method === 8) content = new Uint8Array(inflateRawSync(compressed));
    else throw new Error(`unsupported ZIP compression method ${method}`);
    if (content.length !== uncompressedSize)
      throw new Error(`ZIP entry ${name} has an invalid size`);

    const entry = { nameBytes: source.subarray(centralCursor + 46, centralCursor + 46 + nameLength), content };
    if (name === 'Metadata/orca_neo_plate_session_v1.json') {
      neoMetadata = JSON.parse(new TextDecoder().decode(content));
      if (!Array.isArray(neoMetadata.plates) || neoMetadata.plates.length < 2)
        throw new Error('exported project has no two-plate Neo metadata');
      neoMetadata.plates[1].plate_index = neoMetadata.plates[0].plate_index;
      entry.content = new TextEncoder().encode(JSON.stringify(neoMetadata));
    }
    entries.push(entry);
    centralCursor += 46 + nameLength + extraLength + commentLength;
  }
  if (!neoMetadata) throw new Error('exported project has no Neo metadata entry');

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const nameLength = entry.nameBytes.length;
    const size = entry.content.length;
    const checksum = crc32(entry.content);
    const local = Buffer.alloc(30 + nameLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameLength, 26);
    Buffer.from(entry.nameBytes).copy(local, 30);
    localParts.push(local, Buffer.from(entry.content));

    const central = Buffer.alloc(46 + nameLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameLength, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    Buffer.from(entry.nameBytes).copy(central, 46);
    centralParts.push(central);
    localOffset += 30 + nameLength + size;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(eocdSignature, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return new Uint8Array(Buffer.concat([...localParts, centralDirectory, eocd]));
}

const model = await readFile(modelPath);
let failures = 0;
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

const init = callJson('orc_init', ['string'], ['']);
check('initialise real module', init.ok === true, JSON.stringify(init));

const modelPtr = writeBytes(model);
const added = callJson('orc_add_model', ['pointer', 'number', 'string', 'string'],
                      [modelPtr, model.length, 'stl', 'cube.stl']);
Module._free(modelPtr);
check('load source geometry', added.ok === true && added.objects === 1 && added.instances === 1,
      JSON.stringify(added));

const before = callJson('orc_get_model_structure', [], []);
const beforeObject = before.objects?.[0];
check('capture source structure', before.ok === true && beforeObject?.volumes?.length === 1,
      JSON.stringify(beforeObject));

const secondPlate = callJson('orc_add_plate', [], []);
check('create second native plate', secondPlate.ok === true && secondPlate.plates?.length === 2,
      JSON.stringify(secondPlate));
const secondPlateModel = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Second Plate Cube']);
check('add geometry to second plate', secondPlateModel.ok === true && secondPlateModel.plate_session.affected_plate_ids_after?.length === 1
      && secondPlateModel.plate_session.affected_plate_ids_after[0] === secondPlate.current_plate_id,
      JSON.stringify(secondPlateModel));
const beforeExportSession = callJson('orc_get_plate_session_snapshot', [], []);
check('capture complete multi-plate session', beforeExportSession.ok === true && beforeExportSession.plates?.length === 2
      && beforeExportSession.instances?.some((instance) => instance.plate_id === beforeExportSession.plates[0].plate_id)
      && beforeExportSession.instances?.some((instance) => instance.plate_id === beforeExportSession.plates[1].plate_id),
      JSON.stringify(beforeExportSession));

const exported = callJson('orc_export_project', [], []);
check('export native BBS 3MF', exported.ok === true && exported.bytes_ptr > 0 && exported.bytes_length > 4,
      JSON.stringify(exported));
const project = exported.ok ? readAndFree(exported.bytes_ptr, exported.bytes_length) : new Uint8Array();
check('export returns a ZIP payload', project[0] === 0x50 && project[1] === 0x4b,
      `bytes=${project.byteLength}`);

if (exported.ok) {
  const corruptProject = tamperNeoPlateMetadata(project);
  const beforeCorruptStructure = callJson('orc_get_model_structure', [], []);
  const beforeCorruptSession = callJson('orc_get_plate_session_snapshot', [], []);
  const corruptPtr = writeBytes(corruptProject);
  const corrupt = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
                           [corruptPtr, corruptProject.length, 0, 'duplicate-plate-index.3mf']);
  Module._free(corruptPtr);
  const afterCorruptStructure = callJson('orc_get_model_structure', [], []);
  const afterCorruptSession = callJson('orc_get_plate_session_snapshot', [], []);
  check('reject duplicate Neo plate index without disturbing active model/session',
        corrupt.ok !== true && JSON.stringify(afterCorruptStructure) === JSON.stringify(beforeCorruptStructure)
        && JSON.stringify(afterCorruptSession) === JSON.stringify(beforeCorruptSession),
        JSON.stringify({ corrupt, active_objects: afterCorruptStructure.objects?.length,
          active_plates: afterCorruptSession.plates?.length }));
}

const cleared = callJson('orc_clear_model', [], []);
check('clear active scene before reload', cleared.ok === true, JSON.stringify(cleared));

if (opts['check-add-model'] === 'true') {
  const addProjectPtr = writeBytes(project);
  const addedProject = callJson('orc_add_model', ['pointer', 'number', 'string', 'string'],
                                [addProjectPtr, project.length, '3mf', 'added.3mf']);
  Module._free(addProjectPtr);
  check('add-model 3MF requests and loads model resources',
        addedProject.ok === true && addedProject.objects === 2 && addedProject.instances === 2,
        JSON.stringify(addedProject));
  callJson('orc_clear_model', [], []);
}
if (opts['check-geometry'] === 'true') {
  const geometryPtr = writeBytes(project);
  const geometry = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
                            [geometryPtr, project.length, 1, 'geometry.3mf']);
  Module._free(geometryPtr);
  check('geometry-only BBS import', geometry.ok === true && geometry.mode === 'geometry-only',
        JSON.stringify(geometry));
  // The native candidate is destroyed after this call.  Keep a follow-up
  // bridge call in the regression sequence so a threaded load cannot leave a
  // backup-manager/lifetime worker or otherwise poison the next request.
  const geometryFollowup = callJson('orc_get_model_structure', [], []);
  check('geometry-only cleanup keeps bridge callable',
        geometryFollowup.ok === true && geometryFollowup.objects?.length === 2,
        JSON.stringify(geometryFollowup));
  callJson('orc_clear_model', [], []);
}

const projectPtr = writeBytes(project);
const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
                        [projectPtr, project.length, 0, 'roundtrip.3mf']);
Module._free(projectPtr);
check('reload exported project', loaded.ok === true && loaded.mode === 'project' && loaded.objects === 2
      && loaded.compatibility === 'bambu' && loaded.project_settings_available === true,
      JSON.stringify(loaded));
const freshHistory = callJson('orc_history_status', [], []);
check('3MF reload starts a clean history baseline', freshHistory.ok !== false &&
      freshHistory.canUndo === false && freshHistory.canRedo === false &&
      freshHistory.dirty === false,
      JSON.stringify(freshHistory));

const afterSession = callJson('orc_get_plate_session_snapshot', [], []);
check('reload preserves plate order and current identity', afterSession.ok === true && afterSession.plates?.length === 2
      && afterSession.current_plate_id === afterSession.plates[1].plate_id
      && afterSession.plates.every((plate, index) => plate.display_index === index),
      JSON.stringify(afterSession));
check('reload preserves plate membership', afterSession.instances?.some((instance) => instance.plate_id === afterSession.plates[0].plate_id)
      && afterSession.instances?.some((instance) => instance.plate_id === afterSession.plates[1].plate_id),
      JSON.stringify(afterSession.instances));
const afterSlice = callJson('orc_get_slice_result', [], []);
check('reload does not restore derived slice result', afterSlice.ok !== true
      && /stale or unavailable/.test(afterSlice.error ?? ''), JSON.stringify(afterSlice));

const after = callJson('orc_get_model_structure', [], []);
const afterObject = after.objects?.[0];
check('round-trip preserves object and volume structure',
      after.ok === true && after.objects?.length === 2 && afterObject?.volumes?.length === beforeObject?.volumes?.length
      && afterObject?.instanceCount === beforeObject?.instanceCount,
      JSON.stringify(afterObject));

const invalidPtr = writeBytes(new Uint8Array([0x01, 0x02, 0x03]));
const invalid = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
                         [invalidPtr, 3, 0, 'invalid.3mf']);
Module._free(invalidPtr);
const afterInvalid = callJson('orc_get_model_structure', [], []);
check('reject invalid project without disturbing the active session',
      invalid.ok !== true && afterInvalid.objects?.length === after.objects?.length
      && afterInvalid.objects?.[0]?.volumes?.length === afterObject?.volumes?.length,
      JSON.stringify({ invalid, objects: afterInvalid.objects?.length }));

if (failures) {
  console.error(`project round-trip failed: ${failures} check(s)`);
  process.exitCode = 1;
}
