// Verify the memory ceiling emitted by an Emscripten wasm64 glue module.
//
// Usage:
//   node harness/wasm-memory-contract.mjs --module out/threaded/orca_slice.js
//
// This deliberately inspects generated glue rather than instantiating the
// whole slicer. It catches an accidental removal or spelling change of the
// CMake MAXIMUM_MEMORY link option in the fast build loop.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const moduleIndex = args.indexOf('--module');
const modulePath = moduleIndex >= 0 ? args[moduleIndex + 1] : undefined;
const expectedIndex = args.indexOf('--expected-pages');
const expectedPages = expectedIndex >= 0 ? Number(args[expectedIndex + 1]) : 262_144;

if (!modulePath || !Number.isInteger(expectedPages) || expectedPages <= 0) {
  console.error('usage: node harness/wasm-memory-contract.mjs --module out/threaded/orca_slice.js [--expected-pages 262144]');
  process.exit(2);
}

const source = await readFile(resolve(modulePath), 'utf8');
const matches = [...source.matchAll(/maximum\s*:\s*(\d+)n/g)].map((match) => Number(match[1]));
if (matches.length === 0) {
  throw new Error(`no WebAssembly.Memory maximum found in ${modulePath}`);
}
const uniqueMaximums = [...new Set(matches)];
if (uniqueMaximums.length !== 1 || uniqueMaximums[0] !== expectedPages) {
  throw new Error(`unexpected WebAssembly.Memory maximum in ${modulePath}: found [${uniqueMaximums.join(', ')}], expected ${expectedPages} pages`);
}

console.log(`[wasm-memory-contract] ${modulePath}: maximum=${expectedPages} pages (${expectedPages * 64}KiB)`);
