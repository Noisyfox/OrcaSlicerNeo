import { useRef } from 'react';
import type { ModelObjectStructure, HeightRangeRow } from '@slicer/client';
import { usePlatform } from '@orca/platform-contract';
import { useProjectStore } from '@/stores/useProjectStore';
import { Button } from '@/components/ui/button';
import { sameBounds, selectedHeightRanges, useObjectListStore } from './useObjectListStore';
import { editRanges } from './heightRangeActions';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';

export function HeightRangeRows({ object, scene, instanceId }: { object: ModelObjectStructure; scene?: SceneInteractionController | null; instanceId?: number }) {
  const { runtime } = usePlatform();
  const selection = useObjectListStore(s => s.heightRangeSelection);
  const select = useObjectListStore(s => s.selectRanges);
  const copy = useObjectListStore(s => s.copyRanges);
  const anchor = useRef<HeightRangeRow | null>(null);
  const rows = object.heightRanges ?? [];
  const active = selection?.objectId === object.id;
  const selected = active ? selectedHeightRanges(object, selection) : [];
  const group = active && selection.bounds === 'all';
  function choose(bounds: HeightRangeRow[] | 'all') {
    const ownerInstance = instanceId ?? (active ? selection.instanceId : undefined);
    const index = object.instances.find(instance => instance.id === ownerInstance)?.index;
    scene?.selectComposite(object.index, undefined, index);
    select(bounds === 'all' || bounds.length ? { objectId: object.id, instanceId: ownerInstance, bounds } : null);
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
  return <div className="ml-4 text-xs" draggable onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}>
    <button type="button" data-testid={`height-range-group-${object.id}`} aria-pressed={group}
      className="w-full rounded px-2 py-1 text-left font-medium aria-pressed:bg-accent"
      onClick={() => choose('all')}>Height Range Modifier</button>
    {rows.map(row => <div key={`${row.min},${row.max}`} className="ml-2 flex items-center">
      <button type="button" aria-pressed={!group && selected.some(r => sameBounds(r, row))}
        className="flex-1 rounded px-2 text-left tabular-nums aria-pressed:bg-accent"
        onClick={e => pick(row, e.ctrlKey || e.metaKey, e.shiftKey)}>{row.min} – {row.max} mm</button>
      <Button variant="ghost" size="xs" aria-label={`Add range after ${row.max} mm`}
        onClick={() => void editRanges(runtime, { objectId: object.id, operation: 'append', targets: [row] }, scene, instanceId)}>+</Button>
    </div>)}
    {active && <div className="ml-2 flex gap-1">
      <Button size="xs" variant="ghost" onClick={() => copy(useProjectStore.getState().projectGeneration, selected)}>Copy ranges</Button>
      <Button size="xs" variant="ghost" onClick={() => void editRanges(runtime, { objectId: object.id, operation: 'remove', targets: selected }, scene)}>Delete ranges</Button>
    </div>}
  </div>;
}
