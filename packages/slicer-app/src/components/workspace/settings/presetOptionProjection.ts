import { configVectorElementAt } from '@slicer/client';
import type { PresetDraftSnapshot } from '@slicer/client';
import { editorFieldTarget, fieldBinding, fieldHasOverride, fieldViewKey } from './presetEditorBindings';
import type { OptionPublication } from './optionStateRegistry';

export interface PresetOptionData {
  readonly snapshot: PresetDraftSnapshot;
  readonly choiceId: string | null;
  readonly viewKey: string;
  readonly loading: boolean;
  readonly mutationPending: boolean;
}

/** A field retains only its own option. Equal projections reuse the registry entry,
 * not a whole historical editor snapshot. Revision is read by the command controller.
 */
export function presetOptionPublication(snapshot: PresetDraftSnapshot, key: string, choiceId: string | null,
  loading: boolean, mutationPending: boolean): OptionPublication<PresetOptionData> {
  const target = editorFieldTarget(snapshot, key, choiceId);
  const binding = fieldBinding(snapshot, key, target);
  const vector = snapshot.editorVectors[key];
  const viewKey = fieldViewKey(snapshot, key, choiceId);
  const selectedVector = vector && target.kind === 'indexed' ? {
    ...vector, sourceValues: configVectorElementAt(vector, vector.sourceValues, target.index),
    effectiveValues: configVectorElementAt(vector, vector.effectiveValues, target.index), overrideValues: undefined,
  } : undefined;
  const scalarBinding = binding && { scalarType: binding.scalarType, index: binding.index, elementCount: binding.elementCount,
    nullable: binding.nullable, guiType: binding.guiType, guiFlags: binding.guiFlags, multiline: binding.multiline,
    isCode: binding.isCode, readOnly: binding.readOnly, sourceValue: binding.sourceValue,
    effectiveValue: binding.effectiveValue, enumOptions: binding.enumOptions };
  const signature = JSON.stringify([viewKey, snapshot.optionMetadata[key], scalarBinding, selectedVector && !binding ? selectedVector : undefined,
    binding || selectedVector ? undefined : [snapshot.sourceValues[key], snapshot.effectiveValues[key]],
    fieldHasOverride(snapshot, key, target), snapshot.filamentOverrideContext[key], loading, mutationPending]);
  const pick = <T,>(values: Readonly<Record<string, T>>): Record<string, T> => Object.hasOwn(values, key) ? { [key]: values[key] } : {};
  const narrowed: PresetDraftSnapshot = {
    ...snapshot, sourceValues: pick(snapshot.sourceValues), effectiveValues: pick(snapshot.effectiveValues),
    optionMetadata: pick(snapshot.optionMetadata), editorVectors: pick(snapshot.editorVectors),
    editorBindings: pick(snapshot.editorBindings), filamentOverrideContext: pick(snapshot.filamentOverrideContext), overrides: pick(snapshot.overrides), editorCandidates: [],
    editorSelection: { ...snapshot.editorSelection, fieldBindings: pick(snapshot.editorSelection.fieldBindings) },
  };
  return { key, signature, data: { snapshot: narrowed, choiceId, viewKey, loading, mutationPending } };
}

export function printerNozzleCount(values: Readonly<Record<string, string>>) {
  const text = values.nozzle_diameter;
  if (!text) return undefined;
  const elements = text.startsWith('[') ? (() => { try { return JSON.parse(text) as unknown; } catch { return undefined; } })() : text.split(',');
  return Array.isArray(elements) && elements.length > 0 && elements.every(value => Number.isFinite(Number(value))) ? elements.length : undefined;
}
