import { describe, expect, it } from 'vitest';
import { normalizeRestoreImpact } from './client';

describe('restore impact normalization', () => {
  it('uses a safe full restore when an old or malformed artifact omits the descriptor', () => {
    for (const value of [undefined, null, {}, { version: 2 }, { version: 1, model: 'none' }]) {
      expect(normalizeRestoreImpact(value)).toMatchObject({
        version: 1, model: 'full', plateSession: true, filamentRack: true,
        projectOverlay: true, selectionContext: true, primeTower: true, preview: 'all',
      });
    }
  });

  it('retains only a complete current Worker descriptor', () => {
    expect(normalizeRestoreImpact({
      version: 1, model: 'none', plateSession: true, filamentRack: false,
      projectOverlay: true, selectionContext: true, primeTower: true, preview: 'current-plate',
    })).toMatchObject({ model: 'none', filamentRack: false, preview: 'current-plate' });
  });
});
