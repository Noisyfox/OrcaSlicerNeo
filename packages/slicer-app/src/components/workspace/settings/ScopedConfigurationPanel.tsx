import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type {
  NativeScopedConfigMutationRequest,
  NativeScopedConfigTarget,
  ScopedConfigEditorTarget,
  OptionMeta,
} from '@slicer/client';
import { configVectorElementAt } from '@slicer/client';
import { usePlatform } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useConfigEditorSelection } from './ConfigEditorSelection';
import { PrintEditorSelection } from './PrintEditorSelection';
import { NozzleIcon } from '@/components/ui/nozzle-icon';
import { usePrintConfigEditor, useScopedConfigEditor } from './usePrintConfigEditor';
import { elementText, parsePrintElement, printDirtyChoiceIds, printHasLocalOverrides, printOwnsField, projectPrintField, scopedPrintField, scopedDirtyChoiceIds, scopedHasLocalOverrides } from './printEditorProjection';
import { editorFieldTarget, fieldViewKey } from './presetEditorBindings';
import { SearchInput } from '@/components/ui/search-input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { commitScopedConfigurationMutation } from './configurationActions';
import {
  localKeysForTarget,
  projectScopedConfigurationFields,
  resolveScopedConfigurationTarget,
  scopedConfigurationCatalogue,
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
  return `${field.mixed ? 'The selected targets have different effective values.\n' : ''}Effective value source: ${SOURCE_LABEL[field.source] ?? field.source}.`;
}

