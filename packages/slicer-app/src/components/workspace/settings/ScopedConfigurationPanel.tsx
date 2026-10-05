import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type {
  NativeScopedConfigMutationRequest,
  NativeScopedConfigTarget,
  OptionMeta,
} from '@slicer/client';
import { usePlatform } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TooltipFor } from '@/components/ui/tooltip';
import { cn } from 'cn';
import { ChevronDown, ChevronRight, Minus, Plus, RotateCcw, Search } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { printSettingsPages, printSettingPlacement, isVisiblePrintSetting, printSettingsGroups } from './printSettingsLayout';
import { optionTooltip } from './optionTooltip';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { commitScopedConfigurationMutation, invalidateAfterSharedConfigurationMutation } from './configurationActions';
import {
  localKeysForTarget,
  projectScopedConfigurationFields,
  resolveScopedConfigurationTarget,
  type ScopedConfigurationField,
  type ScopedConfigurationTarget,
  type ScopedTargetResolution,
} from './scopedConfigurationProjection';

const SOURCE_LABEL: Record<string, string> = {
  preset: 'Preset', project: 'Project', plate: 'Plate', object: 'Object', part: 'Volume', mixed: 'Mixed',
};

const PROJECT_RESOLUTION: ScopedTargetResolution = {
  scope: 'project', targets: [{ scope: 'project', label: 'Project' }],
  label: 'Project', visibleScopes: ['preset', 'project'],
};

function targetRequestTargets(targets: readonly ScopedConfigurationTarget[]): NativeScopedConfigTarget[] {
  return targets.map(({ scope, id }) => ({ scope, ...(id === undefined ? {} : { id }) }));
}

function valueForField(field: ScopedConfigurationField): string {
  return field.mixed ? '' : field.value ?? '';
}

function isScalar(meta: OptionMeta): boolean {
  return meta.type === 'float' || meta.type === 'int';
}

function valueTooltip(field: ScopedConfigurationField): string {
  if (field.mixed) return 'The selected targets have different effective values or sources.';
  return `Effective value source: ${SOURCE_LABEL[field.source] ?? field.source}.`;
}

