import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  NativeScopedConfigMutationRequest,
  NativeScopedConfigTarget,
  OptionMeta,
} from '@slicer/client';
import { usePlatform } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useSceneInteractionVersion } from '../viewport/SceneInteractionContext';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { commitScopedConfigurationMutation, invalidateAfterSharedConfigurationMutation } from './configurationActions';
import {
  localKeysForTarget,
  projectScopedConfigurationFields,
  resolveScopedConfigurationTarget,
  type ScopedConfigurationField,
  type ScopedConfigurationTarget,
} from './scopedConfigurationProjection';

const SOURCE_LABEL: Record<string, string> = {
  preset: 'Preset', project: 'Project', plate: 'Plate', object: 'Object', part: 'Volume', mixed: 'Mixed',
};
const LOCAL_OVERRIDE_LABEL_COLOR = '#F1754E';

function targetRequestTargets(targets: readonly ScopedConfigurationTarget[]): NativeScopedConfigTarget[] {
  return targets.map(({ scope, id }) => ({ scope, ...(id === undefined ? {} : { id }) }));
}

function valueForField(field: ScopedConfigurationField): string {
  return field.mixed ? '' : field.value ?? '';
}

function isScalar(meta: OptionMeta): boolean {
  return meta.type === 'float' || meta.type === 'int';
}

function sourceBadge(field: ScopedConfigurationField) {
  return (
    <span
      data-testid={`config-source-${field.key}`}
      className="rounded border px-1 text-[0.6rem] uppercase tracking-wide text-muted-foreground"
      title={field.source === 'mixed' ? 'The selected targets have different sources.' : `Inherited from ${SOURCE_LABEL[field.source]}`}
    >
      {SOURCE_LABEL[field.source] ?? field.source}
    </span>
  );
}

export function ScopedField({
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
    }
  };
  const onDiscrete = (value: string) => { setDraft(value); void commit(value); };
  const reset = () => { void onReset(field).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); };
  const label = field.label;
  const row = 'flex items-center gap-1 py-0.5 min-h-7';
  const labelCls = 'w-32 shrink-0 truncate text-xs text-muted-foreground';
  const displayed = draft;
  const hasEditableLocalOverride = field.local && field.resettable;

  let control;
  if (field.meta.type === 'bool' && !field.mixed) {
    control = <Checkbox
      id={`scoped-${field.key}`}
      checked={displayed === '1'}
      onCheckedChange={(checked) => onDiscrete(checked ? '1' : '0')}
    />;
  } else if (field.meta.type === 'enum' && field.meta.enum_values?.length && !field.mixed) {
    control = <Select value={displayed} onValueChange={(value) => value != null && onDiscrete(value)}>
      <SelectTrigger className="flex-1" data-testid={`config-input-${field.key}`}><SelectValue placeholder={displayed} /></SelectTrigger>
      <SelectContent>{field.meta.enum_values.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
    </Select>;
  } else {
    control = <Input
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
      className="flex-1"
    />;
  }
  return (
    <div data-testid={`config-field-${field.key}`} className="space-y-0.5">
      <div className={row}>
        <Label
          htmlFor={`scoped-${field.key}`}
          data-testid={`config-option-label-${field.key}`}
          data-local-override-highlight={hasEditableLocalOverride ? 'true' : 'false'}
          className={labelCls}
          style={hasEditableLocalOverride ? { color: LOCAL_OVERRIDE_LABEL_COLOR } : undefined}
          title={label}
        >{label}</Label>
        {field.mixed && <span data-testid={`config-mixed-${field.key}`} className="w-16 shrink-0 text-xs font-semibold text-muted-foreground">Mixed</span>}
        {control}
        {sourceBadge(field)}
        {field.local && field.resettable && <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid={`config-reset-${field.key}`}
          title="Reset this local override"
          onClick={reset}
        >Reset</Button>}
      </div>
      {error && <div role="alert" data-testid={`config-error-${field.key}`} className="pl-32 text-[0.65rem] text-destructive">{error}</div>}
    </div>
  );
}

