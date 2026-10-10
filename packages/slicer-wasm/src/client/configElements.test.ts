import { describe, expect, it } from 'vitest';
import { configVectorElementAt } from './configElements';
import type { PresetDraftEditorVector } from './types';
const vector: PresetDraftEditorVector = { scalarType: 'float', indexCount: 4, nullable: true,
  guiType: 'undefined', guiFlags: '', multiline: false, isCode: false, readOnly: false,
  sourceValues: [null], effectiveValues: [1, 2] };
describe('native vector element reads', () => {
  it('preserves nullable and short-vector semantics within the native valid range', () => {
    expect(configVectorElementAt(vector, vector.sourceValues, 3)).toBeNull();
    expect(configVectorElementAt(vector, vector.effectiveValues, 1)).toBe(2);
    expect(configVectorElementAt(vector, vector.effectiveValues, 3)).toBe(1);
    expect(vector.effectiveValues).toEqual([1, 2]);
  });
  it('rejects invalid indices and preserves empty ordinary/region values', () => {
    for (const index of [-1, 0.5, 4, Infinity]) expect(configVectorElementAt(vector, vector.effectiveValues, index)).toBeUndefined();
    expect(configVectorElementAt(vector, [], 1)).toBeUndefined();
    expect(configVectorElementAt({ ...vector, scalarType: 'points' }, [], 1)).toEqual([]);
  });
});
