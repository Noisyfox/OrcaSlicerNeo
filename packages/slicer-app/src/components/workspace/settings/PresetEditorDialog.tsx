import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
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
} from '@slicer/client';
import { errorText } from '@orca/slicer-runtime';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  FILAMENT_PRESET_EDITOR_MANIFEST,
  PRINTER_PRESET_EDITOR_MANIFEST,
  type PresetEditorManifest,
  type PresetEditorManifestField,
  type PresetEditorManifestGroup,
  type PresetEditorManifestPage,
} from './presetEditorManifests';

export interface PresetEditorDialogProps {
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
  readonly onMutate: (request: PresetDraftMutationRequest) => Promise<PresetDraftMutationResult>;
}

interface RoutedField {
  readonly page: PresetEditorManifestPage;
  readonly group: PresetEditorManifestGroup;
  readonly field: PresetEditorManifestField;
}

type PresetDraftAction =
  | { readonly action: 'set'; readonly key: string; readonly value: string }
  | { readonly action: 'reset-field'; readonly key: string }
  | { readonly action: 'reset-category'; readonly keys: readonly string[] }
  | { readonly action: 'reset-preset' };

function manifestFor(kind: PresetDraftTarget['kind']): PresetEditorManifest {
  return kind === 'printer'
    ? PRINTER_PRESET_EDITOR_MANIFEST
    : FILAMENT_PRESET_EDITOR_MANIFEST;
}

function printerExtruderCount(snapshot: PresetDraftSnapshot): number | null {
  const count = snapshot.editorBindings.nozzle_diameter?.elementCount;
  if (count === undefined) return null;
  return Number.isSafeInteger(count) && count > 0 && count <= 64 ? count : null;
}

function pageInstances(manifest: PresetEditorManifest, snapshot: PresetDraftSnapshot | null): PresetEditorManifestPage[] {
  return manifest.pages.flatMap((page) => {
    if (!snapshot || manifest.kind !== 'printer' || page.id !== 'extruder') return [page];
    const count = printerExtruderCount(snapshot);
    if (count === null) return [page];
    return Array.from({ length: count }, (_, index) => ({
      ...page,
      id: `extruder-${index + 1}`,
      title: `Extruder ${index + 1}`,
    }));
  });
}

function labelFor(field: PresetEditorManifestField, metadata: OptionMeta | undefined): string {
  return metadata?.label ?? metadata?.full_label ?? field.key;
}

function valueText(values: Readonly<Record<string, string>>, key: string): string {
  const value = values[key];
  if (value === undefined) return '—';
  return value.length === 0 ? '(empty)' : value;
}

function searchText(field: PresetEditorManifestField, metadata: OptionMeta | undefined): string {
  return [field.key, metadata?.label, metadata?.full_label, metadata?.tooltip]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLocaleLowerCase();
}

function hasOverride(snapshot: PresetDraftSnapshot, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(snapshot.overrides, key);
}

function groupHasOverrides(snapshot: PresetDraftSnapshot, group: PresetEditorManifestGroup): boolean {
  return group.fields.some((field) => hasOverride(snapshot, field.key));
}

