import { configVectorElementAt } from '@slicer/client';
import type { ConfigEditorElementBinding, ConfigEditorSnapshot, PresetDraftEditorBinding, PresetDraftSnapshot } from '@slicer/client';

export type EditorFieldTarget = ConfigEditorElementBinding | { readonly kind: 'shared' };

/** Element selection belongs to the native snapshot, never to page numbering. */
export function editorFieldTarget(snapshot: Pick<ConfigEditorSnapshot, 'editorSelection'>, key: string, choiceId: string | null): EditorFieldTarget {
  const field = snapshot.editorSelection.fieldBindings[key];
  if (field?.kind === 'shared') return field;
  const choice = snapshot.editorSelection.choices.findIndex(candidate => candidate.id === choiceId);
  return choice < 0 || field?.kind !== 'per_selection' ? { kind: 'unavailable' } : field.bindings[choice];
}

export function fieldBinding(snapshot: ConfigEditorSnapshot, key: string, target: EditorFieldTarget): PresetDraftEditorBinding | undefined {
  if (target.kind === 'unavailable') return;
  if (target.kind === 'shared') return snapshot.editorBindings[key];
  const vector = snapshot.editorVectors[key];
  if (!vector || vector.scalarType === 'point' || vector.scalarType === 'points') return;
  const sourceValue = configVectorElementAt(vector, vector.sourceValues, target.index);
  const effectiveValue = configVectorElementAt(vector, vector.effectiveValues, target.index);
  if (sourceValue === undefined || effectiveValue === undefined) return;
  return { ...vector, scalarType: vector.scalarType, index: target.index, elementCount: vector.indexCount,
    sourceValue: sourceValue as PresetDraftEditorBinding['sourceValue'], effectiveValue: effectiveValue as PresetDraftEditorBinding['effectiveValue'] };
}

export function fieldHasOverride(snapshot: PresetDraftSnapshot, key: string, target: EditorFieldTarget): boolean {
  if (key === 'extruders_count') return snapshot.sourceValues[key] !== snapshot.effectiveValues[key];
  if (target.kind === 'unavailable') return false;
  return target.kind === 'indexed' ? snapshot.editorVectors[key]?.overrideValues[target.index] != null : Object.hasOwn(snapshot.overrides, key);
}

/** Page-local choice markers use native ownership, without value/index fallback. */
export function editorDirtyChoiceIds(snapshot: Pick<ConfigEditorSnapshot, 'sourceValues' | 'effectiveValues' | 'editorVectors' | 'editorSelection'> | null, pageKeys: readonly string[]): ReadonlySet<string> {
  const dirty = new Set<string>();
  if (!snapshot) return dirty;
  for (const key of pageKeys) {
    if ((!Object.hasOwn(snapshot.sourceValues, key) && !Object.hasOwn(snapshot.effectiveValues, key)) ||
        snapshot.editorSelection.fieldBindings[key]?.kind !== 'per_selection') continue;
    const vector = snapshot.editorVectors[key];
    if (!vector) continue;
    for (const choice of snapshot.editorSelection.choices) {
      const target = editorFieldTarget(snapshot, key, choice.id);
      if (target.kind === 'indexed' && vector.overrideValues[target.index] != null) dirty.add(choice.id);
    }
  }
  return dirty;
}

export function fieldViewKey(snapshot: ConfigEditorSnapshot, key: string, choiceId: string | null): string {
  const target = editorFieldTarget(snapshot, key, choiceId);
  const choice=snapshot.editorSelection.choices.find(choice=>choice.id===choiceId);
  const identity=choice?JSON.stringify([choice.extruderIndex,choice.variant]):'';
  return `${snapshot.canonicalName}:${key}:${target.kind}:${target.kind === 'indexed' ? `${identity}:${target.index}` : ''}`;
}
