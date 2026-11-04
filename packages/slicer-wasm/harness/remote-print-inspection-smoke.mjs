// Real Orca parser, without project/profile initialization or a retained slice.
import assert from 'node:assert/strict';
import { loadModuleFactory } from './run-slice.mjs';
import { writeStoredZip } from './native-3mf-parser.mjs';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';

const workerPath = process.argv[3] && resolve(process.argv[3]);
const module = await (await loadModuleFactory(process.argv[2]))({ noInitialRun: true, print: () => {}, printErr: () => {} });
function inspect(bytes) {
  const input = module._malloc(bytes.length);
  let output = 0;
  try {
    module.HEAPU8.set(bytes, input);
    output = Number(module.ccall('orc_inspect_remote_print', 'number', ['string'],
      [JSON.stringify({ pointer: Number(input), length: bytes.length })]));
    return JSON.parse(module.UTF8ToString(output));
  } finally { if (output) module._free(output); module._free(input); }
}
const entries = [
  { name: '_rels/.rels', content: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
  { name: '3D/3dmodel.model', content: '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>' },
  { name: 'Metadata/model_settings.config', content: '<config><plate><metadata key="plater_id" value="1"/><metadata key="gcode_file" value="Metadata/plate_1.gcode"/></plate><plate><metadata key="plater_id" value="2"/><metadata key="gcode_file" value="Metadata/plate_2.gcode"/></plate></config>' },
  { name: 'Metadata/slice_info.config', content: '<config><plate><metadata key="index" value="1"/><metadata key="printer_model_id" value="N1"/><metadata key="prediction" value="120"/><metadata key="weight" value="2.5"/><metadata key="filament_maps" value="1"/><filament id="1" type="PLA" color="#FF0000" used_g="2.5" used_m="0.8"/></plate><plate><metadata key="index" value="2"/><metadata key="printer_model_id" value="N1"/><metadata key="prediction" value="240"/><filament id="2" type="PETG" color="#00FF00" used_g="3" used_m="1"/></plate></config>' },
];
const result = inspect(writeStoredZip(entries));
assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.targets.length, 2);
assert.deepEqual(result.targets.map(p => p.plateIndex), [0, 1]);
assert.deepEqual(result.targets.map(p => p.gcodePath), ['Metadata/plate_1.gcode', 'Metadata/plate_2.gcode']);
assert.equal(result.targets[0].materials[0].type, 'PLA');
assert.equal(result.targets[0].materials[0].index, 0);
assert.equal(result.targets[1].materials[0].index, 1);
assert.equal(result.targets[0].duration, '120');
assert.deepEqual(inspect(writeStoredZip(entries)), result, 'repeated inspection has no accumulated state');
assert.equal(inspect(Uint8Array.of(1, 2, 3)).ok, false);
assert.equal(inspect(writeStoredZip(entries.slice(1))).ok, false);
assert.equal(inspect(writeStoredZip([...entries, { name: 'Metadata/plate_1.gcode', content: 'G28' }])).ok, true);
assert.equal(inspect(writeStoredZip([...entries, entries[0]])).ok, true);
assert.equal(inspect(writeStoredZip([...entries, ...Array.from({ length: 300 }, (_, i) => ({ name: `extra/${i}.txt`, content: 'x' }))])).ok, true);
// Valid XML above the former per-resource and bundle budgets stays parser-compatible.
const largeEntries = entries.map(entry => ({ ...entry, content: entry.content + ' '.repeat(9 * 1024 * 1024) }));
assert.equal(inspect(writeStoredZip(largeEntries)).ok, true);
// Orca can derive plates from model_settings without slice_info.
assert.equal(inspect(writeStoredZip(entries.filter(entry => entry.name !== 'Metadata/slice_info.config'))).ok, true);
const many = Array.from({ length: 65 }, (_, i) => `<plate><metadata key="plater_id" value="${i + 1}"/><metadata key="gcode_file" value="Metadata/plate_${i + 1}.gcode"/></plate>`).join('');
const multiPlate = entries.filter(entry => entry.name !== 'Metadata/slice_info.config').map(entry => entry.name === 'Metadata/model_settings.config' ? { ...entry, content: `<config>${many}</config>` } : entry);
assert.equal(inspect(writeStoredZip(multiPlate)).targets.length, 65);
const filaments = Array.from({ length: 257 }, (_, i) => `<filament id="${i + 1}" type="PLA" color="#FF0000" used_g="1" used_m="1"/>`).join('');
const manyMaterials = entries.map(entry => entry.name === 'Metadata/slice_info.config' ? { ...entry, content: `<config><plate><metadata key="index" value="1"/>${filaments}</plate></config>` } : entry);
assert.equal(inspect(writeStoredZip(manyMaterials)).targets[0].materials.length, 257);
if (workerPath) {
  const worker = new Worker(workerPath, { workerData: largeEntries.map(entry => ({
    name: entry.name, bytes: new TextEncoder().encode(entry.content),
  })) });
  const timer = setTimeout(() => worker.terminate(), 30_000);
  try {
    const reply = await new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject);
      worker.once('exit', () => reject(new Error('Inspection worker exited before replying')));
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.value.targets, result.targets);
  } finally { clearTimeout(timer); await worker.terminate(); }
  console.log('remote-print inspection: packaged Node Worker and runtime resource bundle passed');
}
console.log('remote-print inspection: real parser, two plates, repeated reads, malformed ZIP and Orca-compatible unrestricted bundles passed');
process.exit(0);
