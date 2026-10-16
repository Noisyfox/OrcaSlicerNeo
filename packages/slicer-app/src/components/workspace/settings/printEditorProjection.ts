import { configVectorElementAt } from '@slicer/client';
import type { ConfigEditorSnapshot, OptionMeta, PresetDraftEditorVector, PresetDraftVectorValue } from '@slicer/client';
import { editorFieldTarget, type EditorFieldTarget } from './presetEditorBindings';
import type { ScopedConfigurationField } from './scopedConfigurationProjection';

export interface PrintFieldElement {
  readonly target: EditorFieldTarget;
  readonly vector?: PresetDraftEditorVector;
  readonly source: PresetDraftVectorValue | undefined;
  readonly effective: PresetDraftVectorValue | undefined;
  readonly revision: number;
  readonly metadata?: OptionMeta;
}

export function elementText(value: PresetDraftVectorValue | undefined, vector?: PresetDraftEditorVector): string {
  if (value == null) return '';
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
export function printOwnsField(snapshot: ConfigEditorSnapshot, key: string): boolean {
  return Object.hasOwn(snapshot.sourceValues, key) || Object.hasOwn(snapshot.effectiveValues, key);
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
    editor: { target: unavailable ? {kind:'unavailable'} : target, vector, source, effective, revision: snapshot.revision, metadata:snapshot.optionMetadata[field.key] },
  };
}

/** Convert one UI value to the existing typed element command, never native index math. */
export function parsePrintElement(element: PrintFieldElement, text: string, nullValue = false): PresetDraftVectorValue {
  const vector = element.vector;
  if (!vector || element.target.kind !== 'indexed') throw new Error('This selection has no corresponding native mapping.');
  if (nullValue || (!text.trim() && vector.nullable && vector.scalarType !== 'string')) {
    if (!vector.nullable) throw new Error('This native value cannot be null.');
    return null;
  }
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
