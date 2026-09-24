import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  OptionMeta,
  PresetDraftMutationRequest,
  PresetDraftMutationResult,
  PresetDraftSnapshot,
  PresetDraftTarget,
} from '@slicer/client';
import { errorText } from '@orca/slicer-runtime';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
  const serialized = snapshot.effectiveValues.nozzle_diameter ?? snapshot.sourceValues.nozzle_diameter;
  if (!serialized) return null;
  const diameters = serialized.split(',');
  if (diameters.some((diameter) => {
    const value = Number(diameter.trim());
    return !Number.isFinite(value) || value <= 0;
  })) return null;
  return diameters.length;
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
    'floats', 'ints', 'strings', 'bools', 'point', 'points', 'point3', 'unknown',
  ].includes(metadata.type);
}

/**
 * Keep scalar validation at the editor boundary. Native metadata is the
 * declared UI constraint, while the Worker remains responsible for accepting
 * the already-normalized configuration value. `Number()` deliberately rejects
 * the partial values that C++ deserialization would otherwise truncate.
 */
function normalizeScalarInput(value: string, metadata: OptionMeta | undefined): string | null {
  if (metadata?.type !== 'float' && metadata?.type !== 'int') return value;
  const text = value.trim();
  const valid = metadata.type === 'int'
    ? /^[+-]?\d+$/.test(text)
    : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text);
  if (!valid) return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed) || (metadata.type === 'int' && !Number.isSafeInteger(parsed))) return null;
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
  const sourceValue = valueText(snapshot.sourceValues, field.key);
  const effectiveValue = snapshot.effectiveValues[field.key] ?? metadata?.default ?? '';
  const colourField = isColourField(field, metadata);
  const unsupportedStructured = isStructuredValue(metadata) && !colourField;
  const readOnly = field.access === 'read-only' || unsupportedStructured;
  const readOnlyReason = field.readOnlyReason ?? (unsupportedStructured
    ? 'This value needs a specialized editor.'
    : undefined);
  const overridden = hasOverride(snapshot, field.key);
  const [displayValue, setDisplayValue] = useState(effectiveValue);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const focused = useRef(false);
  const cancelBlur = useRef(false);
  const actionPending = useRef(false);
  const colourInput = useRef<HTMLInputElement>(null);
  const effectiveValueRef = useRef(effectiveValue);
  const setValueRef = useRef<(value: string) => Promise<void>>(async () => undefined);
  effectiveValueRef.current = effectiveValue;

  const inputId = `preset-editor-input-${page?.id ?? 'field'}-${group?.id ?? 'group'}-${field.key}`;

  useEffect(() => {
    if (!focused.current && fieldError === null) setDisplayValue(effectiveValue);
  }, [effectiveValue, fieldError]);

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

  const resetField = async () => {
    if (!overridden || readOnly || loading || mutationPending || actionPending.current) return;
    actionPending.current = true;
    setFieldError(null);
    try {
      const result = await onMutate(makeMutationRequest(snapshot, { action: 'reset-field', key: field.key }));
      if (result.ok) setDisplayValue(result.effectiveValues[field.key] ?? result.sourceValues[field.key] ?? '');
      else setFieldError(result.error);
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
      void setValueRef.current(next);
    };
    input.addEventListener('input', handleInput);
    input.addEventListener('change', handleChange);
    return () => {
      input.removeEventListener('input', handleInput);
      input.removeEventListener('change', handleChange);
    };
  }, [colourField, readOnly]);

  const textLike = metadata?.type === 'string' || metadata?.type === 'unknown' || metadata === undefined;
  const numeric = metadata?.type === 'float' || metadata?.type === 'int';
  const freeText = textLike || numeric || metadata?.type === 'percent' || metadata?.type === 'float_or_percent';
  const controlsDisabled = loading || mutationPending;
  const commitText = () => {
    const normalized = normalizeScalarInput(displayValue, metadata);
    if (normalized === null) {
      setFieldError('Enter a valid number.');
      return;
    }
    if (normalized !== displayValue) setDisplayValue(normalized);
    if (normalized !== effectiveValue) void submitSet(normalized);
  };
  const titleContext = page && group && (
    <p className="mb-1 text-[0.7rem] text-muted-foreground" data-testid={`preset-editor-context-${field.key}`}>
      {page.title} / {group.title}
    </p>
  );

  let control = null;
  if (!readOnly && metadata?.type === 'bool') {
    control = <Checkbox
      aria-label={label}
      id={inputId}
      data-testid={`preset-editor-input-${field.key}`}
      checked={displayValue === '1' || displayValue.toLocaleLowerCase() === 'true'}
      disabled={controlsDisabled}
      onCheckedChange={(checked) => { void submitSet(checked ? '1' : '0'); }}
    />;
  } else if (!readOnly && metadata?.type === 'enum' && metadata.enum_values?.length) {
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
  } else if (!readOnly && freeText) {
    control = <Input
      aria-label={label}
      id={inputId}
      data-testid={`preset-editor-input-${field.key}`}
      type="text"
      inputMode={numeric ? 'decimal' : 'text'}
      value={displayValue}
      disabled={controlsDisabled}
      onFocus={() => { focused.current = true; }}
      onBlur={() => {
        focused.current = false;
        if (cancelBlur.current) {
          cancelBlur.current = false;
          return;
        }
        if (displayValue !== effectiveValue) commitText();
      }}
      onChange={(event) => {
        setDisplayValue(event.currentTarget.value);
        setFieldError(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          focused.current = false;
          cancelBlur.current = true;
          setDisplayValue(effectiveValue);
          setFieldError(null);
          event.currentTarget.blur();
        }
      }}
    />;
  }

  return (
    <article
      data-testid={`preset-editor-field-${field.key}`}
      data-field-key={field.key}
      data-field-access={field.access}
      data-native-type={metadata?.type ?? 'unknown'}
      data-native-min={metadata?.min}
      data-native-max={metadata?.max}
      aria-disabled={readOnly || undefined}
      title={tooltip}
      className="min-w-0 rounded-md border bg-background/70 px-3 py-2"
    >
      {titleContext}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <Label className="block truncate text-sm font-medium" title={label}>{label}</Label>
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
          <dd data-testid={`preset-editor-effective-${field.key}`} className="break-all">{valueText(snapshot.effectiveValues, field.key)}</dd>
        </dl>
      ) : (
        <div className="mt-2 grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs">
          <Label className="text-muted-foreground" htmlFor={inputId}>Value</Label>
          <div className="min-w-0" data-testid={`preset-editor-control-${field.key}`}>{control}</div>
          <span className="text-muted-foreground">Source</span>
          <span data-testid={`preset-editor-source-${field.key}`} className="break-all">{sourceValue}</span>
          <span className="text-muted-foreground">Effective</span>
          <span data-testid={`preset-editor-effective-${field.key}`} className="break-all">{valueText(snapshot.effectiveValues, field.key)}</span>
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
  return (
    <section
      data-testid={`preset-editor-group-${page.id}-${group.id}`}
      aria-labelledby={titleId}
      className="min-w-0 space-y-2"
    >
      <h3 id={titleId} className="text-sm font-semibold">{group.title}</h3>
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
  loading = false,
  loadError = null,
  mutationPending = false,
  referencedFilamentSlots = [],
  onClose,
  onMutate,
}: PresetEditorDialogProps) {
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
    if (!snapshot || loading || mutationPending) return;
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
              disabled={loading || mutationPending || !snapshot?.draftExists}
              onClick={() => void submitAction({ action: 'reset-preset' })}
            >Reset preset</Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <Input
            type="search"
            aria-label={`Search ${target.kind} preset settings`}
            data-testid="preset-editor-search"
            placeholder="Search by name, key, or help text"
            value={search}
            disabled={loading || !snapshot}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />

          {!showSearchResults && <div role="tablist" aria-label="Preset setting pages" className="flex shrink-0 gap-1 overflow-x-auto border-b">
            {pages.map((page) => <button
              key={page.id}
              id={`preset-editor-tab-${page.id}`}
              type="button"
              role="tab"
              aria-selected={activePage?.id === page.id}
              aria-controls={`preset-editor-page-${page.id}`}
              data-testid={`preset-editor-page-tab-${page.id}`}
              disabled={loading || !snapshot}
              onClick={() => { setActivePageId(page.id); setSearch(''); setActionError(null); }}
              className="shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground aria-selected:border-primary aria-selected:text-foreground"
            >{page.title}</button>)}
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
                    loading={loading}
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
                    disabled={!categoryHasOverrides || loading || mutationPending}
                    onClick={() => void submitAction({ action: 'reset-category', keys: activePageResetKeys })}
                  >Reset category</Button>
                </div>
                {activePage.groups.map((optionGroup) => <FieldGroup
                  key={optionGroup.id}
                  page={activePage}
                  group={optionGroup}
                  snapshot={snapshot}
                  loading={loading}
                  mutationPending={mutationPending}
                  onMutate={onMutate}
                />)}
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={mutationPending} data-testid="preset-editor-close">Close</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  );
}
