import { test } from 'vitest';
import assert from 'node:assert/strict';
import { extrudingTools } from './nozzle-mapping-gcode.mjs';
test('distinguishes Bambu logical T/H from ordinary physical T commands', () => {
  const deposit = ';TYPE:Outer wall\nG1 X10 Y10 E1\n';
  assert.deepEqual(extrudingTools('; filament_map = 2,1\nT0 H-1\n' + deposit), [1]);
  assert.deepEqual(extrudingTools('; filament_map = 2,1\nT1\n' + deposit), [1]);
  assert.deepEqual(extrudingTools('T0 H1\n' + deposit), [1]);
  assert.deepEqual(extrudingTools('T0 H-1\n' + deposit), [], 'missing physical mapping must not fabricate tool zero');
});
