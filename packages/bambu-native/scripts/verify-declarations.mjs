import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../../', import.meta.url);
const originals = ['bambu_networking.hpp', 'BBLNetworkPlugin.hpp'].map(name => readFileSync(new URL(`slicer-wasm/cpp/src/slic3r/Utils/${name}`, root), 'utf8')).join('\n');
const declarations = readFileSync(new URL('../native/plugin_api.hpp', import.meta.url), 'utf8');
for (const line of declarations.split('\n').filter(line => line.startsWith('typedef '))) {
  assert(originals.split('\n').includes(line), `Public Orca declaration changed: ${line}`);
}
console.log('Common plugin declarations match checked-in Orca headers');

const printParams = readFileSync(new URL('../native/print_params.hpp', import.meta.url), 'utf8');
const structure = /struct PrintParams \{[\s\S]*?\n\};/;
assert.equal(printParams.match(structure)?.[0], originals.match(structure)?.[0], 'PrintParams ABI drift');
