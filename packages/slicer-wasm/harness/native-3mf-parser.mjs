// Dependency-free verifier for the native Orca/BBS project archive shape.
// Rules are pinned to the bbs_3mf.cpp revision recorded by the fixture
// manifest. It intentionally verifies only project records, not sliced output.
import { inflateRawSync } from 'node:zlib';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function u16(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
function u32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function readZipEntries(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let eocd = -1;
  for (let at = bytes.length - 22; at >= 0; at--) {
    if (u32(bytes, at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error('ZIP end record not found');
  const count = u16(bytes, eocd + 10);
  const centralOffset = u32(bytes, eocd + 16);
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    if (u32(bytes, cursor) !== 0x02014b50) throw new Error('invalid ZIP central directory');
    const method = u16(bytes, cursor + 10);
    const compressedSize = u32(bytes, cursor + 20);
    const uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    const nameBytes = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    const name = decoder.decode(nameBytes);
    if (u32(bytes, localOffset) !== 0x04034b50) throw new Error(`invalid local header for ${name}`);
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) content = new Uint8Array(inflateRawSync(compressed));
    else throw new Error(`unsupported ZIP compression method ${method} for ${name}`);
    if (content.length !== uncompressedSize) throw new Error(`invalid ZIP size for ${name}`);
    entries.push({ name, nameBytes, content });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function writeStoredZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const content = entry.content instanceof Uint8Array ? entry.content : encoder.encode(entry.content);
    const nameBytes = entry.nameBytes ?? encoder.encode(entry.name);
    const sum = crc32(content);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
    lv.setUint32(14, sum, true); lv.setUint32(18, content.length, true);
    lv.setUint32(22, content.length, true); lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30); locals.push(local, content);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint32(16, sum, true); cv.setUint32(20, content.length, true);
    cv.setUint32(24, content.length, true); cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); central.set(nameBytes, 46); centrals.push(central);
    offset += local.length + content.length;
  }
  const central = concat(centrals);
  const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true); ev.setUint32(12, central.length, true);
  ev.setUint32(16, offset, true);
  return concat([...locals, central, eocd]);
}

function concat(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function attr(text, key) {
  const match = text.match(new RegExp(`${key}="([^\"]*)"`));
  return match?.[1]?.replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function parseNativePlates(xml) {
  const plates = [];
  for (const match of xml.matchAll(/<plate\b[\s\S]*?<\/plate>/g)) {
    const body = match[0];
    const metas = [...body.matchAll(/<metadata\b[^>]*\/>/g)];
    const metadata = Object.fromEntries(metas.map((item) => [attr(item[0], 'key'), attr(item[0], 'value')]).filter(([k]) => k));
    const instances = [...body.matchAll(/<(?:model_)?instance\b[\s\S]*?<\/(?:model_)?instance>/g)].map((item) => {
      const values = Object.fromEntries([...item[0].matchAll(/<metadata\b[^>]*\/>/g)]
        .map((m) => [attr(m[0], 'key'), attr(m[0], 'value')]).filter(([k]) => k));
      return { object_index: Number(values.object_id), instance_index: Number(values.instance_id) };
    });
    plates.push({ index: Number(metadata.plater_id), name: metadata.plater_name ?? '',
      locked: metadata.lock === '1' || metadata.lock === 'true', instances });
  }
  return plates;
}

export function verifyNativeProjectArchive(input) {
  const entries = readZipEntries(input);
  const byName = new Map(entries.map((entry) => [entry.name, entry.content]));
  const model = byName.get('3D/3dmodel.model');
  const settings = byName.get('Metadata/model_settings.config');
  if (!model || !settings) throw new Error('native project is missing 3D model or model_settings.config');
  const xml = decoder.decode(settings);
  if (!xml.includes('<config')) throw new Error('model_settings.config is not XML config');
  const plates = parseNativePlates(xml);
  if (plates.length === 0) throw new Error('native project has no plate records');
  // A project may carry small slice_info bookkeeping, but never embeds the
  // derived per-plate G-code, preview, or thumbnail payloads.
  const derivedArtifacts = entries.map((entry) => entry.name).filter((name) =>
    /(?:gcode|preview|thumbnail|\.png$)/i.test(name));
  return { plates, derivedArtifacts, entryNames: entries.map((entry) => entry.name) };
}

export function replaceEntry(input, name, content) {
  const entries = readZipEntries(input);
  const encoded = content instanceof Uint8Array ? content : encoder.encode(content);
  const index = entries.findIndex((entry) => entry.name === name);
  if (index < 0) throw new Error(`ZIP entry not found: ${name}`);
  entries[index] = { ...entries[index], content: encoded };
  return writeStoredZip(entries);
}
