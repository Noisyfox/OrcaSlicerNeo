import type { SlicerRuntime } from '@orca/platform-contract';
import type { FilamentSessionSnapshot, HeightRangeRow, ModelObjectStructure, NativeScopedConfigSnapshot, OptionMetadata } from '@slicer/client';
import { editRanges } from '../objectList/heightRangeActions';
import { selectedHeightRanges, useObjectListStore, type HeightRangeSelection } from '../objectList/useObjectListStore';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { featureOptions } from './featureFilamentSettings';
import { isGenericScopedKey, type ScopedConfigurationField } from './scopedConfigurationProjection';
import { isVisiblePrintSetting } from './printSettingsLayout';

function setting(rows: HeightRangeRow[], key: string, inherited: string, metadata: OptionMetadata,
  label?: string, source: ScopedConfigurationField['source'] = 'object'): ScopedConfigurationField {
  const meta = metadata[key] ?? { type: 'int' };
  const values = rows.map(row => row.values[key] ?? inherited);
  const mixed = values.some(value => value !== values[0]);
  const local = rows.some(row => Object.hasOwn(row.values, key));
  // Native ranges retain these two entries even after Reset.
  const resettable = key === 'layer_height' || key === 'extruder'
    ? rows.some(row => Object.hasOwn(row.values, key) && Number(row.values[key]) !== Number(inherited))
    : local;
  return { key, label: label ?? (meta.label || meta.full_label || key), category: meta.category || 'Process', meta,
    mixed, local, resettable, value: mixed ? null : values[0], source: mixed ? 'mixed' : local ? 'range' : source };
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

export function heightRangeEditor(runtime: SlicerRuntime, scene: SceneInteractionController | null,
  selection: HeightRangeSelection, object: ModelObjectStructure, metadata: OptionMetadata,
  base: Readonly<Record<string, string>>, snapshot: NativeScopedConfigSnapshot, rack: FilamentSessionSnapshot | null) {
  const rows = selectedHeightRanges(object, selection);
  const targets = rows.map(({ min, max, revision }) => ({ min, max, revision }));
  const objectId = object.id;
  const fieldTargets = rows.map(row => ({ scope: 'range' as const, id: `${objectId}/${row.min}/${row.max}` }));
  const projectValues = { ...base, ...snapshot.project };
  const objectValues = snapshot.objects[objectId] ?? {};
  const parentValues = { ...projectValues, ...objectValues };
  const fields: ScopedConfigurationField[] = Object.entries(metadata)
    .filter(([key, meta]) => key === 'layer_height' || (meta.scopes?.includes('part') && isGenericScopedKey(key, meta)))
    .map(([key, meta]) => setting(rows, key, parentValues[key] ?? meta.default ?? '', metadata, undefined,
      Object.hasOwn(objectValues, key) ? 'object' : Object.hasOwn(snapshot.project, key) ? 'project' : 'preset'))
    .filter(field => isVisiblePrintSetting(field, 'scoped'));
  if (rack) fields.push(setting(rows, 'extruder', '0', metadata, 'Filament'), ...rangeFilamentFields(objectId, rows, metadata, rack));
  const single = selection.bounds !== 'all' && rows.length === 1 ? rows[0] : undefined;
  if (single) {
    for (const endpoint of ['min', 'max'] as const) {
      fields.push({ key: `range_${endpoint}`, label: endpoint === 'min' ? 'Start (mm)' : 'End (mm)',
        category: 'Height range', meta: { type: 'float', min: 0 }, rangeEndpoint: endpoint,
        value: String(single[endpoint]), source: 'range', local: false, resettable: false, mixed: false });
    }
  }
  async function commit(field: ScopedConfigurationField, value: string) {
    const numeric = field.rangeEndpoint || field.key === 'layer_height' || field.key === 'extruder' || field.filamentRoute;
    if (numeric && (!value.trim() || !Number.isFinite(Number(value)))) throw new Error('Enter a valid number.');
    const command = field.rangeEndpoint
      ? { operation: field.rangeEndpoint, value: Number(value) }
      : { operation: 'set' as const, key: field.key, value: numeric ? Number(value) : value };
    const result = await editRanges(runtime, { objectId, targets, ...command }, scene);
    if (!result.ok) throw new Error(result.error);
    const updated = useObjectListStore.getState().structure.find(o => o.id === objectId);
    const row = updated && selectedHeightRanges(updated, { ...selection, bounds: result.selection })[0];
    return row && field.rangeEndpoint ? String(row[field.rangeEndpoint]) : row?.values[field.key] ?? value;
  }
  async function reset(keys: readonly string[]) {
    const localKeys = fields.filter(field => field.local && field.resettable && keys.includes(field.key)).map(field => field.key);
    if (!localKeys.length) return;
    const result = await editRanges(runtime, { objectId, targets, operation: 'reset', keys: localKeys }, scene);
    if (!result.ok) throw new Error(result.error);
  }
  const label = single ? `${single.min} – ${single.max} mm` : selection.bounds === 'all' ? 'Height Range Modifier' : `${rows.length} height ranges`;
  const identity = fieldTargets.map(target => target.id).join(',');
  return { label, identity, fields, targets: fieldTargets, rows, projectValues, parentValues, commit, reset };
}
