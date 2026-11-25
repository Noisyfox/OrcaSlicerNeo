import { useLayoutEffect, useRef, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { HeightRangeRow, ModelObjectStructure } from '@slicer/client';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { editRanges } from './heightRangeActions';
import { sameBounds, selectedHeightRanges, useObjectListStore, type HeightRangeSelection } from './useObjectListStore';
import layerIcon from './icons/height_range_layer.svg';

type Endpoint = 'min' | 'max';
type Draft = { row: HeightRangeRow; endpoint: Endpoint; text: string };
type CommitResult = { from: HeightRangeRow; to: HeightRangeRow } | undefined;

function EndpointInput({ row, endpoint, submit, clearError }: {
  row: HeightRangeRow; endpoint: Endpoint; submit: (draft: Draft) => void; clearError: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const cancel = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const { min, max } = row;
  useLayoutEffect(() => {
    if (input.current === document.activeElement) useObjectListStore.getState().focusRange({ min, max, endpoint });
  }, [min, max, endpoint]);
  return <label className="flex h-6 min-w-0 flex-1 items-center rounded-sm bg-control-background focus-within:ring-1 focus-within:ring-ring">
    <Input ref={input} aria-label={endpoint === 'min' ? 'Start (mm)' : 'End (mm)'} inputMode="decimal"
      value={draft?.text ?? String(row[endpoint])}
      className="h-6 min-w-0 flex-1 border-0 bg-transparent px-1.5 text-xs tabular-nums focus-visible:ring-0 md:text-xs dark:bg-transparent"
      onFocus={() => { useObjectListStore.getState().focusRange({ min: row.min, max: row.max, endpoint }); clearError(); }}
      onChange={event => setDraft({ row, endpoint, text: event.currentTarget.value })}
      onBlur={() => {
        useObjectListStore.getState().focusRange(null);
        if (draft && !cancel.current) submit(draft);
        cancel.current = false;
        setDraft(null);
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); cancel.current = true; }
        else if (event.key !== 'Enter') return;
        event.preventDefault(); event.currentTarget.blur();
      }} />
    <span aria-hidden className="pr-1 text-[10px] text-muted-foreground">mm</span>
  </label>;
}

/** The group edits every interval in native order. A selected leaf has just its own two boxes. */
export function HeightRangeBoundsEditor({ object, selection, scene }: {
  object: ModelObjectStructure; selection: HeightRangeSelection; scene: SceneInteractionController | null;
}) {
  const { runtime } = usePlatform();
  const group = selection.bounds === 'all';
  const rows = selectedHeightRanges(object, selection);
  const [error, setError] = useState('');
  const clearError = () => setError('');
  const pending = useRef<Promise<CommitResult> | null>(null);
  const container = useRef<HTMLDivElement>(null);

  async function save({ row, endpoint, text }: Draft): Promise<CommitResult> {
    const raw = text.trim().replace(',', '.');
    const value = raw === '.' ? 0 : Number(raw);
    if ((raw !== '.' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) || !Number.isFinite(value) || value < 0)
      throw new Error('Enter a non-negative height in millimetres.');
    if (value === row[endpoint]) return;
    const result = await editRanges(runtime, { operation: endpoint, objectId: object.id, targets: [row], value }, scene);
    if (!result.ok) throw new Error(result.error);
    const bounds = result.selection[0];
    const to = useObjectListStore.getState().structure.find(o => o.id === object.id)?.heightRanges
      ?.find(r => bounds && sameBounds(r, bounds));
    if (!to) throw new Error('Height range is no longer available.');
    return { from: row, to };
  }

  // Blur and a row button can be part of the same gesture. Resolve the edited
  // map key and revision before applying the button to that interval.
  function submit(current: Draft) {
    const previous = pending.current;
    const task = previous ? previous.then(edit => save(edit && sameBounds(edit.from, current.row)
      ? { ...current, row: edit.to } : current)) : save(current);
    pending.current = task;
    void task.catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => { if (pending.current === task) pending.current = null; });
  }

  async function act(row: HeightRangeRow, operation: 'remove' | 'append') {
    try {
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement && container.current?.contains(focused)) focused.blur();
      const edit = await pending.current;
      const target = edit && sameBounds(edit.from, row) ? edit.to : row;
      const result = await editRanges(runtime, { objectId: object.id, operation, targets: [target] }, scene);
      if (!result.ok) throw new Error(result.error);
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  if (!group && rows.length !== 1) return null;
  // A native endpoint move preserves the ModelConfig timestamp. This keeps a
  // tabbed-to input mounted even when the sorted row changes position.
  const revisions = new Set<number>();
  const sharedRevisions = new Set<number>();
  for (const row of rows) {
    if (revisions.has(row.revision)) sharedRevisions.add(row.revision);
    revisions.add(row.revision);
  }
  return <div ref={container} role="group" aria-label="Height ranges" className={group ? 'mx-2 min-h-0 overflow-y-auto' : ''}>
    {rows.map(row => <div key={sharedRevisions.has(row.revision) ? `${row.min}/${row.max}` : row.revision} role="group" aria-label={`Range ${row.min} to ${row.max} mm`}
      className="flex min-h-8 items-center gap-1">
      <img src={layerIcon} alt="" className="size-4 shrink-0" /><span className="mr-1 text-xs">Range</span>
      <EndpointInput row={row} endpoint="min" submit={submit} clearError={clearError} />
      <span aria-hidden>–</span>
      <EndpointInput row={row} endpoint="max" submit={submit} clearError={clearError} />
      {group && (['remove', 'append'] as const).map(operation => {
        const remove = operation === 'remove';
        const label = remove ? 'Remove height range' : 'Add height range';
        return <Button key={operation} size="icon-xs" variant="ghost" aria-label={label} title={label}
          onMouseDown={event => event.preventDefault()} onClick={() => void act(row, operation)}>
          {remove ? <Trash2 /> : <Plus />}
        </Button>;
      })}
    </div>)}
    {error && <div role="alert" className="text-xs text-destructive">{error}</div>}
  </div>;
}