export const ScopedField = memo(function ScopedField({
  field,
  targets,
  onCommit,
  onReset,
}: {
  field: ScopedConfigurationField;
  targets: readonly ScopedConfigurationTarget[];
  onCommit: (field: ScopedConfigurationField, value: string) => Promise<string>;
  onReset: (field: ScopedConfigurationField) => Promise<void>;
}) {
  const initial = valueForField(field);
  const [draft, setDraft] = useState(initial);
  const committing = useRef(false);
  const [commitPending, setCommitPending] = useState(false);
  const cancelBlur = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const signature = `${targets.map((target) => `${target.scope}:${target.id ?? ''}`).join(',')}|${field.source}|${field.mixed ? 'mixed' : field.value ?? ''}`;
  const signatureRef = useRef(signature);
  useEffect(() => {
    if (signatureRef.current === signature) return;
    signatureRef.current = signature;
    setDraft(initial);
  }, [initial, signature]);
  const commit = async (value: string) => {
    if (committing.current) return;
    committing.current = true;
    setCommitPending(true);
    const submittedSignature = signatureRef.current;
    try {
      const effective = await onCommit(field, value);
      if (signatureRef.current === submittedSignature) setDraft(effective);
      setError(null);
    } catch (reason) {
      if (signatureRef.current === submittedSignature)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      committing.current = false;
      setCommitPending(false);
    }
  };
  const onDiscrete = (value: string) => { setDraft(value); void commit(value); };
  const reset = () => { void onReset(field).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); };
  const label = field.label;
  const row = 'grid grid-cols-[minmax(0,1fr)_minmax(0,40%)] items-center gap-2 px-1 py-0.5 min-h-7';
  const labelCls = 'min-w-0 flex-1 truncate text-[13px] font-normal text-muted-foreground';
  const displayed = draft;
  const canStep = isScalar(field.meta) || field.meta.type === 'percent' || field.meta.type === 'float_or_percent';
  const step = field.meta.type === 'float' || field.meta.type === 'float_or_percent' ? 0.1 : 1;
  const numericDraft = /^-?(?:\d+\.?\d*|\.\d+)%?$/.test(draft.trim()) ? Number.parseFloat(draft) : NaN;
  const adjust = (direction: number) => {
    if (!/^-?(?:\d+\.?\d*|\.\d+)%?$/.test(draft.trim())) return;
    const number = Number.parseFloat(draft);
    const next = Math.max(field.meta.min ?? -Infinity, Math.min(field.meta.max ?? Infinity, Number((number + direction * step).toFixed(6))));
    onDiscrete(`${next}${draft.trim().endsWith('%') ? '%' : ''}`);
  };
  const hasEditableLocalOverride = field.local && field.resettable;
  const tooltip = valueTooltip(field);

  let control;
  if (field.meta.type === 'bool' && !field.mixed) {
    control = <TooltipFor content={tooltip}><Checkbox
      id={`scoped-${field.key}`}
      className="size-5 after:inset-0"
      checked={displayed === '1'}
      onCheckedChange={(checked) => onDiscrete(checked ? '1' : '0')}
    /></TooltipFor>;
  } else if (field.meta.type === 'enum' && field.meta.enum_values?.length && !field.mixed) {
    const selectedIndex = field.meta.enum_values.indexOf(displayed);
    const selectedLabel = field.meta.enum_labels?.[selectedIndex] ?? displayed;
    control = <Select value={displayed} onValueChange={(value) => value != null && onDiscrete(value)}>
      <TooltipFor content={tooltip}>
        <SelectTrigger variant="sidebar" id={`scoped-${field.key}`} size="sm" className="w-full" data-testid={`config-input-${field.key}`}><SelectValue>{selectedLabel}</SelectValue></SelectTrigger>
      </TooltipFor>
      <SelectContent>{field.meta.enum_values.map((value, index) => <SelectItem key={value} value={value}>{field.meta.enum_labels?.[index] ?? value}</SelectItem>)}</SelectContent>
    </Select>;
  } else {
    control = <div className="flex h-6 min-w-0 items-center rounded-sm bg-control-background focus-within:ring-1 focus-within:ring-ring"><TooltipFor content={tooltip}><Input
        id={`scoped-${field.key}`}
        data-testid={`config-input-${field.key}`}
        value={displayed}
        placeholder={field.mixed ? 'Mixed' : undefined}
        min={field.meta.min}
        max={field.meta.max}
        type={isScalar(field.meta) ? 'number' : 'text'}
        step={field.meta.type === 'int' ? 1 : 'any'}
        onBlur={() => {
          if (cancelBlur.current) { cancelBlur.current = false; return; }
          if (draft !== valueForField(field)) void commit(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); if (draft !== valueForField(field)) void commit(draft); }
          if (event.key === 'Escape') { event.preventDefault(); cancelBlur.current = true; setDraft(valueForField(field)); setError(null); event.currentTarget.blur(); }
        }}
        onChange={(event) => setDraft(event.target.value)}
        className="h-6 min-w-0 flex-1 rounded-sm border-0 bg-transparent dark:bg-transparent px-1.5 text-[13px] focus-visible:ring-0 md:text-[13px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      /></TooltipFor>
      {canStep && <div className="flex shrink-0 gap-px pr-0.5">
        <Button type="button" variant="number-stepper" size="icon-xs" className="size-[18px] rounded-l-[2px] rounded-r-none [&>svg]:size-3"
          aria-label={`Decrease ${field.label}`} disabled={commitPending || field.mixed || numericDraft <= (field.meta.min ?? -Infinity)} onClick={() => adjust(-1)}><Minus /></Button>
        <Button type="button" variant="number-stepper" size="icon-xs" className="size-[18px] rounded-l-none rounded-r-[2px] [&>svg]:size-3"
          aria-label={`Increase ${field.label}`} disabled={commitPending || field.mixed || numericDraft >= (field.meta.max ?? Infinity)} onClick={() => adjust(1)}><Plus /></Button>
      </div>}
      </div>;
  }
  return (
    <div data-testid={`config-field-${field.key}`} className="space-y-0.5">
      <div className={row}>
        <div className="flex min-w-0 items-center gap-1">
        <TooltipFor content={<span className="whitespace-pre-line">{optionTooltip(field.meta, field.label)}</span>}>
          <Label
            htmlFor={`scoped-${field.key}`}
            data-testid={`config-option-label-${field.key}`}
            data-local-override-highlight={hasEditableLocalOverride ? 'true' : 'false'}
            className={cn(labelCls, hasEditableLocalOverride && 'config-override-label')}
          >{label}</Label>
        </TooltipFor>
        {field.local && field.resettable && <TooltipFor content="Reset this local override"><Button
          type="button" variant="ghost" size="icon-xs" className="size-4 shrink-0 text-config-override [&>svg]:size-3"
          aria-label={`Reset ${field.label}`} data-testid={`config-reset-${field.key}`} onClick={reset}><RotateCcw /></Button></TooltipFor>}
        </div>
        <div className="min-w-0">
          {field.mixed && <span data-testid={`config-mixed-${field.key}`} className="sr-only">Mixed</span>}
          {control}
        </div>
      </div>
      {error && <div role="alert" data-testid={`config-error-${field.key}`} className="text-[0.65rem] text-destructive">{error}</div>}
    </div>
  );
}, (previous, next) => previous.targets === next.targets
  && previous.onCommit === next.onCommit && previous.onReset === next.onReset
  && (Object.keys(previous.field) as Array<keyof ScopedConfigurationField>)
    .every((key) => previous.field[key] === next.field[key]));

