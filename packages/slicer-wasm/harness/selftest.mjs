// ----------------------------------------------------------------
// ------------ Harness self-test (no Emscripten required) --------
// ----------------------------------------------------------------
// Verifies run-slice.mjs staging + validation logic against the mock module.
// Run: node harness/selftest.mjs
import assert from 'node:assert/strict';
import { runSlice, validateGcode } from './run-slice.mjs';
import createMockModule from './mock-module.mjs';

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
