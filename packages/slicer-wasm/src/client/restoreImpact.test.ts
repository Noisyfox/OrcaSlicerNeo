import { describe, expect, it } from 'vitest';
import { normalizeRestoreImpact } from './client';

describe('restore impact normalization', () => {
  it('keeps malformed descriptors on the SceneDelta path without introducing a full fallback', () => {
    for (const value of [undefined, null, {}, { version: 2 }, { version: 1, model: 'none' }]) {
      expect(normalizeRestoreImpact(value)).toMatchObject({
        version: 1, model: 'delta', plateSession: true, filamentRack: true,
        presetDrafts: true, nativeScopedConfig: true, selectionContext: true, primeTower: true, preview: 'all',
      });
    }
  });

  it('retains only a complete current Worker descriptor', () => {
    expect(normalizeRestoreImpact({
      version: 1, model: 'none', plateSession: true, filamentRack: false,
      presetDrafts: false, nativeScopedConfig: true, selectionContext: true, primeTower: true, preview: 'current-plate',
    })).toMatchObject({ model: 'none', filamentRack: false, preview: 'current-plate' });
  });
});
