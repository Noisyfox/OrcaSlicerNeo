import { useSettingsStore } from '@/stores/useSettingsStore';
import { editorSettingContext } from './settingConditionContext';
import { updateOptionStates } from './updateOptionStates';
import { useOptionState, useOptionStateScope, useVisibleOptionCount } from './useOptionState';
import type { OptionStateScope } from './optionStateRegistry';
import { presetOptionPublication, printerNozzleCount, type PresetOptionData } from './presetOptionProjection';
import { configVectorElementAt as vectorAt } from '@slicer/client';
import { UserPresetActions } from './UserPresetActions';
import { editorDirtyChoiceIds, editorFieldTarget, fieldBinding, fieldHasOverride, fieldViewKey } from './presetEditorBindings';
import { PrinterEditorSelection } from './PrinterEditorSelection';
import { EditorSelector } from './EditorSelector';
import { isEditorSelectionVisible, useConfigEditorSelection, usePrinterEditorSelection } from './editorSelection';
import { createContext, memo, useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { XIcon } from 'lucide-react';
import type {
  OptionMeta,
  PresetDraftEditorBinding,
  PresetDraftEditorScalarType,
  PresetDraftEditorValue,
  PresetDraftMutationRequest,
  PresetDraftMutationResult,
  PresetDraftSnapshot,
  PresetDraftTarget,
  PresetDraftEditorVector,
  PresetDraftVectorValue,
  PresetDraftEditorPoint,
  ConfigResetField,
} from '@slicer/client';
import { errorText } from '@orca/slicer-runtime';
import { usePlatform } from '@orca/platform-contract';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { paintingCommandAllowed } from '../viewport/gizmo/painting/projectCommands';
import { commitPresetDraftMutation, CommittedPresetDraftProjectionError } from './configurationActions';
import { Button } from '@/components/ui/button';
import { UserColorPickerPopover } from '@/components/color/UserColorPickerPopover';
import { ColorSwatch } from '@/components/ui/color-picker';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Label } from '@/components/ui/label';
import { NozzleIcon } from '@/components/ui/nozzle-icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from 'cn';
import { PresetCombobox } from '../PresetCombobox';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { optionTooltip } from './optionTooltip';
import {
  FILAMENT_PRESET_EDITOR_MANIFEST,
  PRINTER_PRESET_EDITOR_MANIFEST,
  type PresetEditorManifest,
  type PresetEditorManifestField,
  type PresetEditorManifestGroup,
  type PresetEditorManifestPage,
} from './presetEditorManifests';

export interface PresetEditorDialogProps {
  /** The opening source. Subsequent browsing is owned by this mounted dialog. */
  readonly initialTarget: PresetDraftTarget;
  readonly sceneInteraction: SceneInteractionController | null;
  readonly onClose: () => void;
}

export interface PresetEditorDialogContentProps {
  /** Advances only on opening or an explicit successful preset entry, not receipt/history refresh. */
  readonly sourceEntry?: number;
  readonly userPresetActions?: import('react').ReactNode;
  /** One native target at a time. Pass null when there is no active editor. */
  readonly target: PresetDraftTarget | null;
  readonly snapshot: PresetDraftSnapshot | null;
  /** A history restore is fetching a newer snapshot without replacing the page. */
  readonly refreshing?: boolean;
  readonly loading?: boolean;
  readonly loadError?: string | null;
  readonly mutationPending?: boolean;
  /** Current one-based rack slots that select this Filament source. */
  readonly referencedFilamentSlots?: readonly number[];
  readonly onClose: () => void;
  readonly onSelectPreset: (canonicalName: string) => Promise<void>;
  readonly onMutate: (request: PresetDraftMutationRequest) => Promise<PresetDraftMutationResult>;
}

const PresetEditorValidationContext = createContext<(id: string, invalid: boolean) => void>(() => undefined);

interface RoutedField {
  readonly page: PresetEditorManifestPage;
  readonly group: PresetEditorManifestGroup;
  readonly field: PresetEditorManifestField;
}

type PresetDraftAction =
  | { readonly action: 'set'; readonly key: string; readonly value: string }
  | { readonly action: 'reset-field'; readonly key: string }
  | { readonly action: 'reset-category'; readonly fields: readonly ConfigResetField[] }
  | { readonly action: 'reset-preset' };

function manifestFor(kind: PresetDraftTarget['kind']): PresetEditorManifest {
  return kind === 'printer'
    ? PRINTER_PRESET_EDITOR_MANIFEST
    : FILAMENT_PRESET_EDITOR_MANIFEST;
}

function labelFor(field: PresetEditorManifestField, metadata: OptionMeta | undefined): string {
  // Orca defines this UI-only field in TabPrinter, outside PrintConfigDef.
  if (field.key === 'extruders_count') return 'Extruders';
  return metadata?.label ?? metadata?.full_label ?? field.key;
}

function enumValueText(value: string, metadata: OptionMeta | undefined): string {
  const index = metadata?.type === 'enum' ? metadata.enum_values?.indexOf(value) : undefined;
  return index !== undefined && index >= 0 ? metadata?.enum_labels?.[index] ?? value : value;
}

function valueText(values: Readonly<Record<string, string>>, key: string, metadata: OptionMeta | undefined): string {
  const value = values[key];
  if (value === undefined) return '—';
  return value.length === 0 ? '(empty)' : enumValueText(value, metadata);
}

function searchText(field: PresetEditorManifestField, metadata: OptionMeta | undefined): string {
  return [field.key, labelFor(field, metadata), metadata?.full_label, metadata?.tooltip]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLocaleLowerCase();
}


function coordinateText(value: PresetDraftVectorValue | undefined): string {
  const pointText = (point: PresetDraftEditorPoint) => `${point.x}, ${point.y}`;
  if (Array.isArray(value)) return (value as readonly PresetDraftEditorPoint[]).map(pointText).join('\n');
  return value && typeof value === 'object' && 'x' in value ? pointText(value as PresetDraftEditorPoint) : '';
}

function hasOverride(snapshot: PresetDraftSnapshot, key: string, choiceId: string | null): boolean {
  return fieldHasOverride(snapshot, key, editorFieldTarget(snapshot, key, choiceId));
}
function groupHasOverrides(snapshot: PresetDraftSnapshot, group: PresetEditorManifestGroup, choiceId: string | null): boolean {
  return group.fields.some(field => hasOverride(snapshot, field.key, choiceId));
}
function pageHasOverrides(snapshot: PresetDraftSnapshot, page: PresetEditorManifestPage): boolean {
  return page.groups.some(group => group.fields.some(field => {
    const vector = snapshot.editorVectors[field.key];
    return vector ? vector.overrideValues.some(value => value != null)
      : fieldHasOverride(snapshot, field.key, { kind: 'shared' });
  }));
}

function isColourField(field: PresetEditorManifestField, metadata: OptionMeta | undefined): boolean {
  return field.key === 'default_filament_colour' || metadata?.type === ('color' as OptionMeta['type']);
}

