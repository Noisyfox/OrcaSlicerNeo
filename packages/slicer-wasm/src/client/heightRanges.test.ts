import { describe, expect, it } from 'vitest';
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
