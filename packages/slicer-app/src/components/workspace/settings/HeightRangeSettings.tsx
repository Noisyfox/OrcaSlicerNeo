import { useState, type KeyboardEvent } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { HeightRangeRow, ModelObjectStructure, OptionMetadata, FilamentSessionSnapshot } from '@slicer/client';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { Input } from '@/components/ui/input';
import { filamentSlotChoice } from '../FilamentSwatch';
import { editRanges } from '../objectList/heightRangeActions';
import { selectedHeightRanges, useObjectListStore, type HeightRangeSelection } from '../objectList/useObjectListStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import type { ScopedField } from './ScopedConfigurationPanel';
import { featureOptions } from './featureFilamentSettings';
import { isGenericScopedKey, type ScopedConfigurationField } from './scopedConfigurationProjection';
import { isVisiblePrintSetting } from './printSettingsLayout';

function Endpoint({ name, value, submit }: { name: 'min' | 'max'; value: number; submit: (v: number) => Promise<void> }) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  const focus = useObjectListStore(s => s.focusRange);
  async function commit() {
    focus(null);
    if (Number(draft) === value && draft.trim()) return;
    try {
      if (!draft.trim() || !Number.isFinite(Number(draft))) throw new Error('Enter a height in millimetres.');
      await submit(Number(draft));
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  function keyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') e.currentTarget.blur();
    if (e.key === 'Escape') { e.stopPropagation(); setDraft(String(value)); setError(''); }
  }
  return <label className="min-w-0 flex-1 text-xs">{name === 'min' ? 'Start (mm)' : 'End (mm)'}
    <Input aria-label={name === 'min' ? 'Start (mm)' : 'End (mm)'} value={draft} inputMode="decimal"
      onFocus={() => focus(name)} onChange={e => setDraft(e.target.value)} onBlur={() => void commit()} onKeyDown={keyDown} />
    {error && <span role="alert">{error}</span>}
  </label>;
}

function setting(rows: HeightRangeRow[], key: string, inherited: string, metadata: OptionMetadata,
  label?: string): ScopedConfigurationField {
  const meta = metadata[key] ?? { type: 'int' };
  const values = rows.map(row => row.values[key] ?? inherited);
  const mixed = values.some(value => value !== values[0]);
  const local = rows.some(row => Object.hasOwn(row.values, key));
  return { key, label: label ?? (meta.full_label || meta.label || key), category: meta.category || 'Process', meta,
    mixed, local, resettable: local, value: mixed ? null : values[0], source: mixed ? 'mixed' : local ? 'range' : 'object' };
}

export function rangeFilamentFields(objectId: number, rows: HeightRangeRow[], metadata: OptionMetadata, rack: Pick<FilamentSessionSnapshot, 'assignments' | 'routing'>) {
  const base = rack.assignments.objects.find(row => row.id === objectId)?.effectiveSlot ?? 1;
  return featureOptions.map(([key, selector, label]) => {
    const parent = rack.routing?.find(row => row.target === 'object' && row.id === objectId && row.selector === selector);
    const inherited = parent?.inherited
      ? rack.routing?.find(row => row.target === 'project' && row.selector === selector)?.explicitSlot ?? 0
      : parent?.explicitSlot ?? 0;
    const field = setting(rows, key, String(inherited), metadata, label);
    const effective = rows.map(row => {
      const local = row.values[key];
      if (local === undefined && inherited > 0) return inherited;
      return Number(local ?? 0) || Number(row.values.extruder) || base;
    });
    return { ...field, filamentRoute: { selector, effectiveSlot: effective.every(slot => slot === effective[0]) ? effective[0] : null } };
  });
}