function pageHasOverrides(snapshot: PresetDraftSnapshot, page: PresetEditorManifestPage): boolean {
  return page.groups.some((group) => groupHasOverrides(snapshot, group));
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

function projectedValueText(value: PresetDraftEditorValue, scalarType: PresetDraftEditorScalarType): string {
  if (value === null) return '(null)';
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

const NULL_ENUM_VALUE = '__preset_editor_null__';

function makeMutationRequest(
  snapshot: PresetDraftSnapshot,
  action: PresetDraftAction,
): PresetDraftMutationRequest {
  return { kind: snapshot.kind, canonicalName: snapshot.canonicalName, expectedRevision: snapshot.revision, ...action } as PresetDraftMutationRequest;
}

function FieldValue({
  field,
  metadata,
  snapshot,
  page,
  group,
  loading,
  mutationPending,
  onMutate,
}: {
  field: PresetEditorManifestField;
  metadata: OptionMeta | undefined;
  snapshot: PresetDraftSnapshot;
  page?: PresetEditorManifestPage;
  group?: PresetEditorManifestGroup;
  loading: boolean;
  mutationPending: boolean;
  onMutate: PresetEditorDialogProps['onMutate'];
}) {
  const label = labelFor(field, metadata);
  const tooltip = metadata?.tooltip;
  const binding = snapshot.editorBindings[field.key];
  const sourceValue = binding
    ? projectedValueText(binding.sourceValue, binding.scalarType)
    : valueText(snapshot.sourceValues, field.key);
  const effectiveValue = binding
    ? inputTextForBinding(binding.effectiveValue, binding.scalarType)
    : snapshot.effectiveValues[field.key] ?? metadata?.default ?? '';
  const colourField = isColourField(field, metadata);
  const boundText = binding?.scalarType === 'string';
  const missingRequiredBinding = field.nativeElementOnly === true && binding === undefined;
  const unsupportedStructured = !binding && isStructuredValue(metadata);
  const readOnly = field.access === 'read-only' || binding?.readOnly === true || missingRequiredBinding || unsupportedStructured;
  const readOnlyReason = field.readOnlyReason ?? (unsupportedStructured
    ? 'This value needs a specialized editor.'
    : missingRequiredBinding ? 'This value needs native element metadata.' : undefined);
  const overridden = hasOverride(snapshot, field.key);
  const [displayValue, setDisplayValue] = useState(effectiveValue);
  const [nullValue, setNullValue] = useState(binding?.effectiveValue === null);
  const [percentMode, setPercentMode] = useState(
    binding?.scalarType === 'float_or_percent' && binding.effectiveValue !== null &&
      typeof binding.effectiveValue === 'object' && binding.effectiveValue.percent,
  );
  const [fieldError, setFieldError] = useState<string | null>(null);
  const focused = useRef(false);
  const cancelBlur = useRef(false);
  const actionPending = useRef(false);
  const colourInput = useRef<HTMLInputElement>(null);
  const effectiveValueRef = useRef(effectiveValue);
  const setValueRef = useRef<(value: string) => Promise<void>>(async () => undefined);
  const setElementRef = useRef<(value: PresetDraftEditorValue) => Promise<void>>(async () => undefined);
  effectiveValueRef.current = effectiveValue;

  const inputId = `preset-editor-input-${page?.id ?? 'field'}-${group?.id ?? 'group'}-${field.key}`;

  useEffect(() => {
    if (focused.current || fieldError !== null) return;
    setDisplayValue(effectiveValue);
    setNullValue(binding?.effectiveValue === null);
    if (binding?.scalarType === 'float_or_percent' && binding.effectiveValue !== null &&
        typeof binding.effectiveValue === 'object')
      setPercentMode(binding.effectiveValue.percent);
  }, [binding?.effectiveValue, binding?.scalarType, effectiveValue, fieldError]);

  const submitSet = useCallback(async (value: string) => {
    if (loading || mutationPending || actionPending.current) return;
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
  }, [field.key, loading, mutationPending, onMutate, snapshot]);
  setValueRef.current = submitSet;

  const submitElementSet = useCallback(async (value: PresetDraftEditorValue) => {
    if (!binding || loading || mutationPending || actionPending.current) return;
    actionPending.current = true;
    setFieldError(null);
    setNullValue(value === null);
    setDisplayValue(inputTextForBinding(value, binding.scalarType));
    if (binding.scalarType === 'float_or_percent' && value !== null && typeof value === 'object')
      setPercentMode(value.percent);
    try {
      const result = await onMutate(makeElementMutationRequest(snapshot, field.key, binding, value));
      if (result.ok) {
        const current = result.editorBindings[field.key];
        if (current) {
          setDisplayValue(inputTextForBinding(current.effectiveValue, current.scalarType));
          setNullValue(current.effectiveValue === null);
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
  }, [binding, field.key, loading, mutationPending, onMutate, snapshot]);
  setElementRef.current = submitElementSet;

  const resetField = async () => {
    if (!overridden || readOnly || loading || mutationPending || actionPending.current) return;
    actionPending.current = true;
    setFieldError(null);
    try {
      const result = await onMutate(makeMutationRequest(snapshot, { action: 'reset-field', key: field.key }));
      if (!result.ok) {
        setFieldError(result.error);
        return;
      }
      const current = result.editorBindings[field.key];
      if (current) {
        const value = current.effectiveValue;
        setDisplayValue(inputTextForBinding(value, current.scalarType));
        setNullValue(value === null);
        setPercentMode(current.scalarType === 'float_or_percent' && value !== null &&
          typeof value === 'object' && value.percent);
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

  // Native colour pickers emit a stream of `input` events followed by one
  // committed `change`. Keep the preview local until that final boundary.
  useEffect(() => {
    const input = colourInput.current;
    if (!input || !colourField || readOnly) return;
    const handleInput = () => {
      setDisplayValue(input.value);
      setFieldError(null);
    };
    const handleChange = () => {
      const next = input.value.toLowerCase();
      if (next === colourInputValue(effectiveValueRef.current).toLowerCase()) return;
      if (binding && boundText) void setElementRef.current(next);
      else void setValueRef.current(next);
    };
    input.addEventListener('input', handleInput);
    input.addEventListener('change', handleChange);
    return () => {
      input.removeEventListener('input', handleInput);
      input.removeEventListener('change', handleChange);
    };
  }, [binding, boundText, colourField, readOnly]);

  const textLike = metadata?.type === 'string' || metadata?.type === 'unknown' || metadata === undefined;
  const numeric = metadata?.type === 'float' || metadata?.type === 'int' || metadata?.type === 'percent' || metadata?.type === 'float_or_percent';
  const freeText = textLike || numeric;
  const boundNumeric = binding?.scalarType === 'float' || binding?.scalarType === 'int' ||
    binding?.scalarType === 'percent' || binding?.scalarType === 'float_or_percent';
  const multiline = field.multiline === true || binding?.multiline === true;
  const controlsDisabled = loading || mutationPending;
  const commitText = () => {
    if (binding) {
      if (binding.scalarType === 'string') {
        if (binding.effectiveValue !== null && displayValue === effectiveValue) return;
        void submitElementSet(displayValue);
        return;
      }
      if (!boundNumeric) return;
      if (!displayValue.trim() && binding.nullable) {
        if (binding.effectiveValue !== null) void submitElementSet(null);
        return;
      }
    }
    const normalized = normalizeScalarInput(displayValue, metadata);
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
    if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
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
  const commitNull = (checked: boolean) => {
    setNullValue(checked);
    setFieldError(null);
    if (checked) void submitElementSet(null);
    else if (binding?.scalarType === 'string' && binding.effectiveValue === null)
      void submitElementSet('');
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
  if (!readOnly && binding?.scalarType === 'bool' && binding.nullable) {
    control = <Select
      value={nullValue ? NULL_ENUM_VALUE : displayValue === 'true' ? 'true' : 'false'}
      onValueChange={(next) => {
        if (next === NULL_ENUM_VALUE) void submitElementSet(null);
        else if (next !== null) void submitElementSet(next === 'true');
      }}
      disabled={controlsDisabled}
    >
      <SelectTrigger id={inputId} aria-label={label} data-testid={`preset-editor-input-${field.key}`} className="w-full">
        <SelectValue>
          {(value) => value === NULL_ENUM_VALUE
            ? 'Not set'
            : value === 'true' ? 'Enabled' : 'Disabled'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NULL_ENUM_VALUE}>Not set</SelectItem>
        <SelectItem value="true">Enabled</SelectItem>
        <SelectItem value="false">Disabled</SelectItem>
      </SelectContent>
    </Select>;
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
      value={nullValue ? NULL_ENUM_VALUE : String(binding.effectiveValue ?? displayValue)}
      onValueChange={(next) => {
        if (next === NULL_ENUM_VALUE) void submitElementSet(null);
        else if (next !== null) void submitElementSet(Number(next));
      }}
      disabled={controlsDisabled}
    >
      <SelectTrigger id={inputId} aria-label={label} data-testid={`preset-editor-input-${field.key}`} className="w-full">
        <SelectValue>
          {(value) => value === NULL_ENUM_VALUE
            ? 'Not set'
            : binding.enumOptions?.find((option) => String(option.value) === String(value))?.label ?? String(value)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {binding.nullable && <SelectItem value={NULL_ENUM_VALUE}>Not set</SelectItem>}
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
        disabled={controlsDisabled || nullValue}
        onFocus={() => { focused.current = true; }}
        onBlur={handleTextBlur}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={handleTextKeyDown}
      />
      {binding.scalarType === 'percent' && <span className="text-xs text-muted-foreground">%</span>}
      {binding.scalarType === 'float_or_percent' && <Select
        value={percentMode ? 'percent' : 'absolute'}
        onValueChange={(next) => {
          if (next === null) return;
          const nextPercent = next === 'percent';
          setPercentMode(nextPercent);
          submitBoundNumber(displayValue, nextPercent);
        }}
        disabled={controlsDisabled || nullValue}
      >
        <SelectTrigger aria-label={`${label} unit`} data-testid={`preset-editor-unit-${field.key}`} className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="absolute">Absolute</SelectItem>
          <SelectItem value="percent">Percent</SelectItem>
        </SelectContent>
      </Select>}
      {binding.nullable && <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Checkbox
          aria-label={`Set ${label} to null`}
          data-testid={`preset-editor-null-${field.key}`}
          checked={nullValue}
          disabled={controlsDisabled}
          onCheckedChange={(checked) => commitNull(checked === true)}
        />
        Null
      </label>}
    </div>;
  } else if (!readOnly && binding && boundText && colourField) {
    control = <div className="flex min-w-0 items-center gap-2">
      <input
        ref={colourInput}
        aria-label={label}
        id={inputId}
        data-testid={`preset-editor-input-${field.key}`}
        type="color"
        value={colourInputValue(displayValue)}
        disabled={controlsDisabled || nullValue}
        onChange={() => undefined}
        className="size-8 cursor-pointer rounded border bg-background p-0.5"
      />
      {binding.nullable && <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Checkbox
          aria-label={`Set ${label} to null`}
          data-testid={`preset-editor-null-${field.key}`}
          checked={nullValue}
          disabled={controlsDisabled}
          onCheckedChange={(checked) => commitNull(checked === true)}
        />
        Null
      </label>}
    </div>;
  } else if (!readOnly && binding && boundText && multiline) {
    control = <div className="flex min-w-0 flex-col gap-2">
      <textarea
        aria-label={label}
        id={inputId}
        data-testid={`preset-editor-input-${field.key}`}
        value={nullValue ? '' : displayValue}
        disabled={controlsDisabled || nullValue}
        onFocus={() => { focused.current = true; }}
        onBlur={handleTextBlur}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={handleTextKeyDown}
        className="min-h-20 w-full min-w-0 rounded-md border border-input bg-input/20 px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-xs/relaxed dark:bg-input/30"
      />
      {binding.nullable && <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Checkbox
          aria-label={`Set ${label} to null`}
          data-testid={`preset-editor-null-${field.key}`}
          checked={nullValue}
          disabled={controlsDisabled}
          onCheckedChange={(checked) => commitNull(checked === true)}
        />
        Null
      </label>}
    </div>;
  } else if (!readOnly && binding && boundText) {
    control = <div className="flex min-w-0 items-center gap-2">
      <Input
        aria-label={label}
        id={inputId}
        data-testid={`preset-editor-input-${field.key}`}
        type="text"
        value={nullValue ? '' : displayValue}
        disabled={controlsDisabled || nullValue}
        onFocus={() => { focused.current = true; }}
        onBlur={handleTextBlur}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={handleTextKeyDown}
      />
      {binding.nullable && <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Checkbox
          aria-label={`Set ${label} to null`}
          data-testid={`preset-editor-null-${field.key}`}
          checked={nullValue}
          disabled={controlsDisabled}
          onCheckedChange={(checked) => commitNull(checked === true)}
        />
        Null
      </label>}
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
      value={displayValue}
      onValueChange={(next) => { if (next !== null) void submitSet(next); }}
      disabled={controlsDisabled}
    >
      <SelectTrigger id={inputId} aria-label={label} data-testid={`preset-editor-input-${field.key}`} className="w-full">
        <SelectValue placeholder={displayValue} />
      </SelectTrigger>
      <SelectContent>
        {metadata.enum_values.map((value, index) => <SelectItem key={value} value={value}>
          {metadata.enum_labels?.[index] ?? value}
        </SelectItem>)}
      </SelectContent>
    </Select>;
  } else if (!readOnly && colourField) {
    control = <input
      ref={colourInput}
      aria-label={label}
      id={inputId}
      data-testid={`preset-editor-input-${field.key}`}
      type="color"
      value={colourInputValue(displayValue)}
      disabled={controlsDisabled}
      onChange={() => undefined}
      className="size-8 cursor-pointer rounded border bg-background p-0.5"
    />;
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
      data-testid={`preset-editor-field-${field.key}`}
      data-field-key={field.key}
      data-field-access={field.access}
      data-native-type={metadata?.type ?? 'unknown'}
      data-native-scalar-type={binding?.scalarType}
      data-native-min={metadata?.min}
      data-native-max={metadata?.max}
      aria-disabled={readOnly || undefined}
      title={tooltip}
      className="min-w-0 rounded-md border bg-background/70 px-3 py-2"
    >
      {titleContext}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <Label
            data-testid={`preset-editor-option-label-${field.key}`}
            data-draft-override-highlight={overridden ? 'true' : 'false'}
            className={cn('block truncate text-sm font-medium', overridden && 'config-override-label')}
            title={label}
          >{label}</Label>
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
          disabled={controlsDisabled}
          onClick={() => void resetField()}
        >Reset</Button>}
      </div>
      {readOnly && readOnlyReason && <p className="mt-1 text-[0.7rem] text-muted-foreground">{readOnlyReason}</p>}
      {readOnly ? (
        <dl className="mt-2 grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Source</dt>
          <dd data-testid={`preset-editor-source-${field.key}`} className="break-all">{sourceValue}</dd>
          <dt className="text-muted-foreground">Effective</dt>
          <dd data-testid={`preset-editor-effective-${field.key}`} className="break-all">{binding ? projectedValueText(binding.effectiveValue, binding.scalarType) : valueText(snapshot.effectiveValues, field.key)}</dd>
        </dl>
      ) : (
        <div className="mt-2 grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs">
          <Label className="text-muted-foreground" htmlFor={inputId}>Value</Label>
          <div className="min-w-0" data-testid={`preset-editor-control-${field.key}`}>{control}</div>
          <span className="text-muted-foreground">Source</span>
          <span data-testid={`preset-editor-source-${field.key}`} className="break-all">{sourceValue}</span>
          <span className="text-muted-foreground">Effective</span>
          <span data-testid={`preset-editor-effective-${field.key}`} className="break-all">{binding ? projectedValueText(binding.effectiveValue, binding.scalarType) : valueText(snapshot.effectiveValues, field.key)}</span>
        </div>
      )}
      {fieldError && <p role="alert" data-testid={`preset-editor-error-${field.key}`} className="mt-2 text-xs text-destructive">{fieldError}</p>}
    </article>
  );
}

function FieldGroup({
  page,
  group,
  snapshot,
  loading,
  mutationPending,
  onMutate,
}: {
  page: PresetEditorManifestPage;
  group: PresetEditorManifestGroup;
  snapshot: PresetDraftSnapshot;
  loading: boolean;
  mutationPending: boolean;
  onMutate: PresetEditorDialogProps['onMutate'];
}) {
  const titleId = `preset-editor-group-title-${page.id}-${group.id}`;
  const overridden = groupHasOverrides(snapshot, group);
  return (
    <section
      data-testid={`preset-editor-group-${page.id}-${group.id}`}
      aria-labelledby={titleId}
      className="min-w-0 space-y-2"
    >
      <h3
        id={titleId}
        data-testid={`preset-editor-group-title-${page.id}-${group.id}`}
        data-draft-override-highlight={overridden ? 'true' : 'false'}
        className={cn('text-sm font-semibold', overridden && 'config-override-label')}
      >{group.title}</h3>
      <div className="grid min-w-0 gap-2 xl:grid-cols-2">
        {group.fields.map((field) => <FieldValue
          key={field.key}
          field={field}
          metadata={snapshot.optionMetadata[field.key]}
          snapshot={snapshot}
          page={page}
          group={group}
          loading={loading}
          mutationPending={mutationPending}
          onMutate={onMutate}
        />)}
      </div>
    </section>
  );
}

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

export function PresetEditorDialog({
  target,
  snapshot,
  refreshing = false,
  loading = false,
  loadError = null,
  mutationPending = false,
  referencedFilamentSlots = [],
  onClose,
  onMutate,
}: PresetEditorDialogProps) {
  const interactionPending = loading || refreshing || mutationPending;
  const manifest = target ? manifestFor(target.kind) : null;
  const pages = useMemo(() => manifest ? pageInstances(manifest, snapshot) : [], [manifest, snapshot]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const targetKey = target ? `${target.kind}:${target.canonicalName}` : '';

  useEffect(() => {
    setActivePageId(null);
    setSearch('');
    setActionError(null);
  }, [targetKey]);

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
  // Layout-only manifest entries (for example the synthesized extruder count)
  // do not exist in a native preset. Reset only declared native fields, while
  // retaining read-only native fields in the atomic category request.
  const activePageResetKeys = snapshot === null ? [] : [...new Set(activePageKeys.filter((key) =>
    Object.prototype.hasOwnProperty.call(snapshot.sourceValues, key) ||
    Object.prototype.hasOwnProperty.call(snapshot.effectiveValues, key)))];
  const categoryHasOverrides = snapshot !== null && activePageResetKeys.some((key) => hasOverride(snapshot, key));
  const showSearchResults = query.length > 0;

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open && target && !mutationPending) onClose(); }}>
      {target && manifest && <DialogContent
        data-testid="preset-editor-dialog"
        className="flex max-h-[88vh] w-[min(94vw,72rem)] max-w-none flex-col gap-4 overflow-hidden p-5"
      >
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <DialogTitle id="preset-editor-title" data-testid="preset-editor-title" className="truncate text-lg">
              {target.canonicalName}
            </DialogTitle>
            <DialogDescription className="mt-1">
              {target.kind === 'printer' ? 'Printer preset' : 'Filament preset'}
            </DialogDescription>
            {target.kind === 'filament' && <p
              data-testid="preset-editor-slot-reference"
              className="mt-1 text-xs text-muted-foreground"
            >{referencedSlotsLabel(referencedFilamentSlots)}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <Input
            type="search"
            aria-label={`Search ${target.kind} preset settings`}
            data-testid="preset-editor-search"
            placeholder="Search by name, key, or help text"
            value={search}
            disabled={loading || refreshing || !snapshot}
            onChange={(event) => setSearch(event.currentTarget.value)}
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

          {actionError && <p role="alert" data-testid="preset-editor-action-error" className="text-xs text-destructive">{actionError}</p>}

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {loadError ? (
              <p role="alert" data-testid="preset-editor-load-error" className="py-4 text-sm text-destructive">{loadError}</p>
            ) : loading || !snapshot ? (
              <p data-testid="preset-editor-loading" className="py-4 text-sm text-muted-foreground">Loading preset settings…</p>
            ) : showSearchResults ? (
              <div data-testid="preset-editor-search-results" className="space-y-3">
                {searchResults.length === 0
                  ? <p className="py-4 text-sm text-muted-foreground">No matching settings.</p>
                  : searchResults.map(({ page, group, field }) => <FieldValue
                    key={`${page.id}:${group.id}:${field.key}`}
                    field={field}
                    metadata={snapshot.optionMetadata[field.key]}
                    snapshot={snapshot}
                    page={page}
                    group={group}
                    loading={interactionPending}
                    mutationPending={mutationPending}
                    onMutate={onMutate}
                  />)}
              </div>
            ) : activePage ? (
              <div
                id={`preset-editor-page-${activePage.id}`}
                role="tabpanel"
                aria-labelledby={`preset-editor-tab-${activePage.id}`}
                data-testid={`preset-editor-page-${activePage.id}`}
                className="space-y-5 pb-1"
              >
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    data-testid={`preset-editor-reset-category-${activePage.id}`}
                    disabled={!categoryHasOverrides || interactionPending}
                    onClick={() => void submitAction({ action: 'reset-category', keys: activePageResetKeys })}
                  >Reset category</Button>
                </div>
                {activePage.groups.map((optionGroup) => <FieldGroup
                  key={optionGroup.id}
                  page={activePage}
                  group={optionGroup}
                  snapshot={snapshot}
                  loading={interactionPending}
                  mutationPending={mutationPending}
                  onMutate={onMutate}
                />)}
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>}
    </Dialog>
  );
}
