import type { ScopedConfigurationField, ScopedConfigurationTarget } from './scopedConfigurationProjection';
import type { OptionPublication } from './optionStateRegistry';

export interface ScopedOptionData {
  readonly field: ScopedConfigurationField;
  readonly targets: readonly ScopedConfigurationTarget[];
  readonly disabled: boolean;
  readonly selectionGutter: boolean;
  readonly viewKey: string;
}

export function scopedOptionPublication(data: ScopedOptionData): OptionPublication<ScopedOptionData> {
  const { field, ...rest } = data;
  const editor = field.editor;
  const vector = editor?.vector;
  const signature = JSON.stringify({ ...rest, field: { ...field, editor: editor && {
    ...editor, revision: undefined,
    vector: vector && { ...vector, sourceValues: undefined, effectiveValues: undefined, overrideValues: undefined },
  } } });
  return { key: field.key, data, signature };
}
