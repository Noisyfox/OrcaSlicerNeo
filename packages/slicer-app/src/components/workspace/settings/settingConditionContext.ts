import { configVectorElementAt } from '@slicer/client';
import type { ConfigEditorSnapshot } from '@slicer/client';
import { editorFieldTarget } from './presetEditorBindings';
import { settingValues, type SettingConditionContext, type SettingConditionValue } from './settingConditions';

type EditorValues = Pick<ConfigEditorSnapshot, 'effectiveValues' | 'editorVectors' | 'editorSelection'>;
type ContextOptions = {
  scope: SettingConditionContext['scope'];
  printerValues?: Readonly<Record<string, string>>;
  projectValues?: Readonly<Record<string, string>>;
  isBblPrinter?: boolean;
  nozzleCount?: number;
};

/** Resolve the controlling option's own native binding, not the displayed field's index. */
export function editorSettingContext(snapshot: EditorValues | null, choiceId: string | null, options: ContextOptions): SettingConditionContext {
  const printer = settingValues(key => options.printerValues?.[key]);
  const project = settingValues(key => options.projectValues?.[key]);
  const values = settingValues(key => {
      if (!snapshot || !Object.hasOwn(snapshot.effectiveValues, key)) return project.value(key);
      const vector = snapshot.editorVectors[key];
      if (!vector) return snapshot.effectiveValues[key];
      const binding = editorFieldTarget(snapshot, key, choiceId);
      if (binding.kind === 'unavailable') return undefined;
      const value = configVectorElementAt(vector, vector.effectiveValues, binding.kind === 'indexed' ? binding.index : 0);
      if (vector.scalarType === 'point' || vector.scalarType === 'points') return undefined;
      if (vector.scalarType === 'enum' && typeof value === 'number') return vector.enumOptions?.find(option => option.value === value)?.name;
      return value as SettingConditionValue | undefined;
    }, key => {
      const vector = snapshot?.editorVectors[key];
      if (vector) return vector.effectiveValues.every(value => typeof value === 'number' && Number.isFinite(value)) ? vector.effectiveValues as number[] : undefined;
      const raw = snapshot?.effectiveValues[key];
      return raw === undefined ? printer.numbers(key) : settingValues(() => raw).numbers(key);
    });
  return {
    ...values,
    printer: options.scope === 'printer' ? values : printer, project,
    scope: options.scope,
    isBblPrinter: options.isBblPrinter,
    nozzleCount: options.nozzleCount,
  };
}
