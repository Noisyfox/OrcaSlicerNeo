import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';

const target = { objectId: 7, plateId: 'plate-1' };
const profile = {
  objectId: target.objectId,
  stamp: { plateId: target.plateId, historyRevision: 1, inputRevision: 2, profileRevision: 3 },
  curve: [0, 0.2, 10, 0.2], objectHeight: 10, baseHeight: 0.2,
  minHeight: 0.08, maxHeight: 0.32, firstHeight: 0.2, canReset: false, hasSavedCurve: false,
};

function clientReply(reply: object, expected: object) {
  const module = createMockModule();
  const original = module.ccall;
  module.ccall = (name, ret, types, args) => {
    if (name !== 'orc_layer_height') return original(name, ret, types, args);
    expect(JSON.parse(String(args[0]))).toEqual(expected);
    const bytes = new TextEncoder().encode(JSON.stringify(reply) + '\0');
    const ptr = module._malloc(bytes.length);
    module.HEAPU8.set(bytes, ptr);
    return ptr;
  };
  return createClient(async () => module);
}

describe('layer height native contract', () => {
  const read = { ...target, operation: 'read' };
  it('reads an effective curve without issuing an edit', async () => {
    expect(await clientReply({ ok: true, profile }, read).readLayerHeight(target)).toEqual(profile);
  });
  it.each([{ objectId: 8 }, { curve: [0, 0.2, 10] }, { stamp: { ...profile.stamp, plateId: 'another' } }])(
    'rejects malformed or stale profile data', async invalid => {
      await expect(clientReply({ ok: true, profile: { ...profile, ...invalid } }, read).readLayerHeight(target)).rejects.toThrow();
    });
  it('retains the native stroke identity across ordered sample batches', async () => {
    const start = { ...target, stamp: profile.stamp };
    expect(await clientReply({ ok: true, strokeId: 3 }, { ...start, operation: 'begin' }).beginLayerHeightStroke(start)).toBe(3);
    const sample = { ...target, strokeId: 3, samples: [{ action: 1 as const, width: 2, z: 5 }] };
    const frame = await clientReply({ ok: true, profile, cells: 2, width: 3, height: 1, pointer: 128 },
      { ...sample, operation: 'samples' }).sampleLayerHeightStroke(sample);
    expect(frame.profile).toEqual(profile);
    expect(frame.pixels).toHaveLength(12);
  });
  it('requires a plate receipt on a changed edit', async () => {
    const edit = { ...target, stamp: profile.stamp, operation: 'adaptive', quality: 0.5 } as const;
    expect(await clientReply({ ok: true, changed: true }, edit).editLayerHeight(edit)).toMatchObject({ ok: false });
    expect(await clientReply({ ok: true, changed: false }, edit).editLayerHeight(edit)).toEqual({ ok: true, changed: false });
  });
});
