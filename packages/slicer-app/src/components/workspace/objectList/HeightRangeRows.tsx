import { useRef, type MouseEvent, type ReactNode } from 'react';
import type { HeightRangeRow, ModelObjectStructure } from '@slicer/client';
import { usePlatform } from '@orca/platform-contract';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { rangeOverrideKeys } from '../settings/heightRangeEditor';
import { Button } from '@/components/ui/button';
import { FilamentSlotCell } from './FilamentAssignmentCell';
import { sameBounds, selectedHeightRanges, useObjectListStore } from './useObjectListStore';
import { editRanges } from './heightRangeActions';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import layerIcon from './icons/height_range_layer.svg';
import layersIcon from './icons/height_range_modifier.svg';

export function HeightRangeRows({ object, scene, instanceId, onMenu, renderReset }: {
  object: ModelObjectStructure; scene?: SceneInteractionController | null; instanceId?: number;
  renderReset: (row: HeightRangeRow, keys: string[], label: string) => ReactNode;
  onMenu: (event: MouseEvent, rows: HeightRangeRow[]) => void;
}) {
  const { runtime } = usePlatform();
  const selection = useObjectListStore(s => s.heightRangeSelection);
  const collapsed = useObjectListStore(s => s.collapsedLayers[object.id]);
  const rack = useFilamentSessionStore(s => s.snapshot);
  const pending = useFilamentSessionStore(s => s.pendingKind !== null);
  const metadata = useSettingsStore(s => s.metadata);
  const parentHeight = useSettingsStore(s => s.nativeScopedConfig.objects[object.id]?.layer_height ??
    s.nativeScopedConfig.project.layer_height ?? s.baseValues.layer_height ?? s.metadata?.layer_height?.default);
  const anchor = useRef<HeightRangeRow | null>(null);
  const rows = object.heightRanges ?? [];
  const active = selection?.objectId === object.id;
  const selected = active ? selectedHeightRanges(object, selection) : [];
  const group = active && selection.bounds === 'all';
  function choose(bounds: HeightRangeRow[] | 'all') {
    const ownerInstance = instanceId ?? (active ? selection.instanceId : undefined);
    const index = object.instances.find(instance => instance.id === ownerInstance)?.index;
    scene?.selectComposite(object.index, undefined, index);
    useObjectListStore.getState().selectRanges(bounds === 'all' || bounds.length
      ? { objectId: object.id, instanceId: ownerInstance, bounds } : null);
  }
  function pick(row: HeightRangeRow, toggle: boolean, extend: boolean) {
    let bounds = [row];
    if (extend && anchor.current) {
      const first = rows.findIndex(r => sameBounds(r, anchor.current!)), last = rows.indexOf(row);
      if (first >= 0) bounds = rows.slice(Math.min(first, last), Math.max(first, last) + 1);
    } else {
      anchor.current = row;
      if (toggle && !group) bounds = selected.some(r => sameBounds(r, row))
        ? selected.filter(r => !sameBounds(r, row)) : [...selected, row];
    }
    choose(bounds);
  }
  return <div data-height-range-tree="" onDragStart={event => { event.preventDefault(); event.stopPropagation(); }} draggable>
    <div className="relative flex items-center">
      <Button variant="ghost" size="xs" className="object-list-row w-full justify-start pl-5"
        data-testid={`height-range-group-${object.id}`} aria-pressed={group} data-state={group ? 'selected' : 'idle'}
        onClick={() => choose('all')} onContextMenu={event => { if (!group) choose('all'); onMenu(event, rows); }}>
        <img className="mr-1 size-4" src={layersIcon} alt="" />Layers
      </Button>
      <button type="button" aria-label={collapsed ? 'Expand Layers' : 'Collapse Layers'} aria-expanded={!collapsed}
        className="absolute left-0 w-5 text-xs text-muted-foreground"
        onClick={() => useObjectListStore.getState().toggleLayersCollapsed(object.id)}>{collapsed ? '▸' : '▾'}</button>
    </div>
    {!collapsed && rows.map(row => {
      const picked = !group && selected.some(r => sameBounds(r, row));
      const keys = metadata ? rangeOverrideKeys(row, metadata, parentHeight) : [];
      const label = `Range ${row.min.toFixed(2)}-${row.max.toFixed(2)} (mm)`;
      return <div key={`${row.min}/${row.max}`} className="relative ml-4 flex items-center">
        <Button variant="ghost" size="xs" aria-pressed={picked} data-state={picked ? 'selected' : 'idle'}
          className="object-list-row w-full justify-start pl-1 pr-[4.5rem] tabular-nums"
          onClick={e => pick(row, e.ctrlKey || e.metaKey, e.shiftKey)}
          onContextMenu={event => { if (!picked) choose([row]); onMenu(event, picked ? selected : [row]); }}>
          <img className="mr-1 size-4" src={layerIcon} alt="" /><span className={`min-w-0 truncate ${keys.length ? 'text-config-override' : ''}`}>{label}</span>
        </Button>
        <div className="absolute inset-y-0 right-1 flex items-center gap-2">
          {rack && <FilamentSlotCell snapshot={rack} selectedSlot={Number(row.values.extruder ?? 0)} allowDefault pending={pending}
            testId={`range-filament-${object.id}-${row.min}-${row.max}`} label={`${label} filament`}
            onAssign={slot => {
              if (!picked) choose([row]);
              void editRanges(runtime, { objectId: object.id, targets: picked ? selected : [row], operation: 'set', key: 'extruder', value: slot }, scene);
            }} />}
          <span className="flex w-3 items-center">{keys.length > 0 && renderReset(row, keys, label)}</span>
        </div>
      </div>;
    })}
  </div>;
}
