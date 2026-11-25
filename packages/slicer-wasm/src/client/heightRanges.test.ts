import { describe, expect, it } from 'vitest';
import { editMockRanges } from './testing/heightRanges';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';

function heightRangeClient(response: object) {
  const module = createMockModule();
  const original = module.ccall;
  module.ccall = (name, ret, types, args) => {
    if (name !== 'orc_edit_height_ranges') return original(name, ret, types, args);
    expect(JSON.parse(String(args[0]))).toEqual({ objectId: 10, operation: 'initialize' });
    const bytes = new TextEncoder().encode(JSON.stringify(response));
    const ptr = module._malloc(bytes.length + 1);
    module.HEAPU8.set(bytes, ptr);
    module.HEAPU8[ptr + bytes.length] = 0;
    return ptr;
  };
  return createClient(async () => module);
}

describe('height range edit receipt', () => {
  const command = { objectId: 10, operation: 'initialize' } as const;
  it('accepts an unchanged selection without publishing a plate mutation', async () => {
    const result = { ok: true, changed: false, selection: [{ min: 0, max: 2 }] };
    expect(await heightRangeClient(result).editHeightRanges(command)).toEqual(result);
  });
  it.each([
    { ok: true, changed: false, selection: [{ min: '0', max: 2 }] },
    { ok: true, changed: true, selection: [] },
  ])('rejects malformed selection or missing changed-plate receipt', async response => {
    expect(await heightRangeClient(response).editHeightRanges(command)).toMatchObject({ ok: false });
  });
});

it('resets multiple keys on the selected mock ranges and preserves other settings', () => {
  const rows = [0, 2, 4].map(min => ({ min, max: min + 2, revision: 1,
    values: { layer_height: '0.12', extruder: '2', wall_loops: '4', sparse_infill_density: '30%' } }));
  let revision = 1;
  const reset = editMockRanges(rows, { operation: 'reset', objectId: 7, targets: rows.slice(1),
    keys: ['layer_height', 'extruder', 'wall_loops'] }, '0.2', () => ++revision);
  expect(reset.rows[0]).toEqual(rows[0]);
  expect(reset.rows.slice(1).map(row => row.values)).toEqual(Array(2).fill({
    layer_height: '0.2', extruder: '0', sparse_infill_density: '30%',
  }));
  expect(editMockRanges(reset.rows, { operation: 'reset', objectId: 7, targets: reset.rows.slice(1),
    keys: ['layer_height', 'extruder', 'wall_loops'] }, '0.2', () => ++revision).changed).toBe(false);
});
