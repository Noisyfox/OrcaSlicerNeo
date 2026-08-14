// ----------------------------------------------------------------
// ------------ Harness self-test (no Emscripten required) --------
// ----------------------------------------------------------------
// Verifies run-slice.mjs staging + validation logic against the mock module.
// Run: node harness/selftest.mjs
import assert from 'node:assert/strict';
import { buildSliceArgs, runSlice, validateGcode } from './run-slice.mjs';
import createMockModule from './mock-module.mjs';

// Regression: the CLI passes mainArgs straight to callMain, and the C++ side
// can only open files inside its own virtual FS. A HOST path (e.g.
// "packages/slicer-wasm/fixtures/config.json") makes config.load() read an
// empty stream and die with "parse error ... unexpected end of input" —
// exactly what burned CI run 5. Every mainArgs entry must be a /-rooted
// MEMFS path, and the staged config path must be what argv gets.
const inv = buildSliceArgs('C:/repo/fixtures/cube.stl', 'C:/repo/fixtures/config.json');
for (const arg of inv.mainArgs) {
  assert.ok(arg.startsWith('/') && !arg.includes('\\'),
    `mainArgs must be MEMFS paths, got: ${arg}`);
}
assert.equal(inv.mainArgs[1], '/config.json');
assert.equal(inv.configMemfsPath, '/config.json');
assert.equal(inv.stlMemfsPath, '/model.stl');

const result = await runSlice({
  createModule: createMockModule,
  stagedFiles: {
    '/model.stl': Buffer.from('solid x\nendsolid x\n'),
    '/config.ini': Buffer.from('layer_height = 0.2\n'),
  },
  mainArgs: ['/model.stl', '/config.ini', '/out.gcode'],
  outputPath: '/out.gcode',
});

assert.equal(result.exitCode, 0, 'expected clean exit');
const check = validateGcode(result.output);
assert.ok(check.ok, `expected valid gcode, got: ${check.reason}`);
assert.ok(check.lineCount > 1, 'expected multiple gcode lines');

// A missing output must be reported as a failure, not a crash.
const negative = validateGcode(null);
assert.equal(negative.ok, false);

console.log(`harness self-test passed (${check.bytes} bytes, ${check.lineCount} lines)`);