export function ScopedConfigurationPanel({ sceneInteraction }: { sceneInteraction: SceneInteractionController | null }) {
  const platform = usePlatform();
  useSceneInteractionVersion(sceneInteraction ?? undefined);
  const metadata = useSettingsStore((state) => state.metadata);
  const baseValues = useSettingsStore((state) => state.baseValues);
  const snapshot = useSettingsStore((state) => state.nativeScopedConfig);
  const mode = useSettingsStore((state) => state.configurationMode);
  const selectedVolumes = sceneInteraction?.selectedVolumes() ?? [];
  const selectionKind = sceneInteraction?.computeSelectionKind() ?? 'empty';
  const structure = useObjectListStore((state) => state.structure);
  const plateSession = usePlateSessionStore((state) => state.snapshot);
  const setError = useSlicerStore((state) => state.setError);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const resolution = useMemo(() => resolveScopedConfigurationTarget({
    selectionKind,
    selectedVolumes: selectedVolumes.map((volume) => ({ objectId: volume.buffer.objectId, volumeId: volume.buffer.volumeId })),
    activePlateId: plateSession?.currentPlateId ?? null,
    activePlateLabel: plateSession?.plates.find((plate) => plate.plateId === plateSession.currentPlateId)?.name,
    structure,
    wipeTowerSelected: sceneInteraction?.hasWipeTowerSelection,
  }), [plateSession, sceneInteraction, selectedVolumes, selectionKind, structure]);
  const fields = useMemo(() => metadata
    ? projectScopedConfigurationFields({ mode, metadata, baseValues, snapshot, resolution, search })
    : [], [baseValues, metadata, mode, resolution, search, snapshot]);
  // Reset actions operate on the whole selected category/catalogue, not just
  // the subset currently visible through the search query.
  const allFields = useMemo(() => metadata
    ? projectScopedConfigurationFields({ mode, metadata, baseValues, snapshot, resolution, search: '' })
    : [], [baseValues, metadata, mode, resolution, snapshot]);
  const categories = useMemo(() => {
    const grouped = new Map<string, ScopedConfigurationField[]>();
    for (const field of fields) grouped.set(field.category, [...(grouped.get(field.category) ?? []), field]);
    return [...grouped.entries()];
  }, [fields]);

  const commitField = async (field: ScopedConfigurationField, value: string) => {
    if (mode === 'scoped' && resolution.scope === 'invalid') throw new Error(resolution.disabledReason ?? 'no scoped configuration target');
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
  };
  const resetField = async (field: ScopedConfigurationField) => {
    if ((mode === 'scoped' && resolution.scope === 'invalid') || !field.local) return;
    const request: NativeScopedConfigMutationRequest = {
      version: 1, operation: 'reset', targets: targetRequestTargets(mode === 'project'
        ? [{ scope: 'project', label: 'Project' }]
        : resolution.targets), key: field.key,
    };
    const mutation = await commitScopedConfigurationMutation(platform, request);
    if (mutation) invalidateAfterSharedConfigurationMutation(mutation.affectedPlateIds);
  };
  const resetCategory = async (category: string) => {
    if (mode === 'scoped' && resolution.scope === 'invalid') return;
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
    if (mode === 'scoped' && resolution.scope === 'invalid') return;
    const targets = mode === 'project' ? [{ scope: 'project', label: 'Project' } as const] : resolution.targets;
    const hasLocal = targets.some((target) => localKeysForTarget(snapshot, target).some((key) => allFields.some((field) => field.key === key && field.resettable)));
    if (!hasLocal) return;
    const request: NativeScopedConfigMutationRequest = { version: 1, operation: 'reset-all', targets: targetRequestTargets(targets) };
    try {
      const mutation = await commitScopedConfigurationMutation(platform, request);
      if (mutation) invalidateAfterSharedConfigurationMutation(mutation.affectedPlateIds);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  if (!metadata) return <div className="p-3 text-xs text-muted-foreground">Loading configuration…</div>;
  return (
    <section data-testid="scoped-configuration-panel" className="space-y-2 border-t px-2 py-2">
      <div className="flex items-center justify-between gap-1 text-xs text-muted-foreground">
        <span data-testid="scoped-target-label">{mode === 'project' ? 'Project' : resolution.label}</span>
        {(mode === 'project' || resolution.targets.length > 0) && <Button type="button" variant="ghost" size="xs" data-testid="config-reset-all" onClick={() => void resetAll()}>Reset All</Button>}
      </div>
      {mode === 'scoped' && resolution.scope === 'invalid' ? (
        <div data-testid="scoped-invalid-selection" className="rounded border border-dashed p-2 text-xs text-muted-foreground">{resolution.disabledReason}</div>
      ) : (
        <>
          <Input data-testid="scoped-config-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search settings…" />
          {categories.length === 0 && <div data-testid="scoped-config-empty" className="p-2 text-xs text-muted-foreground">No matching settings</div>}
          {categories.map(([category, categoryFields]) => {
            const open = expanded[category] ?? true;
            return <div key={category} data-testid={`config-category-${category}`} className="rounded border">
              <div className="flex items-center justify-between px-2 py-1">
                <Button type="button" variant="ghost" size="xs" className="flex-1 justify-start font-semibold" onClick={() => setExpanded((current) => ({ ...current, [category]: !open }))}>
                  {open ? '▾' : '▸'} {category}
                </Button>
                <Button type="button" variant="ghost" size="xs" data-testid={`config-reset-category-${category}`} onClick={() => void resetCategory(category)}>Reset</Button>
              </div>
              {open && <div className="px-1 pb-1">{categoryFields.map((field) => <ScopedField key={field.key} field={field} targets={mode === 'project' ? [{ scope: 'project', label: 'Project' }] : resolution.targets} onCommit={commitField} onReset={resetField} />)}</div>}
            </div>;
          })}
        </>
      )}
    </section>
  );
}