function colourInputValue(value: string): string {
  if (/^#[\da-f]{6}$/i.test(value)) return value;
  if (/^#[\da-f]{3}$/i.test(value)) return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  return '#000000';
}

function isStructuredValue(metadata: OptionMeta | undefined): boolean {
  return metadata !== undefined && [
    'floats', 'ints', 'strings', 'bools', 'percents', 'enums', 'floats_or_percents',
    'point', 'points', 'point3', 'unknown',
  ].includes(metadata.type);
}

function inputTextForBinding(value: PresetDraftEditorValue, scalarType: PresetDraftEditorScalarType): string {
  if (value === null) return '';
  if (scalarType === 'float_or_percent' && typeof value === 'object') return String(value.value);
  return String(value);
}

function controlValue(field: PresetEditorManifestField, snapshot: Pick<PresetDraftSnapshot, 'filamentOverrideContext'>, binding: PresetDraftEditorBinding): PresetDraftEditorValue {
  return field.filamentOverride && binding.effectiveValue === null
    ? snapshot.filamentOverrideContext[field.key]?.[binding.index]?.referenceValue ?? null
    : binding.effectiveValue;
}

function projectedValueText(value: PresetDraftEditorValue, scalarType: PresetDraftEditorScalarType, enumOptions?: PresetDraftEditorBinding['enumOptions']): string {
  if (value === null) return '(null)';
  if (scalarType === 'enum') return enumOptions?.find(option => option.value === value)?.label ?? String(value);
  if (scalarType === 'float_or_percent' && typeof value === 'object')
    return `${value.value}${value.percent ? '%' : ''}`;
  if (scalarType === 'percent' && typeof value === 'number') return `${value}%`;
  if (typeof value === 'string') return value.length === 0 ? '(empty)' : value;
  return String(value);
}

function makeElementMutationRequest(
  snapshot: PresetDraftSnapshot,
  key: string,
  binding: PresetDraftEditorBinding,
  value: PresetDraftEditorValue,
): PresetDraftMutationRequest {
  return {
    kind: snapshot.kind,
    canonicalName: snapshot.canonicalName,
    expectedRevision: snapshot.revision,
    action: 'set-element',
    key,
    scalarType: binding.scalarType,
    index: binding.index,
    value,
  } as PresetDraftMutationRequest;
}

/**
 * Keep scalar validation at the editor boundary. Native metadata is the
 * declared UI constraint, while the Worker remains responsible for accepting
 * the already-normalized configuration value. `Number()` deliberately rejects
 * the partial values that C++ deserialization would otherwise truncate.
 */
function normalizeScalarInput(value: string, metadata: OptionMeta | undefined): string | null {
  if (!metadata) return value;
  const scalarType = metadata?.type;
  if (scalarType !== 'float' && scalarType !== 'int' && scalarType !== 'percent' &&
      scalarType !== 'float_or_percent' && scalarType !== 'floats' && scalarType !== 'ints' &&
      scalarType !== 'percents' && scalarType !== 'floats_or_percents') return value;
  const text = value.trim();
  const integer = scalarType === 'int' || scalarType === 'ints';
  const valid = integer
    ? /^[+-]?\d+$/.test(text)
    : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text);
  if (!valid) return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed) || (integer && !Number.isSafeInteger(parsed))) return null;
  const minimum = typeof metadata.min === 'number' && Number.isFinite(metadata.min)
    ? metadata.min : -Infinity;
  const maximum = typeof metadata.max === 'number' && Number.isFinite(metadata.max)
    ? metadata.max : Infinity;
  if (minimum > maximum) return null;
  const clamped = Math.min(maximum, Math.max(minimum, parsed));
  return String(clamped);
}


function makeMutationRequest(
  snapshot: PresetDraftSnapshot,
  action: PresetDraftAction,
): PresetDraftMutationRequest {
  return { kind: snapshot.kind, canonicalName: snapshot.canonicalName, expectedRevision: snapshot.revision, ...action } as PresetDraftMutationRequest;
}

