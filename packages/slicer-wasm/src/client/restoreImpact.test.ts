import { describe, expect, it } from 'vitest';
import { normalizeRestoreImpact } from './client';

const impact = {
  version: 1, model: 'none', plateSession: true, filamentRack: false,
  presetDrafts: false, profileSelection: false, nativeScopedConfig: true,
  selectionContext: true, primeTower: true, preview: 'current-plate',
};

describe('restore impact normalization', () => {
  it('rejects unknown versions and incomplete internal descriptors', () => {
    for (const value of [undefined, null, {}, { ...impact, version: 2 }])
      expect(normalizeRestoreImpact(value)).toBeUndefined();
    for (const key of Object.keys(impact)) {
      const incomplete: Record<string, unknown> = { ...impact };
      delete incomplete[key];
      expect(normalizeRestoreImpact(incomplete)).toBeUndefined();
    }
  });

  it('retains the explicit current Worker descriptor', () => {
    expect(normalizeRestoreImpact(impact)).toEqual(impact);
    expect(normalizeRestoreImpact({ ...impact, profileSelection: true }))
      .toMatchObject({ profileSelection: true });
  });
});