export function HeightRangeSettings({ selection, object, scene, Field }: {
  selection: HeightRangeSelection; object: ModelObjectStructure; scene?: SceneInteractionController | null; Field: typeof ScopedField;
}) {
  const { runtime } = usePlatform();
  const metadata = useSettingsStore(s => s.metadata);
  const base = useSettingsStore(s => s.baseValues);
  const snapshot = useSettingsStore(s => s.nativeScopedConfig);
  const rack = useFilamentSessionStore(s => s.snapshot);
  const pending = useFilamentSessionStore(s => s.pendingKind !== null);
  const rows = selectedHeightRanges(object, selection);
  if (!metadata || !rows.length) return null;
  const targets = rows.map(row => ({ min: row.min, max: row.max, revision: row.revision }));
  const objectId = object.id;
  const fieldTargets = targets.map(row => ({ scope: 'object' as const, label: 'Height range', id: `${objectId}/${row.min}/${row.max}` }));
  const inherited = (key: string) => snapshot.objects[String(objectId)]?.[key] ?? snapshot.project[key] ?? base[key] ?? metadata[key]?.default ?? '';
  const baseField = setting(rows, 'extruder', '0', metadata);
  const coreFields = ['layer_height', 'wall_loops', 'sparse_infill_density'];
  const fields = Object.keys(metadata).filter(key => key === 'layer_height' || (metadata[key].scopes?.includes('part') && isGenericScopedKey(key, metadata[key])))
    .map(key => setting(rows, key, inherited(key), metadata))
    .filter(field => coreFields.includes(field.key) || isVisiblePrintSetting(field, 'scoped'));
  const other = new Map<string, ScopedConfigurationField[]>();
  for (const field of fields) {
    if (coreFields.includes(field.key)) continue;
    const group = other.get(field.category) ?? [];
    group.push(field);
    other.set(field.category, group);
  }
  async function commit(field: ScopedConfigurationField, value: string) {
    const typed = field.key === 'layer_height' || field.key === 'extruder' || field.filamentRoute ? Number(value) : value;
    const r = await editRanges(runtime, { objectId, targets, operation: 'set', key: field.key, value: typed }, scene);
    if (!r.ok) throw new Error(r.error);
    const updated = useObjectListStore.getState().structure.find(o => o.id === objectId);
    return updated && selectedHeightRanges(updated, selection)[0]?.values[field.key] || value;
  }
  async function reset(field: ScopedConfigurationField) {
    const r = await editRanges(runtime, { objectId, targets, operation: 'reset', key: field.key }, scene);
    if (!r.ok) throw new Error(r.error);
  }
  const renderField = (field: ScopedConfigurationField) => <Field key={field.key} field={field}
    targets={fieldTargets} onCommit={commit} onReset={reset} disabled={pending} />;
  return <section aria-label="Height range settings" className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-1">
    {selection.bounds !== 'all' && rows.length === 1 && <div className="flex gap-2">
      {(['min','max'] as const).map(name => <Endpoint key={`${objectId}/${rows[0].min}/${rows[0].max}/${name}`}
        name={name} value={rows[0][name]} submit={async value => {
          const result = await editRanges(runtime, { objectId, targets, operation: name, value }, scene);
          if (!result.ok) throw new Error(result.error);
        }} />)}
    </div>}
    {coreFields.map(key => fields.find(field => field.key === key)).filter(field => field !== undefined).map(renderField)}
    {rack && <><div className="flex items-center gap-1 text-xs"><label className="flex flex-1 items-center justify-between">Filament
      <select aria-label="Range filament" disabled={pending} value={baseField.mixed ? '' : baseField.value ?? '0'}
        onChange={e => void commit(baseField, e.target.value).catch(() => {})}>
        {baseField.mixed && <option value="">Mixed</option>}
        <option value="0">Default</option>
        {rack.slots.map(slot => <option key={slot.slot} value={slot.slot}>{filamentSlotChoice(slot).label}</option>)}
      </select></label></div>
      {rangeFilamentFields(objectId, rows, metadata, rack).map(renderField)}</>}
    {[...other].map(([category, entries]) => <details key={category}><summary className="cursor-pointer text-xs font-medium">{category}</summary>
      {entries.map(renderField)}</details>)}
  </section>;
}