// Fixed options budget includes expanded search even when filtering hides rows.
// Catalogue content that exceeds the budget scrolls independently.
const PLATE_OPTIONS_SECTION_HEIGHT = 170;

export function ScopedConfigurationPanel({ sceneInteraction, projectContent, scopedContent, platesContent, platesToolbar }: {
  sceneInteraction: SceneInteractionController | null;
  projectContent?: ReactNode;
  scopedContent?: ReactNode;
  platesContent?: ReactNode;
  platesToolbar?: ReactNode;
}) {
  const platform = usePlatform();
  const mode = useSettingsStore((state) => state.configurationMode);
  const selection = sceneInteraction?.selection;
  const subscribeSelection = useCallback(
    (listener: () => void) => mode === 'scoped' ? selection?.subscribe(listener) ?? (() => {}) : () => {},
    [mode, selection],
  );
  const selectionRevision = useSyncExternalStore(subscribeSelection, () => mode === 'scoped' ? selection?.revision ?? 0 : 0);
  const metadata = useSettingsStore((state) => state.metadata);
  const baseValues = useSettingsStore((state) => state.baseValues);
  const snapshot = useSettingsStore((state) => state.nativeScopedConfig);
  const setConfigurationMode = useSettingsStore((state) => state.setConfigurationMode);
  const structure = useObjectListStore((state) => mode === 'scoped' ? state.structure : undefined);
  const activePlateId = usePlateSessionStore((state) => mode !== 'project' ? state.snapshot?.currentPlateId : undefined);
  const activePlateLabel = usePlateSessionStore((state) => mode !== 'project'
    ? state.snapshot?.plates.find((plate) => plate.plateId === state.snapshot?.currentPlateId)?.name : undefined);
  const setError = useSlicerStore((state) => state.setError);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activePages, setActivePages] = useState<Partial<Record<typeof mode, string>>>({});
  const activePage = activePages[mode];
  const setActivePage = (page: string) => setActivePages((current) => ({ ...current, [mode]: page }));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const panelRef = useRef<HTMLElement>(null);
  const objectListRef = useRef<HTMLDivElement>(null);
  const plateListRef = useRef<HTMLDivElement>(null);
  const [listMaxHeight, setListMaxHeight] = useState(0);
  const [plateOptionsMaxHeight, setPlateOptionsMaxHeight] = useState<number>();
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const list = mode === 'scoped' ? objectListRef.current : mode === 'plates' ? plateListRef.current : null;
    if (!panel || !list) return;
    const measure = () => {
      const bounds = panel.getBoundingClientRect();
      if (mode === 'plates') {
        // The shared scrolling budget starts below the title and plate toolbar.
        const available = Math.max(0, bounds.bottom - list.getBoundingClientRect().top);
        const optionsHeight = Math.min(PLATE_OPTIONS_SECTION_HEIGHT, available / 2);
        setPlateOptionsMaxHeight(available / 2);
        // The list keeps its natural height until it reaches this scroll limit.
        // The list includes its padding above the divider; reserve the 4px section gap.
        setListMaxHeight(Math.max(0, available - optionsHeight - 4));
        return;
      }
      // Include the scope header and spacing in the upper half's budget.
      const listTop = list.getBoundingClientRect().top - bounds.top;
      setListMaxHeight(Math.max(0, Math.floor(bounds.height / 2 - listTop)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(list);
    if (panel.firstElementChild) observer.observe(panel.firstElementChild);
    return () => observer.disconnect();
  }, [mode]);
  const optionsScrollRef = useRef<HTMLDivElement>(null);
  const optionsContentRef = useRef<HTMLDivElement>(null);
  const [optionsOverflowing, setOptionsOverflowing] = useState(false);
  useLayoutEffect(() => {
    const scroll = optionsScrollRef.current;
    const content = optionsContentRef.current;
    if (!scroll || !content) return;
    const updateOverflow = () => setOptionsOverflowing(scroll.scrollHeight > scroll.clientHeight);
    updateOverflow();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateOverflow);
    // Track both panel resizing and changes in the visible option catalogue.
    observer.observe(scroll);
    observer.observe(content);
    return () => observer.disconnect();
  }, [mode]);

  const resolution = useMemo(() => mode === 'project' ? PROJECT_RESOLUTION : resolveScopedConfigurationTarget({
    selectionKind: mode === 'plates' ? 'empty' : sceneInteraction?.computeSelectionKind() ?? 'empty',
    selectedVolumes: mode === 'plates' ? [] : (sceneInteraction?.selectedVolumes() ?? []).map((volume) => ({ objectId: volume.buffer.objectId, volumeId: volume.buffer.volumeId })),
    activePlateId: activePlateId ?? null,
    activePlateLabel,
    structure: structure ?? [],
    wipeTowerSelected: mode === 'plates' ? false : sceneInteraction?.hasWipeTowerSelection,
    allowPlateTarget: mode === 'plates',
  }), [mode, activePlateId, activePlateLabel, sceneInteraction, selectionRevision, structure]);
  // Reset actions operate on the whole selected category/catalogue, not just
  // the subset currently visible through the search query.
  const allFields = useMemo(() => metadata
    ? projectScopedConfigurationFields({ mode, metadata, baseValues, snapshot, resolution, search: '' }).filter((field) => isVisiblePrintSetting(field, mode))
    : [], [baseValues, metadata, mode, resolution, snapshot]);
  const availablePages = useMemo(() => printSettingsPages(mode).filter((page) =>
    page.groups.some((group) => group.keys.some((key) => allFields.some((field) => field.key === key)))), [allFields, mode]);
  const selectedPage = availablePages.some((page) => page.title === activePage) ? activePage : availablePages[0]?.title;
  const categories = useMemo(() => printSettingsGroups(allFields, selectedPage, search, mode), [allFields, search, selectedPage, mode]);
  const highlightedCategories = useMemo(() => new Set(allFields
    .filter((field) => field.local && field.resettable)
    .map((field) => field.category)), [allFields]);
  const hasLocalOverrides = highlightedCategories.size > 0;

  const commitField = useCallback(async (field: ScopedConfigurationField, value: string) => {
    if (mode !== 'project' && resolution.scope === 'invalid') throw new Error(resolution.disabledReason ?? 'no scoped configuration target');
    const request: NativeScopedConfigMutationRequest = {
      version: 1, operation: 'set', targets: targetRequestTargets(mode === 'project'
        ? [{ scope: 'project', label: 'Project' }]
        : resolution.targets), key: field.key, value,
    };
    const mutation = await commitScopedConfigurationMutation(platform, request);
    if (mutation) invalidateAfterSharedConfigurationMutation(mutation.affectedPlateIds);
    const current = useSettingsStore.getState();
    const effective = projectScopedConfigurationFields({ mode, metadata: metadata!,
      baseValues: current.baseValues, snapshot: current.nativeScopedConfig, resolution })
      .find((candidate) => candidate.key === field.key);
    return effective ? valueForField(effective) : value;
  }, [metadata, mode, platform, resolution]);
  const resetField = useCallback(async (field: ScopedConfigurationField) => {
    if ((mode !== 'project' && resolution.scope === 'invalid') || !field.local) return;
    const request: NativeScopedConfigMutationRequest = {
      version: 1, operation: 'reset', targets: targetRequestTargets(mode === 'project'
        ? [{ scope: 'project', label: 'Project' }]
        : resolution.targets), key: field.key,
    };
    const mutation = await commitScopedConfigurationMutation(platform, request);
    if (mutation) invalidateAfterSharedConfigurationMutation(mutation.affectedPlateIds);
  }, [mode, platform, resolution]);
  const resetCategory = async (category: string) => {
    if (mode !== 'project' && resolution.scope === 'invalid') return;
    const candidates = allFields.filter((field) => field.category === category && field.local);
    if (candidates.length === 0) return;
    const request: NativeScopedConfigMutationRequest = {
      version: 1, operation: 'reset-category', targets: targetRequestTargets(mode === 'project'
        ? [{ scope: 'project', label: 'Project' }]
        : resolution.targets), category,
    };
    try {
      const mutation = await commitScopedConfigurationMutation(platform, request);
      if (mutation) invalidateAfterSharedConfigurationMutation(mutation.affectedPlateIds);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const resetAll = async () => {
    if (mode !== 'project' && resolution.scope === 'invalid') return;
    const targets = mode === 'project' ? [{ scope: 'project', label: 'Project' } as const] : resolution.targets;
    const hasLocal = targets.some((target) => localKeysForTarget(snapshot, target).some((key) => allFields.some((field) => field.key === key && field.resettable)));
    if (!hasLocal) return;
    const request: NativeScopedConfigMutationRequest = { version: 1, operation: 'reset-all', targets: targetRequestTargets(targets) };
    try {
      const mutation = await commitScopedConfigurationMutation(platform, request);
      if (mutation) invalidateAfterSharedConfigurationMutation(mutation.affectedPlateIds);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const optionsHeader = <div className={cn('shrink-0 space-y-1', mode === 'plates' && 'px-2')}>
        <div className="flex min-w-0 items-center gap-1">
          <TooltipFor content="Reset all local overrides"><Button type="button" variant="ghost" size="icon-xs"
            className="size-5 shrink-0 text-config-override [&>svg]:size-3" aria-label="Reset All" data-testid="config-reset-all"
            disabled={!hasLocalOverrides || (mode !== 'project' && resolution.scope === 'invalid')} onClick={() => void resetAll()}><RotateCcw /></Button></TooltipFor>
          {mode === 'project' ? <div className={cn("min-w-0 flex-1", hasLocalOverrides && "[&_button[data-slot=combobox-trigger]]:text-config-override")}>{projectContent}</div> :
            <span data-testid="scoped-target-label" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{resolution.label}</span>}
          {mode === 'project' && <span data-testid="scoped-target-label" className="sr-only">Project</span>}
          <TooltipFor content="Search settings"><Button type="button" variant="ghost" size="icon-xs" className="size-6 shrink-0 rounded-sm bg-control-background text-input-button-foreground hover:text-muted-foreground aria-expanded:bg-control-background aria-expanded:text-input-button-foreground"
            aria-label="Search settings" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setSearch(''); }}><Search /></Button></TooltipFor>
        </div>
        {searchOpen && <SearchInput autoFocus data-testid="scoped-config-search" value={search} onValueChange={setSearch}
          placeholder="Search settings…" className="h-6 rounded-sm border-0 bg-control-background" />}
        {!search.trim() && availablePages.length > 1 && <div role="tablist" aria-label="Settings category" className="flex overflow-x-auto overflow-y-hidden border-b border-border">
          {availablePages.map((page) => <Button key={page.title} role="tab" type="button" variant="ghost" size="xs"
            aria-selected={selectedPage === page.title} data-testid={`config-page-${page.title}`}
            className={cn('h-7 min-w-max flex-1 rounded-none border-x-0 border-t-0 border-b-2 border-transparent px-1 text-module font-normal',
              allFields.some((field) => field.local && field.resettable && page.groups.some((group) => group.keys.includes(field.key))) && 'config-override-label',
              selectedPage === page.title && 'border-primary')}
            onClick={() => setActivePage(page.title)} onKeyDown={(event) => {
              const index = availablePages.indexOf(page);
              const next = event.key === 'ArrowRight' ? (index + 1) % availablePages.length
                : event.key === 'ArrowLeft' ? (index + availablePages.length - 1) % availablePages.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? availablePages.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault();
              setActivePage(availablePages[next].title);
              const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
              tabs?.[next]?.focus();
            }}>{page.title}</Button>)}
        </div>}
  </div>;
  const optionsBody = (
      <div ref={optionsScrollRef}
        className={cn("mx-2 min-h-0 flex-1 overflow-y-auto", optionsOverflowing && "pr-1")}
        data-testid="configuration-options-scroll" data-overflow-y={optionsOverflowing}>
      <div ref={optionsContentRef}>
      {!metadata ? <div className="p-2 text-xs text-muted-foreground">Loading configuration…</div> :
        mode !== 'project' && resolution.scope === 'invalid' ? (
          <div data-testid="scoped-invalid-selection" className="rounded border border-dashed p-2 text-xs text-muted-foreground">{resolution.disabledReason}</div>
        ) : <>
          {categories.length === 0 && <div data-testid="scoped-config-empty" className="p-2 text-xs text-muted-foreground">No matching settings</div>}
          {categories.map(({ title: category, fields: categoryFields, page, group, keys }) => {
            const expansionKey = `${page}/${group}`;
            const open = expanded[expansionKey] ?? true;
            const groupCatalogue = allFields.filter((field) => keys.includes(field.key));
            const nativeCategories = [...new Set(groupCatalogue.map((field) => field.category))];
            const highlighted = groupCatalogue.some((field) => field.local && field.resettable);
            return <div key={category} data-testid={`config-category-${category}`}>
              {group && <ContextMenu>
                <ContextMenuTrigger render={<div />}>
                  <Button type="button" variant="ghost" size="xs" data-testid={`config-category-toggle-${category}`}
                    aria-expanded={open} data-local-override-highlight={highlighted ? 'true' : 'false'}
                    className={cn("h-5 w-full justify-between rounded-none border-0 bg-control-background px-1 text-module font-semibold", highlighted && "config-override-label")}
                    onClick={() => setExpanded((current) => ({ ...current, [expansionKey]: !open }))}>
                    {category}{open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  </Button>
                </ContextMenuTrigger>
                <ContextMenuContent>{nativeCategories.map((nativeCategory) => <ContextMenuItem key={nativeCategory}
                  data-testid={`config-reset-category-${nativeCategory}`} disabled={!highlightedCategories.has(nativeCategory)}
                  onClick={() => void resetCategory(nativeCategory)}>Reset {nativeCategory}</ContextMenuItem>)}</ContextMenuContent>
              </ContextMenu>}
              {open && <div className="py-1">{categoryFields.map((field, index) => {
                const section = printSettingPlacement(field)?.section;
                const startsSection = section && section !== (index > 0 ? printSettingPlacement(categoryFields[index - 1])?.section : undefined);
                return <div key={field.key}>
                  {startsSection && <div data-testid={`config-section-${section}`} className="mt-1 flex items-center gap-2 px-1 text-module font-semibold text-muted-foreground">
                    {section}<span className="h-px flex-1 bg-border" />
                  </div>}
                  <ScopedField field={field} targets={resolution.targets} onCommit={commitField} onReset={resetField} />
                </div>;
              })}</div>}
            </div>;
          })}
        </>}
      </div>
      </div>
  );

  return (
    <section ref={panelRef} data-testid="scoped-configuration-panel" className="-mx-2 flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
      <div className={cn('shrink-0 space-y-1 bg-card', mode !== 'plates' && 'pb-1')}>
        <div data-testid="configuration-mode-header" className="shrink-0 bg-panel-header">
          <div role="tablist" aria-label="Configuration mode" className="sidebar-section-header">
            {(['project', 'scoped', 'plates'] as const).map((value) => <Button key={value} type="button" role="tab"
              aria-selected={mode === value} data-testid={`config-mode-${value}`} variant="ghost" size="xs"
              className={cn('h-5 w-[68px] rounded-b-none rounded-t-sm px-0 text-module leading-none font-normal',
                mode === value ? 'bg-card text-foreground hover:bg-card' : 'text-muted-foreground')}
              onClick={() => setConfigurationMode(value)}>{value === 'project' ? 'Project' : value === 'scoped' ? 'Objects' : 'Plates'}</Button>)}
          </div>
        </div>
        <div className="space-y-1 px-2">
        {mode === 'plates' && platesToolbar}
        {scopedContent && <div ref={objectListRef} hidden={mode !== 'scoped'} style={{ maxHeight: listMaxHeight }} className="overflow-y-auto border-b" data-testid="configuration-object-list-scroll">{scopedContent}</div>}
        {platesContent && <div ref={plateListRef} hidden={mode !== 'plates'} style={{ maxHeight: listMaxHeight }} className="overflow-y-auto border-b" data-testid="configuration-plate-list-scroll">{platesContent}</div>}
        {mode !== 'plates' && optionsHeader}
        </div>
      </div>
      {mode === 'plates' ? <div data-testid="plate-options-section"
        className="flex min-h-0 shrink-0 flex-col gap-1 overflow-hidden"
        style={{ height: PLATE_OPTIONS_SECTION_HEIGHT, maxHeight: plateOptionsMaxHeight }}>
        {optionsHeader}
        {optionsBody}
      </div> : optionsBody}
    </section>
  );
}
