import { configVectorElementAt } from '@slicer/client';
import type { ConfigEditorSnapshot, OptionMeta, PresetDraftEditorVector, PresetDraftVectorValue, ScopedConfigEditorSnapshot, ScopedConfigEditorTarget } from '@slicer/client';
import { editorDirtyChoiceIds, editorFieldTarget, type EditorFieldTarget } from './presetEditorBindings';
import type { ScopedConfigurationField } from './scopedConfigurationProjection';

export interface PrintFieldElement {
  readonly perSelection?: boolean;
  readonly target: EditorFieldTarget;
  readonly vector?: PresetDraftEditorVector;
  readonly source: PresetDraftVectorValue | undefined;
  readonly effective: PresetDraftVectorValue | undefined;
  readonly revision: number;
  readonly metadata?: OptionMeta;
  readonly targets?: readonly ScopedConfigEditorTarget[];
  readonly sourceMixed?: boolean;
  readonly inheritedSource?: ScopedConfigurationField['source'];
}

export function elementText(value: PresetDraftVectorValue | undefined, vector?: PresetDraftEditorVector): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(point => `${point.x}, ${point.y}`).join('\n');
  if (typeof value === 'object') {
    if ('x' in value) return `${value.x}, ${value.y}`;
    if ('percent' in value) return `${value.value}${value.percent ? '%' : ''}`;
  }
  if (vector?.scalarType === 'bool') return value ? '1' : '0';
  if (vector?.scalarType === 'enum') return vector.enumOptions?.find(option => option.value === value)?.name ?? String(value);
  return `${value}${vector?.scalarType === 'percent' ? '%' : ''}`;
}

/** The Print snapshot contains only its native owner's options. Absence from
 * fieldBindings alone is not evidence that an owned option is shared. */
export function printOwnsField(snapshot: Pick<ConfigEditorSnapshot, 'sourceValues' | 'effectiveValues'>, key: string): boolean {
  return Object.hasOwn(snapshot.sourceValues, key) || Object.hasOwn(snapshot.effectiveValues, key);
}

/** Whole Process ownership is independent of the current page/nozzle mapping. */
export function printHasLocalOverrides(snapshot: ConfigEditorSnapshot | null, project: Readonly<Record<string, string>>): boolean {
  if (!snapshot) return false;
  return Object.keys(project).some(key => printOwnsField(snapshot, key)) ||
    Object.entries(snapshot.editorVectors).some(([key, vector]) => printOwnsField(snapshot, key) && vector.overrideValues.some(value => value != null));
}

export function scopedDirtyChoiceIds(snapshot: ScopedConfigEditorSnapshot | null, pageKeys: readonly string[]): ReadonlySet<string> {
  return new Set(snapshot?.targets.flatMap(target => [...editorDirtyChoiceIds({ ...target, editorSelection: snapshot.editorSelection }, pageKeys)]) ?? []);
}

/** Native localKeys already excludes nil-only vectors and other authorities.
 * Global ownership must not depend on the active mapping or visible catalogue. */
export function scopedHasLocalOverrides(snapshot: ScopedConfigEditorSnapshot | null): boolean {
  return snapshot?.targets.some(target => target.localKeys.length > 0) ?? false;
}

export function scopedPrintField(field: ScopedConfigurationField, snapshot: ScopedConfigEditorSnapshot, choiceId: string | null): ScopedConfigurationField {
  const target = editorFieldTarget(snapshot, field.key, choiceId);
  const vector = snapshot.targets[0]?.editorVectors[field.key];
  const entries = snapshot.targets.map(owner => {
    const values = owner.editorVectors[field.key];
    const source = target.kind === 'indexed' && values ? configVectorElementAt(values, values.sourceValues, target.index) : owner.sourceValues[field.key];
    const effective = target.kind === 'indexed' && values ? configVectorElementAt(values, values.effectiveValues, target.index) : owner.effectiveValues[field.key];
    const local = target.kind === 'indexed' ? values?.overrideValues[target.index] != null : target.kind === 'shared' && owner.localKeys.includes(field.key);
    const inherited = target.kind === 'indexed' ? owner.sourceScopes.indexed[field.key]?.[target.index] : owner.sourceScopes.shared[field.key];
    return { source, effective, local, inherited, origin: local ? owner.target.scope : inherited };
  });
  const first = entries[0];
  const unavailable = target.kind === 'unavailable' || !first || entries.some(entry => entry.effective === undefined || entry.inherited === undefined) || (target.kind === 'indexed' && !vector);
  const mixed = entries.some(entry => JSON.stringify(entry.effective) !== JSON.stringify(first?.effective));
  const sourceMixed = entries.some(entry => JSON.stringify(entry.source) !== JSON.stringify(first?.source));
  const origin = entries.every(entry => entry.origin === first?.origin) ? first?.origin : 'mixed';
  const inherited = entries.every(entry => entry.inherited === first?.inherited) ? first?.inherited : 'mixed';
  return { ...field, value: unavailable ? 'Unavailable' : mixed ? null : elementText(first.effective, vector), mixed,
    source: origin ?? 'preset', local: !unavailable && entries.some(entry => entry.local), resettable: !unavailable && !vector?.readOnly,
    meta: target.kind === 'indexed' && vector ? { ...field.meta, type: vector.scalarType === 'point' || vector.scalarType === 'points' ? 'string' : vector.scalarType,
      ...(vector.enumOptions ? { enum_values: vector.enumOptions.map(option => option.name), enum_labels: vector.enumOptions.map(option => option.label) } : {}) } : field.meta,
    editor: { perSelection: snapshot.editorSelection.fieldBindings[field.key]?.kind === 'per_selection', target: unavailable ? { kind: 'unavailable' } : target,
      vector, source: first?.source, effective: first?.effective, revision: snapshot.revision, metadata: snapshot.optionMetadata[field.key],
      targets: snapshot.targets.map(owner => owner.target), sourceMixed, inheritedSource: inherited },
  };
}

