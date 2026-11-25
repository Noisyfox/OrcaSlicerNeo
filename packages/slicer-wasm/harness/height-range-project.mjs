import assert from 'node:assert/strict';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';

export function saveProject(module, call) {
  const result = call('orc_export_project', ['string'], ['{}']);
  assert.equal(result.ok, true, JSON.stringify(result));
  const { bytes_ptr, bytes_length } = result;
  try { return module.HEAPU8.slice(Number(bytes_ptr), Number(bytes_ptr) + bytes_length); }
  finally { module._free(bytes_ptr); }
}
export function openProject(module, call, bytes) {
  const ptr = module._malloc(bytes.length);
  try {
    module.HEAPU8.set(bytes, Number(ptr));
    const result = call('orc_load_project', ['pointer', 'number', 'number', 'string'], [ptr, bytes.length, 0, 'ranges.3mf']);
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { module._free(ptr); }
}

export function withRangeMetadata(bytes, rows) {
  const xml = rows.map(([min, max, options]) =>
    `<range min_z="${min}" max_z="${max}">${Object.entries(options)
      .map(([key, value]) => `<option opt_key="${key}">${value}</option>`).join('')}</range>`);
  const name = 'Metadata/layer_config_ranges.xml';
  return writeStoredZip([...readZipEntries(bytes).filter(entry => entry.name !== name), {
    name, content: new TextEncoder().encode(`<objects><object id="1">${xml.join('')}</object></objects>`),
  }]);
}
