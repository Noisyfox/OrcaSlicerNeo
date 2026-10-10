import type { PresetDraftEditorVector, PresetDraftVectorValue } from './types';

/** Resolve a native element without parsing serialization or losing nullable values. */
export function configVectorElementAt(
  vector: PresetDraftEditorVector, values: readonly PresetDraftVectorValue[], index: number,
): PresetDraftVectorValue | undefined {
  if (!Number.isSafeInteger(index) || index < 0 || index >= vector.indexCount) return undefined;
  return values.length ? values[index < values.length ? index : 0] : vector.scalarType === 'points' ? [] : undefined;
}