export function projectPrintField(field: ScopedConfigurationField, snapshot: ConfigEditorSnapshot | null, choiceId: string | null): ScopedConfigurationField {
  if (!snapshot || !printOwnsField(snapshot, field.key)) return field;
  const target = editorFieldTarget(snapshot, field.key, choiceId);
  if (target.kind === 'shared') return field;
  const vector = snapshot.editorVectors[field.key];
  const source = target.kind === 'indexed' && vector ? configVectorElementAt(vector, vector.sourceValues, target.index) : undefined;
  const effective = target.kind === 'indexed' && vector ? configVectorElementAt(vector, vector.effectiveValues, target.index) : undefined;
  const unavailable = target.kind === 'unavailable' || !vector || effective === undefined;
  const local = !unavailable && target.kind === 'indexed' && vector.overrideValues[target.index] != null;
  return { ...field, value: unavailable ? 'Unavailable' : elementText(effective, vector), mixed: false, local,
    source: local ? 'project' : 'preset', resettable: !unavailable && !vector?.readOnly,
    meta: vector ? { ...field.meta, type: vector.scalarType === 'point' || vector.scalarType === 'points' ? 'string' : vector.scalarType,
      ...(vector.enumOptions ? {enum_values:vector.enumOptions.map(option=>option.name), enum_labels:vector.enumOptions.map(option=>option.label)} : {}) } : field.meta,
    editor: { perSelection: snapshot.editorSelection.fieldBindings[field.key]?.kind === 'per_selection',
      target: unavailable ? {kind:'unavailable'} : target, vector, source, effective, revision: snapshot.revision, metadata:snapshot.optionMetadata[field.key] },
  };
}

/** Convert one UI value to the existing typed element command, never native index math. */
export function parsePrintElement(element: PrintFieldElement, text: string): PresetDraftVectorValue {
  const vector = element.vector;
  if (!vector || element.target.kind !== 'indexed') throw new Error('This selection has no corresponding native mapping.');
  if (vector.scalarType === 'string') return text;
  if (vector.scalarType === 'bool') return text === '1';
  if (vector.scalarType === 'enum') {
    const value = vector.enumOptions?.find(option=>option.name===text)?.value;
    if (value === undefined) throw new Error('Choose a native enum value.');
    return value;
  }
  if (vector.scalarType === 'point' || vector.scalarType === 'points') {
    const points = text.split('\n').filter(line=>line.trim()).map(line=>{
      const coordinates=line.split(',').map(value=>value.trim());
      if(coordinates.length!==2 || coordinates.some(value=>!value || !Number.isFinite(Number(value)))) throw new Error('Enter X, Y coordinates, one pair per line.');
      return {x:Number(coordinates[0]), y:Number(coordinates[1])};
    });
    if(vector.scalarType==='points') return points;
    if(points.length!==1) throw new Error('Enter one X, Y coordinate.');
    return points[0];
  }
  const percent=text.trim().endsWith('%');
  const valueText=percent ? text.trim().slice(0,-1) : text.trim();
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(valueText)) throw new Error('Enter a valid number.');
  const value=Number(valueText);
  if(!Number.isFinite(value) || (vector.scalarType==='int' && !Number.isSafeInteger(value)) ||
    (percent && vector.scalarType!=='percent' && vector.scalarType!=='float_or_percent')) throw new Error('Enter a valid number.');
  return vector.scalarType==='float_or_percent' ? {value,percent} : value;
}