function FieldValue({
  visible = true,
  conditionReadOnly = false,
  choiceId,
  selectionGutter,
  field,
  metadata,
  snapshot,
  page,
  group,
  loading,
  mutationPending,
  onMutate,
}: {
  visible?: boolean;
  conditionReadOnly?: boolean;
  choiceId: string | null;
  selectionGutter: boolean;
  field: PresetEditorManifestField;
  metadata: OptionMeta | undefined;
  snapshot: PresetDraftSnapshot;
  page?: PresetEditorManifestPage;
  group?: PresetEditorManifestGroup;
  loading: boolean;
  mutationPending: boolean;
  onMutate: PresetEditorDialogContentProps['onMutate'];
}) {
  const label = labelFor(field, metadata);
  const targetBinding = editorFieldTarget(snapshot, field.key, choiceId);
  const fieldIndex = targetBinding.kind === 'indexed' ? targetBinding.index : undefined;
  const unavailable = targetBinding.kind === 'unavailable';
  const binding = fieldBinding(snapshot, field.key, targetBinding);
  const overrideControl = field.filamentOverride === true && snapshot.kind === 'filament';
  const overrideContext = overrideControl && fieldIndex !== undefined ? snapshot.filamentOverrideContext[field.key]?.[fieldIndex] : undefined;
  visible = visible && overrideContext?.visible !== false;
  const vector = fieldIndex === undefined ? undefined : snapshot.editorVectors[field.key];
  const coordinateVector = vector && (vector.scalarType === 'point' || vector.scalarType === 'points') ? vector : undefined;
  const sourceValue = unavailable ? 'Unavailable' : (coordinateVector
    ? coordinateText(vectorAt(coordinateVector, coordinateVector.sourceValues, fieldIndex!)) || '(empty)'
    : binding
    ? projectedValueText(binding.sourceValue, binding.scalarType, binding.enumOptions)
    : valueText(snapshot.sourceValues, field.key, metadata));
  const tooltipKey = fieldIndex !== undefined ? `${field.key}#${fieldIndex}` :
    binding && ['floats', 'ints', 'percents', 'floats_or_percents', 'bools', 'strings', 'enums'].includes(metadata?.type ?? '')
      ? `${field.key}#${binding.index}` : field.key;
  const tooltip = unavailable ? `This selection has no corresponding native mapping.\nParameter name: ${field.key}` : field.key === 'extruders_count'
    ? 'Number of extruders of the printer.\nParameter name: extruders_count'
    : optionTooltip(metadata, tooltipKey);
  const effectiveValue = unavailable ? 'Unavailable' : coordinateVector
    ? coordinateText(vectorAt(coordinateVector, coordinateVector.effectiveValues, fieldIndex!))
    : binding
    ? inputTextForBinding(controlValue(field, snapshot, binding), binding.scalarType)
    : snapshot.effectiveValues[field.key] ?? metadata?.default ?? '';
  const colourField = isColourField(field, metadata);
  const boundText = binding?.scalarType === 'string';
  const missingRequiredBinding = field.nativeElementOnly === true && binding === undefined && !coordinateVector;
  const unsupportedStructured = !binding && !coordinateVector && isStructuredValue(metadata);
  const readOnly = unavailable || field.access === 'read-only' || metadata?.readonly === true || binding?.readOnly === true || coordinateVector?.readOnly === true || missingRequiredBinding || unsupportedStructured || (overrideControl && !overrideContext);
  const readOnlyReason = unavailable ? 'This selection has no corresponding native mapping.' : field.readOnlyReason ?? (metadata?.readonly
    ? field.key === 'extruders_count' ? 'Disable SEMM to change the extruder count.' : 'This value is read-only for the current printer configuration.' : unsupportedStructured
    ? 'This value needs a specialized editor.'
    : missingRequiredBinding ? 'This value needs native element metadata.' : undefined);
  const overridden = fieldHasOverride(snapshot, field.key, targetBinding);
  const [displayValue, setDisplayValue] = useState(effectiveValue);
  const [nullValue, setNullValue] = useState(!overrideControl && binding?.effectiveValue === null);
  const [percentMode, setPercentMode] = useState(
    binding?.scalarType === 'float_or_percent' && binding.effectiveValue !== null &&
      typeof binding.effectiveValue === 'object' && binding.effectiveValue.percent,
  );
  const [fieldError, setFieldError] = useState<string | null>(null);
  const focused = useRef(false);
  const cancelBlur = useRef(false);
  const actionPending = useRef(false);
  const [colourOpen, setColourOpen] = useState(false);
  useEffect(() => setColourOpen(false), [effectiveValue, visible, conditionReadOnly]);

  const inputId = `preset-editor-input-${page?.id ?? 'field'}-${group?.id ?? 'group'}-${field.key}`;
  const reportValidation = useContext(PresetEditorValidationContext);
  useEffect(() => {
    reportValidation(inputId, visible && !conditionReadOnly && fieldError !== null);
    return () => reportValidation(inputId, false);
  }, [fieldError, inputId, reportValidation, visible, conditionReadOnly]);

  useEffect(() => {
    if (focused.current || fieldError !== null) return;
    setDisplayValue(effectiveValue);
    setNullValue(!overrideControl && binding?.effectiveValue === null);
    if (binding?.scalarType === 'float_or_percent' && binding.effectiveValue !== null &&
        typeof binding.effectiveValue === 'object')
      setPercentMode(binding.effectiveValue.percent);
  }, [binding?.effectiveValue, binding?.scalarType, effectiveValue, fieldError, overrideControl]);

  useEffect(() => {
    if (overrideContext && (!overrideContext.visible || !overrideContext.enabled)) {
      focused.current = false;
      setFieldError(null);
      setDisplayValue(effectiveValue);
    }
  }, [overrideContext?.visible, overrideContext?.enabled, effectiveValue]);

  const submitSet = useCallback(async (value: string) => {
    if (!visible || conditionReadOnly || loading || mutationPending || actionPending.current) return;
    actionPending.current = true;
    setFieldError(null);
    setDisplayValue(value);
    try {
      const result = await onMutate(makeMutationRequest(snapshot, { action: 'set', key: field.key, value }));
      if (result.ok) setDisplayValue(result.effectiveValues[field.key] ?? snapshot.sourceValues[field.key] ?? value);
      else setFieldError(result.error);
    } catch (error) {
      setFieldError(errorText(error));
    } finally {
      actionPending.current = false;
    }
  }, [field.key, loading, mutationPending, onMutate, snapshot, visible, conditionReadOnly]);

  const submitElementSet = useCallback(async (value: PresetDraftEditorValue) => {
    if (!visible || conditionReadOnly || !binding || loading || mutationPending || actionPending.current) return;
    actionPending.current = true;
    setFieldError(null);
    setNullValue(!overrideControl && value === null);
    setDisplayValue(inputTextForBinding(value, binding.scalarType));
    if (binding.scalarType === 'float_or_percent' && value !== null && typeof value === 'object')
      setPercentMode(value.percent);
    try {
      const result = await onMutate(makeElementMutationRequest(snapshot, field.key, binding, value));
      if (result.ok) {
        const current = fieldBinding(result, field.key, targetBinding);
        if (current) {
          setDisplayValue(inputTextForBinding(controlValue(field, result, current), current.scalarType));
          setNullValue(!overrideControl && current.effectiveValue === null);
          if (current.scalarType === 'float_or_percent' && current.effectiveValue !== null &&
              typeof current.effectiveValue === 'object')
            setPercentMode(current.effectiveValue.percent);
        }
      } else {
        setFieldError(result.error);
      }
    } catch (error) {
      setFieldError(errorText(error));
    } finally {
      actionPending.current = false;
    }
  }, [binding, field, loading, mutationPending, onMutate, snapshot, targetBinding, overrideControl, visible, conditionReadOnly]);

  const resetField = async () => {
    if (!visible || conditionReadOnly || !overridden || readOnly || loading || mutationPending || actionPending.current) return;
    actionPending.current = true;
    setFieldError(null);
    try {
      const result = await onMutate({ ...makeMutationRequest(snapshot, { action: 'reset-field', key: field.key }),
        ...(fieldIndex === undefined ? {} : { index: fieldIndex }) } as PresetDraftMutationRequest);
      if (!result.ok) {
        setFieldError(result.error);
        return;
      }
      const current = fieldBinding(result, field.key, targetBinding);
      if (current) {
        const value = controlValue(field, result, current);
        setDisplayValue(inputTextForBinding(value, current.scalarType));
        setNullValue(!overrideControl && value === null);
        setPercentMode(current.scalarType === 'float_or_percent' && value !== null &&
          typeof value === 'object' && value.percent);
      } else if (coordinateVector && result.editorVectors?.[field.key]) {
        const currentVector = result.editorVectors[field.key]!;
        setDisplayValue(coordinateText(vectorAt(currentVector, currentVector.effectiveValues, fieldIndex!)));
      } else {
        setDisplayValue(result.effectiveValues[field.key] ?? result.sourceValues[field.key] ?? '');
        setNullValue(false);
        setPercentMode(false);
      }
    } catch (error) {
      setFieldError(errorText(error));
    } finally {
      actionPending.current = false;
    }
  };


  const textLike = metadata?.type === 'string' || metadata?.type === 'unknown' || metadata === undefined;
  const numeric = metadata?.type === 'float' || metadata?.type === 'int' || metadata?.type === 'percent' || metadata?.type === 'float_or_percent';
  const freeText = textLike || numeric;
  const boundNumeric = binding?.scalarType === 'float' || binding?.scalarType === 'int' ||
    binding?.scalarType === 'percent' || binding?.scalarType === 'float_or_percent';
  const multiline = field.multiline === true || binding?.multiline === true;
  const controlsDisabled = !visible || conditionReadOnly || loading || mutationPending || (overrideControl && (!overrideContext?.enabled || binding?.effectiveValue === null));
  const colorControl = <UserColorPickerPopover open={colourOpen} onOpenChange={setColourOpen} title={label}
    value={{ kind: 'solid', color: colourInputValue(displayValue) }} disabled={controlsDisabled}
    onConfirm={next => {
      if (next.kind !== 'solid' || next.color.toLowerCase() === colourInputValue(effectiveValue).toLowerCase()) return;
      if (binding && boundText) void submitElementSet(next.color.toLowerCase());
      else void submitSet(next.color.toLowerCase());
    }} trigger={<Button variant="input" size="icon-sm" id={inputId} aria-label={label}
      data-testid={`preset-editor-input-${field.key}`} value={colourInputValue(displayValue).toLowerCase()}>
      <ColorSwatch value={{ kind: 'solid', color: colourInputValue(displayValue) }} className="size-5" />
    </Button>} />;
  const commitText = () => {
    if (controlsDisabled) return;
    if (coordinateVector) {
      if (displayValue === effectiveValue || actionPending.current || controlsDisabled) return;
      const points: PresetDraftEditorPoint[] = [];
      for (const line of displayValue.split('\n').filter(line => line.trim())) {
        const parts = line.split(',').map(part => part.trim());
        if (parts.length !== 2 || parts.some(part => !part || !Number.isFinite(Number(part)))) {
          setFieldError('Enter X, Y coordinates, one pair per line.'); return;
        }
        points.push({ x: Number(parts[0]), y: Number(parts[1]) });
      }
      if (coordinateVector.scalarType === 'point' && points.length !== 1) {
        setFieldError('Enter one X, Y coordinate.'); return;
      }
      actionPending.current = true;
      setFieldError(null);
      const request = { kind: snapshot.kind, canonicalName: snapshot.canonicalName, expectedRevision: snapshot.revision,
        action: 'set-element', key: field.key, index: fieldIndex!, scalarType: coordinateVector.scalarType,
        value: coordinateVector.scalarType === 'point' ? points[0] : points } as PresetDraftMutationRequest;
      void onMutate(request).then(result => {
        if (!result.ok) setFieldError(result.error);
        else {
          const current = result.editorVectors?.[field.key];
          if (current) setDisplayValue(coordinateText(vectorAt(current, current.effectiveValues, fieldIndex!)));
        }
      }).catch(error => setFieldError(errorText(error))).finally(() => { actionPending.current = false; });
      return;
    }
    if (binding) {
      if (binding.scalarType === 'string') {
        if (binding.effectiveValue !== null && displayValue === effectiveValue) return;
        void submitElementSet(displayValue);
        return;
      }
      if (!boundNumeric) return;
      if (!displayValue.trim()) {
        setFieldError('Enter a valid number.');
        return;
      }
    }
    const normalized = normalizeScalarInput(displayValue, overrideControl && metadata
      ? { ...metadata, min: undefined, max: undefined } : metadata);
    if (normalized === null) {
      setFieldError('Enter a valid number.');
      return;
    }
    if (normalized !== displayValue) setDisplayValue(normalized);
    if (binding && boundNumeric) {
      const numericValue = Number(normalized);
      if (!Number.isFinite(numericValue)) {
        setFieldError('Enter a valid number.');
        return;
      }
      if (binding.scalarType === 'float_or_percent') {
        const current = binding.effectiveValue;
        if (current !== null && typeof current === 'object' &&
            current.value === numericValue && current.percent === percentMode) return;
        void submitElementSet({ value: numericValue, percent: percentMode });
      } else {
        if (binding.effectiveValue === numericValue) return;
        void submitElementSet(numericValue);
      }
    } else if (normalized !== effectiveValue) {
      void submitSet(normalized);
    }
  };
  const handleTextBlur = () => {
    focused.current = false;
    if (cancelBlur.current) {
      cancelBlur.current = false;
      return;
    }
    if (displayValue !== effectiveValue || (binding?.effectiveValue === null && !nullValue)) commitText();
  };
  const handleTextKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (!(multiline || coordinateVector?.scalarType === 'points') || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      focused.current = false;
      cancelBlur.current = true;
      setDisplayValue(effectiveValue);
      setNullValue(binding?.effectiveValue === null);
      if (binding?.scalarType === 'float_or_percent' && binding.effectiveValue !== null &&
          typeof binding.effectiveValue === 'object')
        setPercentMode(binding.effectiveValue.percent);
      setFieldError(null);
      event.currentTarget.blur();
    }
  };
  const setText = (value: string) => {
    setDisplayValue(value);
    if (nullValue) setNullValue(false);
    setFieldError(null);
  };
  const submitBoundNumber = (value: string, nextPercent = percentMode) => {
    const normalized = normalizeScalarInput(value, metadata);
    if (normalized === null || !normalized.trim()) return;
    const numericValue = Number(normalized);
    if (!Number.isFinite(numericValue)) return;
    if (binding?.scalarType === 'float_or_percent')
      void submitElementSet({ value: numericValue, percent: nextPercent });
    else if (binding && (binding.scalarType === 'float' || binding.scalarType === 'int' || binding.scalarType === 'percent'))
      void submitElementSet(numericValue);
  };
  const titleContext = page && group && (
    <p className="mb-1 text-[0.7rem] text-muted-foreground" data-testid={`preset-editor-context-${field.key}`}>
      {page.title} / {group.title}
    </p>
  );

  let control = null;
  if (!readOnly && coordinateVector) {
    const props = { id: inputId, 'aria-label': label, 'data-testid': `preset-editor-input-${field.key}`,
      value: displayValue, disabled: controlsDisabled, onFocus: () => { focused.current = true; },
      onBlur: handleTextBlur, onKeyDown: handleTextKeyDown,
      onChange: (event: { currentTarget: { value: string } }) => setText(event.currentTarget.value) };
    control = <div className="flex flex-col gap-1">
      {coordinateVector.scalarType === 'points' ? <textarea {...props} className="min-h-20 w-full rounded-md border border-input bg-input px-2 py-1 text-xs" /> : <Input {...props} />}
      <span className="text-xs text-muted-foreground">{coordinateVector.scalarType === 'points' ? 'One X, Y coordinate per line.' : 'X, Y coordinates.'}</span>
    </div>;
  } else if (!readOnly && binding?.scalarType === 'bool') {
    control = <Checkbox
      aria-label={label}
      id={inputId}
      data-testid={`preset-editor-input-${field.key}`}
      checked={displayValue === 'true'}
      disabled={controlsDisabled}
      onCheckedChange={(checked) => { void submitElementSet(checked === true); }}
    />;
  } else if (!readOnly && binding?.scalarType === 'enum' && binding.enumOptions?.length) {
    control = <Select
      value={nullValue ? null : String(binding.effectiveValue ?? displayValue)}
      onValueChange={(next) => {
        if (next !== null) void submitElementSet(Number(next));
      }}
      disabled={controlsDisabled}
    >
      <SelectTrigger id={inputId} aria-label={label} data-testid={`preset-editor-input-${field.key}`} className="w-full">
        <SelectValue>
          {(value) => value == null ? '' : binding.enumOptions?.find((option) => String(option.value) === String(value))?.label ?? String(value)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {binding.enumOptions.map((option) => <SelectItem key={option.name} value={String(option.value)}>
          {option.label}
        </SelectItem>)}
      </SelectContent>
    </Select>;
  } else if (!readOnly && binding && boundNumeric) {
    control = <div className="flex min-w-0 items-center gap-2">
      <Input
        aria-label={label}
        id={inputId}
        data-testid={`preset-editor-input-${field.key}`}
        type="text"
        inputMode={binding.scalarType === 'int' ? 'numeric' : 'decimal'}
        value={nullValue ? '' : displayValue}
        disabled={controlsDisabled}
        onFocus={() => { focused.current = true; }}
        onBlur={handleTextBlur}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={handleTextKeyDown}
      />
      {binding.scalarType === 'percent' && <span className="text-xs text-muted-foreground">%</span>}
      {overrideControl && binding.scalarType !== 'percent' && metadata?.sidetext &&
        <span className="shrink-0 text-xs text-muted-foreground">{metadata.sidetext}</span>}
      {binding.scalarType === 'float_or_percent' && <Select
        value={percentMode ? 'percent' : 'absolute'}
        onValueChange={(next) => {
          if (next === null) return;
          const nextPercent = next === 'percent';
          setPercentMode(nextPercent);
          submitBoundNumber(displayValue, nextPercent);
        }}
        disabled={controlsDisabled}
      >
        <SelectTrigger aria-label={`${label} unit`} data-testid={`preset-editor-unit-${field.key}`} className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="absolute">Absolute</SelectItem>
          <SelectItem value="percent">Percent</SelectItem>
        </SelectContent>
      </Select>}
    </div>;
  } else if (!readOnly && binding && boundText && colourField) {
    control = <div className="flex min-w-0 items-center gap-2">
      {colorControl}
    </div>;
  } else if (!readOnly && binding && boundText && multiline) {
    control = <div className="flex min-w-0 flex-col gap-2">
      <textarea
        aria-label={label}
        id={inputId}
        data-testid={`preset-editor-input-${field.key}`}
        value={nullValue ? '' : displayValue}
        disabled={controlsDisabled}
        onFocus={() => { focused.current = true; }}
        onBlur={handleTextBlur}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={handleTextKeyDown}
        className="min-h-20 w-full min-w-0 rounded-md border border-input bg-input/20 px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-xs/relaxed dark:bg-input/30"
      />
    </div>;
  } else if (!readOnly && binding && boundText) {
    control = <div className="flex min-w-0 items-center gap-2">
      <Input
        aria-label={label}
        id={inputId}
        data-testid={`preset-editor-input-${field.key}`}
        type="text"
        value={nullValue ? '' : displayValue}
        disabled={controlsDisabled}
        onFocus={() => { focused.current = true; }}
        onBlur={handleTextBlur}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={handleTextKeyDown}
      />
    </div>;
  } else if (!readOnly && !binding && metadata?.type === 'bool') {
    control = <Checkbox
      aria-label={label}
      id={inputId}
      data-testid={`preset-editor-input-${field.key}`}
      checked={displayValue === '1' || displayValue.toLocaleLowerCase() === 'true'}
      disabled={controlsDisabled}
      onCheckedChange={(checked) => { void submitSet(checked ? '1' : '0'); }}
    />;
  } else if (!readOnly && !binding && metadata?.type === 'enum' && metadata.enum_values?.length) {
    control = <Select
      items={metadata.enum_values.map((value, index) => ({ value, label: metadata.enum_labels?.[index] ?? value }))}
      value={displayValue}
      onValueChange={(next) => { if (next !== null) void submitSet(next); }}
      disabled={controlsDisabled}
    >
      <SelectTrigger id={inputId} aria-label={label} data-testid={`preset-editor-input-${field.key}`} className="w-full">
        <SelectValue>{enumValueText(displayValue, metadata)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {metadata.enum_values.map((value, index) => <SelectItem key={value} value={value}>
          {metadata.enum_labels?.[index] ?? value}
        </SelectItem>)}
      </SelectContent>
    </Select>;
  } else if (!readOnly && colourField) {
    control = colorControl;
  } else if (!readOnly && !binding && freeText) {
    const textProps = {
      'aria-label': label,
      id: inputId,
      'data-testid': `preset-editor-input-${field.key}`,
      value: displayValue,
      disabled: controlsDisabled,
      onFocus: () => { focused.current = true; },
      onBlur: handleTextBlur,
      onChange: (event: { currentTarget: { value: string } }) => {
        setDisplayValue(event.currentTarget.value);
        setFieldError(null);
      },
      onKeyDown: handleTextKeyDown,
    };
    control = multiline
      ? <textarea {...textProps} className="min-h-20 w-full min-w-0 rounded-md border border-input bg-input/20 px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-xs/relaxed dark:bg-input/30" />
      : <Input {...textProps} type="text" inputMode={numeric ? 'decimal' : 'text'} />;
  }


  return (
    <article
      hidden={!visible}
      style={!visible ? { display: 'none' } : undefined}
      data-condition-readonly={conditionReadOnly ? 'true' : 'false'}
      data-testid={`preset-editor-field-${field.key}`}
      data-field-key={field.key}
      data-field-access={readOnly ? 'read-only' : 'editable'}
      data-native-type={metadata?.type ?? 'unknown'}
      data-native-scalar-type={binding?.scalarType}
      data-native-min={metadata?.min}
      data-native-max={metadata?.max}
      aria-disabled={readOnly || conditionReadOnly || undefined}
      title={tooltip}
      className="min-w-0 rounded-md border bg-background/70 px-3 py-2"
    >
      {titleContext}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-0.5">
            {selectionGutter && <span className="flex h-4 w-2.5 shrink-0 items-center justify-center" data-testid={`preset-editor-nozzle-gutter-${field.key}`}>
              {snapshot.editorSelection.fieldBindings[field.key]?.kind === 'per_selection' &&
                <NozzleIcon className="size-4 shrink-0 translate-y-px text-muted-foreground" data-testid={`preset-editor-nozzle-icon-${field.key}`} />}
            </span>}
            <Label
              data-testid={`preset-editor-option-label-${field.key}`}
              data-draft-override-highlight={overridden ? 'true' : 'false'}
              className={cn('block min-w-0 truncate text-sm font-medium', overridden && 'config-override-label')}
              title={tooltip || label}
            >{label}</Label>
          </div>
          <code className="break-all text-[0.7rem] text-muted-foreground">{field.key}</code>
        </div>
        {readOnly && <span
          data-testid={`preset-editor-readonly-${field.key}`}
          title={readOnlyReason}
          className="shrink-0 rounded border px-1.5 py-0.5 text-[0.65rem] text-muted-foreground"
        >Read only</span>}
        {!readOnly && overridden && <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid={`preset-editor-reset-field-${field.key}`}
          disabled={loading || mutationPending}
          onClick={() => void resetField()}
        >Reset</Button>}
      </div>
      {overrideControl && !readOnly && <div className="mt-2 flex items-center gap-2">
        <Checkbox id={`${inputId}-override`} aria-label={`Override ${label}`}
          data-testid={`preset-editor-override-${field.key}`} checked={binding?.effectiveValue !== null}
          disabled={!visible || conditionReadOnly || loading || mutationPending || !overrideContext?.enabled || (binding?.effectiveValue === null && overrideContext.referenceValue === null)}
          onCheckedChange={checked => { void submitElementSet(checked ? overrideContext!.referenceValue : null); }} />
        <Label htmlFor={`${inputId}-override`}>Override</Label>
      </div>}
      {readOnly && readOnlyReason && <p className="mt-1 text-[0.7rem] text-muted-foreground">{readOnlyReason}</p>}
      {readOnly ? (
        <dl className="mt-2 grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Source</dt>
          <dd data-testid={`preset-editor-source-${field.key}`} className="break-all">{sourceValue}</dd>
          <dt className="text-muted-foreground">Effective</dt>
          <dd data-testid={`preset-editor-effective-${field.key}`} className="break-all">{unavailable ? 'Unavailable' : (coordinateVector ? effectiveValue || '(empty)' : binding ? projectedValueText(binding.effectiveValue, binding.scalarType, binding.enumOptions) : valueText(snapshot.effectiveValues, field.key, metadata))}</dd>
        </dl>
      ) : (
        <div className="mt-2 grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs">
          <Label className="text-muted-foreground" htmlFor={inputId}>Value</Label>
          <div className="min-w-0" data-testid={`preset-editor-control-${field.key}`}>{control}</div>
          <span className="text-muted-foreground">Source</span>
          <span data-testid={`preset-editor-source-${field.key}`} className="break-all">{sourceValue}</span>
          <span className="text-muted-foreground">Effective</span>
          <span data-testid={`preset-editor-effective-${field.key}`} className="break-all">{coordinateVector ? effectiveValue || '(empty)' : binding ? projectedValueText(binding.effectiveValue, binding.scalarType, binding.enumOptions) : valueText(snapshot.effectiveValues, field.key, metadata)}</span>
        </div>
      )}
      {fieldError && <p role="alert" data-testid={`preset-editor-error-${field.key}`} className="mt-2 text-xs text-destructive">{fieldError}</p>}
    </article>
  );
}

export const RegistryPresetField = memo(function RegistryPresetField({ scope, field, page, group, selectionGutter = false, onMutate }: {
  scope: OptionStateScope<PresetOptionData>;
  selectionGutter?: boolean;
  field: PresetEditorManifestField;
  page: PresetEditorManifestPage;
  group: PresetEditorManifestGroup;
  onMutate: PresetEditorDialogContentProps['onMutate'];
}) {
  const state = useOptionState(scope, field.key);
  if (!state) return null;
  const { data } = state;
  return <FieldValue key={data.viewKey} visible={state.visible} conditionReadOnly={state.readOnly}
    choiceId={data.choiceId} selectionGutter={selectionGutter} field={field} metadata={data.snapshot.optionMetadata[field.key]}
    snapshot={data.snapshot} page={page} group={group} loading={data.loading}
    mutationPending={data.mutationPending} onMutate={onMutate} />;
});

const FieldGroup = memo(function FieldGroup({ scope, page, group, overridden, selectionGutter, onMutate }: {
  scope: OptionStateScope<PresetOptionData>;
  page: PresetEditorManifestPage;
  group: PresetEditorManifestGroup;
  overridden: boolean;
  selectionGutter: boolean;
  onMutate: PresetEditorDialogContentProps['onMutate'];
}) {
  const keys = useMemo(() => group.fields.map(field => field.key), [group]);
  const count = useVisibleOptionCount(scope, keys);
  const titleId = `preset-editor-group-title-${page.id}-${group.id}`;
  return <section data-testid={`preset-editor-group-${page.id}-${group.id}`} aria-labelledby={titleId}
    hidden={count === 0} style={count === 0 ? { display: 'none' } : undefined} className="min-w-0 space-y-2">
    <h3 id={titleId} data-testid={`preset-editor-group-title-${page.id}-${group.id}`}
      data-draft-override-highlight={overridden ? 'true' : 'false'}
      className={cn('text-module font-semibold', overridden && 'config-override-label')}>{group.title}</h3>
    <div className="grid min-w-0 gap-2 xl:grid-cols-2">{group.fields.map(field =>
      <RegistryPresetField key={field.key} scope={scope} selectionGutter={selectionGutter} field={field} page={page} group={group} onMutate={onMutate} />)}</div>
  </section>;
});

function PresetSearchResults({ scope, results, selectionGutter, onMutate }: {
  selectionGutter: boolean; scope: OptionStateScope<PresetOptionData>; results: readonly RoutedField[]; onMutate: PresetEditorDialogContentProps['onMutate'];
}) {
  const keys = useMemo(() => results.map(result => result.field.key), [results]);
  const count = useVisibleOptionCount(scope, keys);
  return <div data-testid="preset-editor-search-results" className="space-y-3">
    {count === 0 && <p className="py-4 text-sm text-muted-foreground">No matching settings.</p>}
    {results.map(({ page, group, field }) => <RegistryPresetField key={`${page.id}:${group.id}:${field.key}`}
      scope={scope} selectionGutter={selectionGutter} field={field} page={page} group={group} onMutate={onMutate} />)}
  </div>;
}

function presetEditorFieldsForView(manifest: PresetEditorManifest) { return manifest.pages.flatMap(page => page.groups.flatMap(group => group.fields)); }

function routedFields(pages: readonly PresetEditorManifestPage[]): RoutedField[] {
  return pages.flatMap((page) => page.groups.flatMap((group) =>
    group.fields.map((field) => ({ page, group, field }))));
}

function referencedSlotsLabel(slots: readonly number[]): string {
  if (slots.length === 0) return 'No current filament slots use this source.';
  const ordered = [...new Set(slots)].sort((left, right) => left - right);
  const slotLabels = ordered.map((slot) => `slot ${slot}`);
  const slotsText = slotLabels.length === 1
    ? slotLabels[0]
    : `${slotLabels.slice(0, -1).join(', ')} and ${slotLabels.at(-1)}`;
  return `Used by ${slotsText}. Editing this source affects those slots.`;
}

export function PresetEditorDialog({ initialTarget, sceneInteraction, onClose }: PresetEditorDialogProps) {
  const platform = usePlatform();
  const [target, setTarget] = useState(initialTarget);
  const [sourceEntry, setSourceEntry] = useState(0);
  const [snapshot, setSnapshot] = useState<PresetDraftSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const targetRef = useRef<PresetDraftTarget | null>(null);
  const mutationPendingRef = useRef(false);
  const refreshingRef = useRef(false);
  const historyRevisionRef = useRef<number | null>(null);
  const historyPhase = useHistoryRestoreStore(state => state.phase);
  const historyRevision = useHistoryRestoreStore(state => state.revision);
  const filamentSession = useFilamentSessionStore(state => state.snapshot);
  const referencedSlots = target.kind === 'filament'
    ? filamentSession?.slots.filter(slot => slot.preset.name === target.canonicalName).map(slot => slot.slot) ?? []
    : [];

  useEffect(() => {
    const requestedTarget = { ...initialTarget };
    targetRef.current = requestedTarget;
    historyRevisionRef.current = useHistoryRestoreStore.getState().revision;
    setTarget(requestedTarget);
    setSnapshot(null);
    setLoading(true);
    setLoadError(null);
    void platform.runtime.getPresetDraft(requestedTarget.kind, requestedTarget.canonicalName).then(result => {
      if (targetRef.current !== requestedTarget) return;
      if (result.ok) {
        setSnapshot(result);
        if (result.canonicalName !== requestedTarget.canonicalName) {
          const next = { kind: result.kind, canonicalName: result.canonicalName };
          targetRef.current = next; setTarget(next);
          setLoading(false);
        }
      }
      else setLoadError(result.error);
    }).catch(error => {
      if (targetRef.current === requestedTarget) setLoadError(errorText(error));
    }).finally(() => {
      if (targetRef.current === requestedTarget) setLoading(false);
    });
    return () => { targetRef.current = null; };
  }, [initialTarget, platform.runtime]);

  const selectTarget = useCallback(async (canonicalName: string) => {
    const previous = targetRef.current;
    if (!previous || canonicalName === previous.canonicalName || mutationPendingRef.current ||
        refreshingRef.current || !paintingCommandAllowed()) return;
    const requestedTarget = { kind: previous.kind, canonicalName };
    targetRef.current = requestedTarget;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      // Browsing reads a source draft without changing the project selection.
      const result = await platform.runtime.getPresetDraft(previous.kind, canonicalName);
      if (targetRef.current !== requestedTarget) return;
      if (!result.ok) throw new Error(result.error);
      setTarget(requestedTarget);
      setSnapshot(result);
      setSourceEntry(previous => previous + 1);
      setLoadError(null);
    } catch (error) {
      if (targetRef.current !== requestedTarget) return;
      targetRef.current = previous;
      throw error;
    } finally {
      if (targetRef.current === requestedTarget || targetRef.current === previous) {
        refreshingRef.current = false;
        setRefreshing(false);
      }
    }
  }, [platform.runtime]);

  const mutate = useCallback(async (request: PresetDraftMutationRequest): Promise<PresetDraftMutationResult> => {
    const currentTarget = targetRef.current;
    if (!currentTarget || request.kind !== currentTarget.kind || request.canonicalName !== currentTarget.canonicalName) {
      return { ok: false, errorCode: 'invalid_request', error: 'The preset editor target is no longer active.' };
    }
    if (mutationPendingRef.current || refreshingRef.current) {
      return { ok: false, errorCode: 'history_transaction_active', error: 'A preset editor operation is already in progress.' };
    }
    mutationPendingRef.current = true;
    setMutationPending(true);
    try {
      const result = await commitPresetDraftMutation(platform, request, sceneInteraction);
      if (result.ok && targetRef.current === currentTarget) {
        if (result.canonicalName !== currentTarget.canonicalName) {
          const resolvedTarget = { kind: result.kind, canonicalName: result.canonicalName };
          targetRef.current = resolvedTarget;
          setTarget(resolvedTarget);
        }
        setSnapshot(previous => ({ ...result, editorCandidates: result.editorCandidates.kind === 'replace'
          ? result.editorCandidates.items : previous!.editorCandidates }));
        setLoadError(null);
      }
      return result;
    } catch (error) {
      if (error instanceof CommittedPresetDraftProjectionError) {
        const result = error.receipt;
        if (targetRef.current === currentTarget) {
          setSnapshot(previous => ({ ...result, editorCandidates: result.editorCandidates.kind === 'replace'
            ? result.editorCandidates.items : previous!.editorCandidates }));
          setLoadError(error.message);
        }
        return result;
      }
      return { ok: false, errorCode: 'runtime_failure', error: errorText(error) };
    } finally {
      mutationPendingRef.current = false;
      if (targetRef.current) setMutationPending(false);
    }
  }, [platform, sceneInteraction]);

  // Refresh the browsed source after Undo/Redo. If a read or mutation is still
  // pending, retry once it finishes instead of losing that history revision.
  useEffect(() => {
    const currentTarget = targetRef.current;
    if (!currentTarget || loading || mutationPendingRef.current || refreshingRef.current || historyPhase !== 'idle' ||
        historyRevisionRef.current === historyRevision) return;
    historyRevisionRef.current = historyRevision;
    refreshingRef.current = true;
    setRefreshing(true);
    setLoadError(null);
    void platform.runtime.getPresetDraft(currentTarget.kind, currentTarget.canonicalName).then(result => {
      if (targetRef.current !== currentTarget || historyRevisionRef.current !== historyRevision ||
          useHistoryRestoreStore.getState().revision !== historyRevision) return;
      if (result.ok) {
        setSnapshot(result);
        if (result.canonicalName !== currentTarget.canonicalName) {
          const next = { kind: result.kind, canonicalName: result.canonicalName };
          targetRef.current = next; setTarget(next);
          refreshingRef.current = false; setRefreshing(false);
        }
      }
      else setLoadError(result.error);
    }).catch(error => {
      if (targetRef.current === currentTarget && historyRevisionRef.current === historyRevision &&
          useHistoryRestoreStore.getState().revision === historyRevision)
        setLoadError(errorText(error));
    }).finally(() => {
      if (targetRef.current === currentTarget && historyRevisionRef.current === historyRevision) {
        refreshingRef.current = false;
        setRefreshing(false);
      }
    });
  }, [historyPhase, historyRevision, loading, mutationPending, refreshing, platform.runtime]);

  return <PresetEditorDialogContent sourceEntry={sourceEntry} target={target} snapshot={snapshot} loading={loading}
    userPresetActions={<UserPresetActions kind={target.kind} canonicalName={target.canonicalName}
      sceneInteraction={sceneInteraction}
      disabled={loading || refreshing || mutationPending || Boolean(loadError) || historyPhase !== 'idle'}
      onPendingChange={value => { mutationPendingRef.current = value; setMutationPending(value); }}
      onCommitted={async result => {
        const next = { kind: target.kind, canonicalName: result.canonicalName };
        targetRef.current = next;
        setTarget(next);
        const refreshed = await platform.runtime.getPresetDraft(next.kind, next.canonicalName);
        if (targetRef.current !== next) return;
        if (!refreshed.ok) throw new Error(refreshed.error);
        setSnapshot(refreshed);
        setLoadError(null);
      }} />}
    refreshing={refreshing} loadError={loadError} mutationPending={mutationPending}
    referencedFilamentSlots={referencedSlots} onSelectPreset={selectTarget} onMutate={mutate}
    onClose={() => {
      if (mutationPendingRef.current) return;
      targetRef.current = null;
      onClose();
    }} />;
}