export const ScopedField = memo(function ScopedField({
  field,
  targets,
  onCommit,
  onReset,
  disabled = false,
  selectionGutter = false,
}: {
  selectionGutter?: boolean;
  disabled?: boolean;
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
    setDraft(initial); setError(null);
  }, [initial, signature]);
  const commit = async (value: string) => {
    if (committing.current || disabled) return;
    committing.current = true;
    setCommitPending(true);
    const submittedSignature = signatureRef.current;
    try {
      const effective = await onCommit(field, value);
      if (signatureRef.current === submittedSignature) setDraft(effective);
      if (signatureRef.current === submittedSignature) setError(null);
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
  const defaultValue = useSettingsStore((state) => state.tooltipDefaults[field.key]);
  const editor=field.editor;
  const unavailable=editor?.target.kind==='unavailable';
  const readOnly=unavailable || editor?.vector?.readOnly===true;
  const indexedKey=editor?.target.kind==='indexed' ? `${field.key}#${editor.target.index}` : field.key;
  const optionHelp = unavailable ? `This selection has no corresponding native mapping.\nParameter name: ${field.key}` :
    optionTooltip(editor?.metadata ?? field.meta, indexedKey, field.label, editor?.metadata?.tooltip_default ?? defaultValue);
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
  const controlDisabled = disabled || readOnly || (field.key === 'curr_bed_type' && commitPending);
  const hasEditableLocalOverride = field.local && field.resettable;
  const sourceDetails=editor && !unavailable ? `\nSource: ${editor.sourceMixed?'Mixed':editor.source===null?'(null)':elementText(editor.source,editor.vector)}${editor.inheritedSource ? `\nInherited source: ${SOURCE_LABEL[editor.inheritedSource]}.` : ''}\nEffective: ${field.mixed?'Mixed':editor.effective===null?'(null)':elementText(editor.effective,editor.vector)}` : '';
  const tooltip = <span className="whitespace-pre-line">{`${optionHelp}\n\n${valueTooltip(field)}${sourceDetails}`}</span>;

  let control;
  if(readOnly) {
    control=<TooltipFor content={tooltip} nonInteractive><span data-testid={`config-input-${field.key}`} className="text-xs text-muted-foreground">{unavailable?'Unavailable':displayed}</span></TooltipFor>;
  } else if (field.meta.type === 'bool') {
    control = <TooltipFor content={tooltip} nonInteractive><Checkbox
      id={`scoped-${field.key}`}
      className="size-5 after:inset-0"
      checked={!field.mixed && displayed === '1'}
      indeterminate={field.mixed}
      disabled={controlDisabled}
      data-testid={`config-input-${field.key}`}
      onCheckedChange={(checked) => onDiscrete(checked ? '1' : '0')}
    /></TooltipFor>;
  } else if (field.meta.type === 'enum' && field.meta.enum_values?.length && !field.mixed) {
    const selectedIndex = field.meta.enum_values.indexOf(displayed);
    const selectedLabel = field.meta.enum_labels?.[selectedIndex] ?? displayed;
    control = <Select disabled={controlDisabled} value={displayed} onValueChange={(value) => value != null && onDiscrete(value)}>
      <TooltipFor content={tooltip} nonInteractive>
        <SelectTrigger variant="sidebar" id={`scoped-${field.key}`} size="sm" className="w-full" data-testid={`config-input-${field.key}`}><SelectValue>{selectedLabel}</SelectValue></SelectTrigger>
      </TooltipFor>
      <SelectContent><SelectGroup>{field.meta.enum_values.map((value, index) => <SelectItem key={value} value={value}>{field.meta.enum_labels?.[index] ?? value}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>;
  } else if(editor?.vector?.multiline || editor?.vector?.scalarType==='points') {
    control=<textarea id={`scoped-${field.key}`} data-testid={`config-input-${field.key}`} value={displayed} disabled={controlDisabled}
      className="min-h-16 w-full rounded border border-input bg-background px-2 py-1 text-xs"
      onChange={event=>setDraft(event.target.value)} onBlur={()=>{if(cancelBlur.current){cancelBlur.current=false;return;}if(draft!==valueForField(field))void commit(draft);}}
      onKeyDown={event=>{if(event.key==='Escape'){cancelBlur.current=true;setDraft(initial);event.currentTarget.blur();}}} />;
  } else {
    control = <div className="flex h-6 min-w-0 items-center rounded-sm bg-control-background focus-within:ring-1 focus-within:ring-ring"><TooltipFor content={tooltip} nonInteractive><Input
        id={`scoped-${field.key}`}
        data-testid={`config-input-${field.key}`}
        value={displayed}
        disabled={controlDisabled}
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
          aria-label={`Decrease ${field.label}`} disabled={controlDisabled || commitPending || field.mixed || !Number.isFinite(numericDraft) || numericDraft <= (field.meta.min ?? -Infinity)} onClick={() => adjust(-1)}><Minus /></Button>
        <Button type="button" variant="number-stepper" size="icon-xs" className="size-[18px] rounded-l-none rounded-r-[2px] [&>svg]:size-3"
          aria-label={`Increase ${field.label}`} disabled={controlDisabled || commitPending || field.mixed || !Number.isFinite(numericDraft) || numericDraft >= (field.meta.max ?? Infinity)} onClick={() => adjust(1)}><Plus /></Button>
      </div>}
      </div>;
  }
  return (
    <div data-testid={`config-field-${field.key}`} data-native-index={editor?.target.kind==='indexed'?editor.target.index:undefined} className="space-y-0.5">
      <div className={row}>
        <div className={cn("flex min-w-0 items-center", selectionGutter ? "gap-0.5" : "gap-1")}>
        {selectionGutter && <span className="flex h-4 w-2.5 shrink-0 items-center justify-center" data-testid={`config-nozzle-gutter-${field.key}`}>
          {editor?.perSelection && <NozzleIcon className="size-4 shrink-0 translate-y-px text-muted-foreground" data-testid={`config-nozzle-icon-${field.key}`} />}
        </span>}
        <TooltipFor content={<span className="whitespace-pre-line">{optionHelp}</span>} nonInteractive>
          <Label
            htmlFor={`scoped-${field.key}`}
            data-testid={`config-option-label-${field.key}`}
            data-local-override-highlight={hasEditableLocalOverride ? 'true' : 'false'}
            className={cn(labelCls, hasEditableLocalOverride && 'config-override-label')}
          >{label}</Label>
        </TooltipFor>
        {field.local && field.resettable && <TooltipFor content="Reset this local override"><Button
          type="button" variant="ghost" size="icon-xs" className="size-4 shrink-0 text-config-override [&>svg]:size-3"
          aria-label={`Reset ${field.label}`} data-testid={`config-reset-${field.key}`} disabled={controlDisabled} onClick={reset}><RotateCcw /></Button></TooltipFor>}
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
  && previous.onCommit === next.onCommit && previous.onReset === next.onReset && previous.disabled === next.disabled && previous.selectionGutter === next.selectionGutter
  && (Object.keys(previous.field) as Array<keyof ScopedConfigurationField>)
    .every((key) => previous.field[key] === next.field[key]));

// Fixed options budget includes expanded search even when filtering hides rows.
// Catalogue content that exceeds the budget scrolls independently.
const PLATE_OPTIONS_SECTION_HEIGHT = 170;

export function ScopedConfigurationPanel({ sceneInteraction, projectContent, scopedContent, platesContent, platesToolbar, bedTypeDisabled = false }: {
  sceneInteraction: SceneInteractionController | null;
  bedTypeDisabled?: boolean;
  projectContent?: ReactNode;
  scopedContent?: ReactNode;
  platesContent?: ReactNode;
  platesToolbar?: ReactNode;
}) {
  const platform = usePlatform();
  const mode = useSettingsStore((state) => state.configurationMode);
  const printEditor=usePrintConfigEditor(platform,mode==='project');
  const printSelection=useConfigEditorSelection(printEditor.snapshot?.editorSelection??null,printEditor.entry);
  const selection = sceneInteraction?.selection;
  const subscribeSelection = useCallback(
    (listener: () => void) => mode === 'scoped' ? selection?.subscribe(listener) ?? (() => {}) : () => {},
    [mode, selection],
  );
  const selectionRevision = useSyncExternalStore(subscribeSelection, () => mode === 'scoped' ? selection?.revision ?? 0 : 0);
  const metadata = useSettingsStore((state) => state.metadata);
  const baseValues = useSettingsStore((state) => state.baseValues);
  const bedType = useSettingsStore((state) => state.bedType);
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
  const scopedTargets = useMemo<readonly ScopedConfigEditorTarget[]>(() => mode === 'scoped' &&
    (resolution.scope === 'object' || resolution.scope === 'part')
    ? resolution.targets.map(target => ({ scope: resolution.scope as 'object' | 'part', id: String(target.id) })) : [], [mode, resolution]);
  const scopedEditor = useScopedConfigEditor(platform, scopedTargets, mode === 'scoped');
  const scopedSelection = useConfigEditorSelection(scopedEditor.selection, scopedEditor.entry);
  const selectionMetadata = mode === 'project' ? printEditor.snapshot?.editorSelection : mode === 'scoped' ? scopedEditor.selection : null;
  const selectedChoice = mode === 'project' ? printSelection : scopedSelection;
  // Reset actions operate on the whole selected category/catalogue, not just
  // the subset currently visible through the search query.
  const allFields = useMemo(() => metadata
    ? (mode==='scoped' ? scopedConfigurationCatalogue(metadata,resolution) : projectScopedConfigurationFields({ mode, metadata, baseValues, snapshot, resolution, search: '' })).filter((field) => isVisiblePrintSetting(field, mode) &&
      (field.key !== 'curr_bed_type' || (bedType?.supportsSelection && bedType.choices.length > 0)))
      .map(field => field.key === 'curr_bed_type' && bedType ? { ...field, meta: { ...field.meta,
        enum_values: bedType.choices.map(choice => choice.value), enum_labels: bedType.choices.map(choice => choice.label),
      } } : field)
      .map(field=>mode==='project'?projectPrintField(field,printEditor.snapshot,printSelection.choiceId):
        mode==='scoped' && scopedEditor.snapshot ? scopedPrintField(field,scopedEditor.snapshot,scopedSelection.choiceId) : field)
    : [], [baseValues, bedType, metadata, mode, resolution, snapshot,printEditor.snapshot,printSelection.choiceId,scopedEditor.snapshot,scopedSelection.choiceId]);
  const availablePages = useMemo(() => printSettingsPages(mode).filter((page) =>
    page.groups.some((group) => group.keys.some((key) => allFields.some((field) => field.key === key)))), [allFields, mode]);
  const selectedPage = availablePages.some((page) => page.title === activePage) ? activePage : availablePages[0]?.title;
  const categories = useMemo(() => printSettingsGroups(allFields, selectedPage, search, mode), [allFields, search, selectedPage, mode]);
  const highlightedCategories = useMemo(() => new Set(allFields
    .filter((field) => field.local && field.resettable)
    .map((field) => field.category)), [allFields]);
  const hasLocalOverrides = mode === 'project' ? printHasLocalOverrides(printEditor.snapshot, snapshot.project)
    : mode === 'scoped' ? scopedHasLocalOverrides(scopedEditor.snapshot) : highlightedCategories.size > 0;
  const pageKeys = availablePages.find(page => page.title === selectedPage)?.groups.flatMap(group => group.keys)
    .filter(key => allFields.some(field => field.key === key)) ?? [];
  const dirtyChoiceIds = mode === 'scoped' ? scopedDirtyChoiceIds(scopedEditor.snapshot, pageKeys) : printDirtyChoiceIds(printEditor.snapshot, pageKeys);

  const commitField = useCallback(async (field: ScopedConfigurationField, value: string) => {
    if (mode !== 'project' && resolution.scope === 'invalid') throw new Error(resolution.disabledReason ?? 'no scoped configuration target');
    if(mode==='scoped' && field.editor?.targets) {
      const element = field.editor, targets = element.targets!;
      if(element.target.kind==='unavailable') throw new Error('This selection has no corresponding native mapping.');
      if(element.target.kind==='shared' && ['float','int','percent','float_or_percent'].includes(field.meta.type) &&
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?%?$/.test(value.trim())) throw new Error('Enter a valid number.');
      const request: NativeScopedConfigMutationRequest = element.target.kind==='indexed' && element.vector
        ? {version:1,operation:'set-element',targets,expectedRevision:element.revision,key:field.key,index:element.target.index,
          scalarType:element.vector.scalarType,value:parsePrintElement(element,value)} as NativeScopedConfigMutationRequest
        : {version:1,operation:'set',targets,key:field.key,value};
      const next = await scopedEditor.mutate(request, targets);
      return valueForField(scopedPrintField(field,next,scopedSelection.choiceId));
    }
    if(mode==='project' && field.editor) {
      const element=field.editor;
      if(element.target.kind!=='indexed' || !element.vector) throw new Error('This selection has no corresponding native mapping.');
      const next=await printEditor.mutate({version:1,operation:'set-element',targets:[{scope:'project'}],
        expectedRevision:element.revision,key:field.key,index:element.target.index,scalarType:element.vector.scalarType,
        value:parsePrintElement(element,value)} as NativeScopedConfigMutationRequest);
      const vector=next.editorVectors[field.key];
      return elementText(configVectorElementAt(vector,vector.effectiveValues,element.target.index),vector);
    }
    const request: NativeScopedConfigMutationRequest = {
      version: 1, operation: 'set', targets: targetRequestTargets(mode === 'project'
        ? [{ scope: 'project', label: 'Project' }]
        : resolution.targets), key: field.key, value,
    };
    if(mode==='project' && printEditor.snapshot && printOwnsField(printEditor.snapshot,field.key)) await printEditor.mutate(request);
    else await commitScopedConfigurationMutation(platform, request);
    const current = useSettingsStore.getState();
    const effective = projectScopedConfigurationFields({ mode, metadata: metadata!,
      baseValues: current.baseValues, snapshot: current.nativeScopedConfig, resolution })
      .find((candidate) => candidate.key === field.key);
    return effective ? valueForField(effective) : value;
  }, [metadata, mode, platform, resolution,printEditor.mutate,printEditor.snapshot,scopedEditor.mutate,scopedSelection.choiceId]);
  const resetField = useCallback(async (field: ScopedConfigurationField) => {
    if ((mode !== 'project' && resolution.scope === 'invalid') || !field.local) return;
    if(mode==='scoped' && field.editor?.targets) {
      const element=field.editor;
      if(element.target.kind==='unavailable') return;
      await scopedEditor.mutate({version:1,operation:'reset-fields',targets:element.targets!,expectedRevision:element.revision,
        fields:[{key:field.key,...element.target}]},element.targets!);
      return;
    }
    if(mode==='project' && field.editor) {
      const element=field.editor;
      if(element.target.kind!=='indexed') return;
      await printEditor.mutate({version:1,operation:'reset-fields',targets:[{scope:'project'}],expectedRevision:element.revision,
        fields:[{key:field.key,...element.target}]});
      return;
    }
    const request: NativeScopedConfigMutationRequest = {
      version: 1, operation: 'reset', targets: targetRequestTargets(mode === 'project'
        ? [{ scope: 'project', label: 'Project' }]
        : resolution.targets), key: field.key,
    };
    if(mode==='project' && printEditor.snapshot && printOwnsField(printEditor.snapshot,field.key)) await printEditor.mutate(request);
    else await commitScopedConfigurationMutation(platform, request);
  }, [mode, platform, resolution,printEditor.mutate,printEditor.snapshot,scopedEditor.mutate]);
  const resetCategory = async (category: string) => {
    if (mode !== 'project' && resolution.scope === 'invalid') return;
    const candidates = allFields.filter((field) => field.category === category && field.local);
    if (candidates.length === 0) return;
    if(mode==='project') {
      if(!printEditor.snapshot) return;
      const fields=allFields.filter(field=>field.category===category && field.resettable).flatMap(field=>{
        const target=printOwnsField(printEditor.snapshot!,field.key)
          ? editorFieldTarget(printEditor.snapshot!,field.key,printSelection.choiceId) : {kind:'shared' as const};
        return target.kind==='unavailable'?[]:[{key:field.key,...target}];
      });
      try{await printEditor.mutate({version:1,operation:'reset-fields',targets:[{scope:'project'}],expectedRevision:printEditor.snapshot.revision,fields});}
      catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
      return;
    }
    if(mode==='scoped') {
      if(!scopedEditor.snapshot) return;
      const fields=allFields.filter(field=>field.category===category && field.resettable).flatMap(field=>
        field.editor && field.editor.target.kind!=='unavailable' ? [{key:field.key,...field.editor.target}] : []);
      try{await scopedEditor.mutate({version:1,operation:'reset-fields',targets:scopedTargets,expectedRevision:scopedEditor.snapshot.revision,fields},scopedTargets);}
      catch(reason){setError(reason instanceof Error?reason.message:String(reason));}
      return;
    }
    const request: NativeScopedConfigMutationRequest = {
      version: 1, operation: 'reset-category', targets: targetRequestTargets(resolution.targets), category,
    };
    try {
      await commitScopedConfigurationMutation(platform, request);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const resetAll = async () => {
    if (mode !== 'project' && resolution.scope === 'invalid') return;
    const targets = mode === 'project' ? [{ scope: 'project', label: 'Project' } as const] : resolution.targets;
    const hasLocal = mode !== 'plates' ? hasLocalOverrides : targets.some((target) => localKeysForTarget(snapshot, target).some((key) => allFields.some((field) => field.key === key && field.resettable)));
    if (!hasLocal) return;
    const request: NativeScopedConfigMutationRequest = { version: 1, operation: 'reset-all', targets: targetRequestTargets(targets) };
    try {
      if(mode==='project') await printEditor.mutate(request);
      else if(mode==='scoped') await scopedEditor.mutate(request,scopedTargets);
      else await commitScopedConfigurationMutation(platform, request);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const optionsHeader = <div className={cn('shrink-0 space-y-1', mode === 'plates' && 'px-2')}>
        <div className="flex min-w-0 items-center gap-1">
          <TooltipFor content="Reset all local overrides"><Button type="button" variant="ghost" size="icon-xs"
            className="size-5 shrink-0 text-config-override [&>svg]:size-3" aria-label="Reset All" data-testid="config-reset-all"
            disabled={!hasLocalOverrides || (mode !== 'project' && resolution.scope === 'invalid') || (mode==='scoped' && (scopedEditor.pending || scopedEditor.refreshing))} onClick={() => void resetAll()}><RotateCcw /></Button></TooltipFor>
          {mode === 'project' ? <div data-testid="config-process-profile" data-dirty={hasLocalOverrides ? 'true' : 'false'} className={cn("min-w-0 flex-1", hasLocalOverrides && "[&_button[data-slot=combobox-trigger]]:text-config-override")}>{projectContent}</div> :
            <span data-testid="scoped-target-label" data-dirty={hasLocalOverrides ? 'true' : 'false'} className={cn("min-w-0 flex-1 truncate text-xs text-muted-foreground", mode==='scoped' && hasLocalOverrides && "text-config-override")}>{resolution.label}</span>}
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
        {selectionMetadata && mode!=='plates' && (mode==='project' || resolution.scope!=='invalid') && selectionMetadata.choices.length>1 &&
          categories.some(category=>category.fields.some(field=>selectionMetadata.fieldBindings[field.key]?.kind==='per_selection')) &&
          <PrintEditorSelection metadata={selectionMetadata} choiceId={selectedChoice.choiceId} onSelect={selectedChoice.select}
            disabled={mode==='project' && printEditor.refreshing} dirtyChoiceIds={dirtyChoiceIds} />}
        {mode==='scoped' && scopedEditor.error && <p role="alert" className="text-xs text-destructive">{scopedEditor.error}</p>}
        {mode==='project' && printEditor.error && <p role="alert" className="text-xs text-destructive">{printEditor.error}</p>}
  </div>;
  const optionsBody = (
      <div ref={optionsScrollRef}
        className={cn("mx-2 min-h-0 flex-1 overflow-y-auto", optionsOverflowing && "pr-1")}
        data-testid="configuration-options-scroll" data-overflow-y={optionsOverflowing}>
      <div ref={optionsContentRef}>
      {!metadata ? <div className="p-2 text-xs text-muted-foreground">Loading configuration…</div> :
        mode !== 'project' && resolution.scope === 'invalid' ? (
          <div data-testid="scoped-invalid-selection" className="rounded border border-dashed p-2 text-xs text-muted-foreground">{resolution.disabledReason}</div>
        ) : mode==='scoped' && !scopedEditor.snapshot ? <div className="p-2 text-xs text-muted-foreground">Loading configuration…</div> : <>
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
                const scopedBinding = mode==='scoped' ? field.editor?.target : undefined;
                return <div key={mode==='scoped' ? `${scopedEditor.identity}:${field.key}:${scopedBinding?.kind}:${scopedBinding?.kind==='indexed'?`${scopedSelection.identity}:${scopedBinding.index}`:scopedBinding?.kind==='unavailable'?scopedSelection.identity:''}` : mode==='project' && printEditor.snapshot && printOwnsField(printEditor.snapshot,field.key)?fieldViewKey(printEditor.snapshot,field.key,printSelection.choiceId):`${mode}:${field.key}`}>
                  {startsSection && <div data-testid={`config-section-${section}`} className="mt-1 flex items-center gap-2 px-1 text-module font-semibold text-muted-foreground">
                    {section}<span className="h-px flex-1 bg-border" />
                  </div>}
                  <ScopedField selectionGutter={mode!=='plates' && (selectionMetadata?.choices.length??0)>1} disabled={(mode==='scoped' && (scopedEditor.pending || scopedEditor.refreshing || scopedEditor.error!==null)) || (field.key === 'curr_bed_type' && bedTypeDisabled) || (mode==='project' &&
                    (!printEditor.snapshot || (printOwnsField(printEditor.snapshot,field.key) &&
                      (printEditor.pending || printEditor.refreshing || printEditor.error!==null))))}
                    field={field} targets={resolution.targets} onCommit={commitField} onReset={resetField} />
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