export function PresetEditorDialogContent({
  sourceEntry = 0,
  userPresetActions,
  target,
  snapshot,
  refreshing = false,
  loading = false,
  loadError = null,
  mutationPending = false,
  referencedFilamentSlots = [],
  onClose,
  onSelectPreset,
  onMutate,
}: PresetEditorDialogContentProps) {
  const interactionPending = loading || refreshing || mutationPending || loadError !== null;
  const manifest = target ? manifestFor(target.kind) : null;
  const multipleNozzles = snapshot?.kind === 'printer' && snapshot.editorSelection.nozzles.length > 1;
  const pages = useMemo(() => manifest?.pages.map(page =>
    multipleNozzles && page.id === 'extruder' ? { ...page, title: 'Extruders' } : page) ?? [],
  [manifest, multipleNozzles]);
  const selection = usePrinterEditorSelection(target ? snapshot : null, sourceEntry);
  const filamentSelection = useConfigEditorSelection(target?.kind === 'filament' ? snapshot?.editorSelection ?? null : null, sourceEntry);
  const choiceId = target?.kind === 'printer' ? selection.choiceId : filamentSelection.choiceId;
  const optionScope = useOptionStateScope<PresetOptionData>();
  const baseValues = useSettingsStore(state => state.baseValues);
  const printers = useSettingsStore(state => state.printers);
  const activePrinter = useSettingsStore(state => state.selectedPrinter);
  const command = useRef({ snapshot, onMutate, interactionPending });
  const mutateOption = useCallback<PresetEditorDialogContentProps['onMutate']>(request => {
    const current = command.current;
    if (current.interactionPending) return Promise.resolve({ ok: false, error: 'The editor is busy.' });
    if (!current.snapshot || request.kind !== current.snapshot.kind || request.canonicalName !== current.snapshot.canonicalName)
      return Promise.resolve({ ok: false, error: 'The editor target has changed.' });
    return current.onMutate({ ...request, expectedRevision: current.snapshot.revision });
  }, []);
  const optionRows = useMemo(() => snapshot && manifest ? presetEditorFieldsForView(manifest).map(field =>
    presetOptionPublication(snapshot, field.key, choiceId, false, false)) : [],
  [snapshot, manifest, choiceId]);
  useLayoutEffect(() => {
    command.current = { snapshot, onMutate, interactionPending };
    const printerName = target?.kind === 'printer' ? target.canonicalName : activePrinter;
    const printer = printers.find(item => item.name === printerName);
    const context = editorSettingContext(snapshot, choiceId, {
      scope: target?.kind ?? 'printer', printerValues: baseValues, projectValues: baseValues,
      isBblPrinter: printer ? printer.vendor_id === 'BBL' : undefined,
      nozzleCount: target?.kind === 'printer' ? snapshot?.editorVectors.nozzle_diameter?.indexCount : printerNozzleCount(baseValues),
    });
    const input = JSON.stringify([target, choiceId, snapshot?.effectiveValues,
      Object.entries(snapshot?.editorVectors ?? {}).map(([key, vector]) => [key, vector.scalarType, vector.effectiveValues, vector.enumOptions]),
      snapshot?.editorSelection, baseValues, printer?.vendor_id]);
    optionScope.publish(optionRows, snapshot ? [context] : [], updateOptionStates, input);
  }, [optionRows, optionScope, snapshot, onMutate, interactionPending, target, choiceId, baseValues, printers, activePrinter]);

  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const compatibleNames = useMemo(() => new Set(snapshot?.editorCandidates
    .filter(candidate => candidate.compatible).map(candidate => candidate.canonicalName)), [snapshot]);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const reportValidation = useCallback((id: string, invalid: boolean) => {
    setInvalidFields(previous => {
      if (previous.has(id) === invalid) return previous;
      const next = new Set(previous);
      if (invalid) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  // Category presentation survives source changes; closing discards it.
  const navigationKey = target?.kind ?? '';

  useEffect(() => {
    setActivePageId(null);
    setSearch('');
    setActionError(null);
  }, [navigationKey]);

  const activePage = pages.find((page) => page.id === activePageId) ?? pages[0] ?? null;
  const query = search.trim().toLocaleLowerCase();
  const searchResults = useMemo(() => {
    if (!manifest || !snapshot || !query) return [];
    return routedFields(pages).filter(({ field }) =>
      searchText(field, snapshot.optionMetadata[field.key]).includes(query));
  }, [manifest, pages, query, snapshot]);

  const submitAction = async (action: PresetDraftAction) => {
    if (!snapshot || interactionPending) return;
    setActionError(null);
    try {
      const result = await onMutate(makeMutationRequest(snapshot, action));
      if (!result.ok) setActionError(result.error);
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const activePageKeys = activePage?.groups.flatMap((optionGroup) =>
    optionGroup.fields.map((field) => field.key)) ?? [];
  // Reset fields declared by the native snapshot, including its virtual
  // extruder-count transition and capability-locked fields in a joint reset.
  const activePageResetKeys = snapshot === null ? [] : [...new Set(activePageKeys.filter((key) =>
    Object.prototype.hasOwnProperty.call(snapshot.sourceValues, key) ||
    Object.prototype.hasOwnProperty.call(snapshot.effectiveValues, key)))];
  const activePageResetFields: ConfigResetField[] = snapshot === null ? [] : activePageResetKeys.flatMap<ConfigResetField>(key => {
    const binding = editorFieldTarget(snapshot, key, choiceId);
    return binding.kind === 'unavailable' ? [] : [{ key, ...binding }];
  });
  const categoryHasOverrides = snapshot !== null && activePageResetFields.some(field => fieldHasOverride(snapshot, field.key, field));
  const selectionVisible = isEditorSelectionVisible(snapshot?.editorSelection, query ? searchResults.map(result => result.field.key) : activePageKeys);
  const showSearchResults = query.length > 0;
  const showPrinterSelection = snapshot?.kind === 'printer' && selectionVisible;
  const showFilamentSelection = snapshot?.kind === 'filament' && selectionVisible;
  const showCategoryReset = snapshot !== null && !loadError && !loading && !showSearchResults && activePage !== null;
  const dirtyChoiceIds = editorDirtyChoiceIds(snapshot, activePageKeys);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open && target && !mutationPending) onClose(); }}>
      {target && manifest && <DialogContent
        data-testid="preset-editor-dialog"
        className="flex max-h-[88vh] w-[min(94vw,72rem)] max-w-none flex-col gap-4 overflow-hidden p-5"
      >
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4">
          <div className="min-w-0">
            <DialogTitle id="preset-editor-title" data-testid="preset-editor-title" className="truncate text-lg">
              {snapshot?.editorCandidates.find(candidate => candidate.canonicalName === target.canonicalName)?.label ?? target.canonicalName}
            </DialogTitle>
            <DialogDescription className="mt-1">
              {target.kind === 'printer' ? 'Printer preset' : 'Filament preset'}
            </DialogDescription>
          </div>
          <div className="flex items-center gap-2">
            {snapshot?.modified && <span
              data-testid="preset-editor-project-draft"
              className="rounded border px-2 py-1 text-xs"
            >Project draft</span>}
            <Button
              type="button"
              variant="destructive"
              size="xs"
              data-testid="preset-editor-reset-preset"
              disabled={interactionPending || !snapshot?.draftExists}
              onClick={() => void submitAction({ action: 'reset-preset' })}
            >Reset preset</Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close preset editor"
              data-testid="preset-editor-close"
              disabled={mutationPending}
              onClick={onClose}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </div>
          {snapshot && <div className="col-span-2 mt-2 flex min-w-0 flex-wrap items-center gap-1">
            <div className="flex w-[min(32rem,60vw)] max-w-full">
            <PresetCombobox
              mode="select"
              items={snapshot.editorCandidates.map(candidate => ({ id: candidate.canonicalName, isProjectEmbedded: candidate.isProjectEmbedded, isUser: candidate.isUser,
                name: candidate.canonicalName, label: candidate.label, modified: candidate.modified }))}
              value={target.canonicalName} modified={snapshot.modified} disabled={interactionPending || invalidFields.size > 0}
              onValue={name => {
                if (interactionPending || invalidFields.size > 0) return;
                setActionError(null);
                void onSelectPreset(name).catch(error => setActionError(errorText(error)));
              }} ariaLabel="Preset to edit" testId="preset-editor-preset"
              searchPlaceholder="Search presets to edit…" emptyText="No matching preset"
              sectionBy={target.kind === 'filament' ? item => compatibleNames.has(item.id)
                ? 'Compatible with project printer' : 'Not compatible with project printer' : undefined}
            />
            </div>
            {userPresetActions}
          </div>}
          {target.kind === 'filament' && <p
            data-testid="preset-editor-slot-reference"
            className="col-span-2 mt-1 text-xs text-muted-foreground"
          >{referencedSlotsLabel(referencedFilamentSlots)}</p>}
        </div>

        <PresetEditorValidationContext.Provider value={reportValidation}>
        <div key={`${target.kind}:${target.canonicalName}`} className="flex min-h-0 flex-1 flex-col gap-3">
          <SearchInput
            type="search"
            aria-label={`Search ${target.kind} preset settings`}
            data-testid="preset-editor-search"
            placeholder="Search by name, key, or help text"
            value={search}
            disabled={loading || refreshing || !snapshot}
            onValueChange={setSearch}
          />

          {!showSearchResults && <div role="tablist" aria-label="Preset setting pages" className="flex shrink-0 gap-1 overflow-x-auto border-b">
            {pages.map((page) => {
              const overridden = snapshot !== null && pageHasOverrides(snapshot, page);
              return (
                <button
                  key={page.id}
                  id={`preset-editor-tab-${page.id}`}
                  type="button"
                  role="tab"
                  aria-selected={activePage?.id === page.id}
                  aria-controls={`preset-editor-page-${page.id}`}
                  data-testid={`preset-editor-page-tab-${page.id}`}
                  data-draft-override-highlight={overridden ? 'true' : 'false'}
                  disabled={loading || refreshing || !snapshot}
                  onClick={() => { setActivePageId(page.id); setSearch(''); setActionError(null); }}
                  className={cn(
                    'shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground aria-selected:border-primary aria-selected:text-foreground',
                    overridden && 'config-override-label',
                  )}
                >{page.title}</button>
              );
            })}
          </div>}

          {snapshot && (showPrinterSelection || showFilamentSelection || showCategoryReset) &&
            <div className="flex shrink-0 items-start gap-3">
              <div className="min-w-0 flex-1 overflow-x-auto">
                {showPrinterSelection && <PrinterEditorSelection snapshot={snapshot} selection={selection}
                  disabled={loading || refreshing} dirtyChoiceIds={dirtyChoiceIds} />}
                {showFilamentSelection && <EditorSelector mode="flat"
                  items={snapshot.editorSelection.choices.map(choice => ({ id: choice.id, label: choice.label, primary: choice.label }))}
                  choiceId={filamentSelection.choiceId} onSelect={filamentSelection.select}
                  dirtyChoiceIds={dirtyChoiceIds}
                  disabled={loading || refreshing} testId="preset-editor-variant" label="Filament variant" />}
              </div>
              {showCategoryReset && activePage && <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                data-testid={`preset-editor-reset-category-${activePage.id}`}
                disabled={!categoryHasOverrides || interactionPending}
                onClick={() => void submitAction({ action: 'reset-category', fields: activePageResetFields })}
              >Reset category</Button>}
            </div>}

          {actionError && <p role="alert" data-testid="preset-editor-action-error" className="text-xs text-destructive">{actionError}</p>}

          <fieldset disabled={interactionPending} data-testid="preset-editor-option-lock" className="min-h-0 min-w-0 flex-1 overflow-y-auto border-0 p-0 pr-1">
            {loadError ? (
              <p role="alert" data-testid="preset-editor-load-error" className="py-4 text-sm text-destructive">{loadError}</p>
            ) : loading || !snapshot ? (
              <p data-testid="preset-editor-loading" className="py-4 text-sm text-muted-foreground">Loading preset settings…</p>
            ) : showSearchResults ? (
              <PresetSearchResults selectionGutter={showPrinterSelection || showFilamentSelection} scope={optionScope} results={searchResults} onMutate={mutateOption} />
            ) : activePage ? (
              <div
                id={`preset-editor-page-${activePage.id}`}
                role="tabpanel"
                aria-labelledby={`preset-editor-tab-${activePage.id}`}
                data-testid={`preset-editor-page-${activePage.id}`}
                className="space-y-5 pb-1"
              >
                {activePage.groups.map((optionGroup) => <FieldGroup
                  key={optionGroup.id}
                  scope={optionScope}
                  selectionGutter={showPrinterSelection || showFilamentSelection}
                  page={activePage}
                  group={optionGroup}
                  overridden={groupHasOverrides(snapshot, optionGroup, choiceId)}
                  onMutate={mutateOption}
                />)}
              </div>
            ) : null}
          </fieldset>
        </div>
        </PresetEditorValidationContext.Provider>
      </DialogContent>}
    </Dialog>
  );
}
