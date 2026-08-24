import { useEffect, useMemo, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { ModelObjectStructure } from '@slicer/client';
import { usePlatform } from '@orca/platform-contract';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { Button } from '@/components/ui/button';
import { useObjectListStore } from './useObjectListStore';
import { buildSelectableRows, projectSelection, type SelectableRow } from './projection';
import { renameObjectInList, renamePartInList } from './actions';
import { reorderObjectsInList, reorderVolumesInList } from './structuralActions';
import { ObjectListContextMenu, type ObjectListCtxTarget } from './ObjectListContextMenu';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';

type RenamingTarget = { kind: 'object'; id: number } | { kind: 'part'; id: number } | null;

/**
 * The Object List tree (spec §4/§6): objects, their parts, and an Instances
 * group for multi-instance objects, rendered above the SettingsPanel. The
 * viewport SceneInteractionController is the single source of truth for
 * selection; this component is a projection + command surface. Row actions
 * (rename, type, printable, delete, clone, split, assemble, separate) live in a
 * right-click context menu, mirroring the scene context menu.
 */
export function ObjectList({ sceneInteraction }: { sceneInteraction: SceneInteractionController | null }) {
  const platform = usePlatform();
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const modelRevision = useSettingsStore((s) => s.modelRevision);
  const structure = useObjectListStore((s) => s.structure);
  const loaded = useObjectListStore((s) => s.loaded);
  const expanded = useObjectListStore((s) => s.expanded);
  const highlightLevel = useObjectListStore((s) => s.highlightLevel);
  const collapsedInstances = useObjectListStore((s) => s.collapsedInstances);
  const projection = useObjectListStore((s) => s.projection);
  const setStructure = useObjectListStore((s) => s.setStructure);
  const setLoaded = useObjectListStore((s) => s.setLoaded);
  const setProjection = useObjectListStore((s) => s.setProjection);
  const toggleExpanded = useObjectListStore((s) => s.toggleExpanded);
  const toggleInstancesCollapsed = useObjectListStore((s) => s.toggleInstancesCollapsed);
  const setHighlightLevel = useObjectListStore((s) => s.setHighlightLevel);
  const clearStore = useObjectListStore((s) => s.clear);
  const [renaming, setRenaming] = useState<RenamingTarget>(null);
  const [draftName, setDraftName] = useState('');
  const [ctx, setCtx] = useState<{ target: ObjectListCtxTarget; point: { x: number; y: number } } | null>(null);
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
  const flatRows = useMemo(() => buildSelectableRows(structure), [structure]);

  useEffect(() => {
    let disposed = false;
    if (!modelLoaded) {
      clearStore();
      return;
    }
    (async () => {
      const r = await platform.runtime.getModelStructure();
      if (disposed) return;
      if (r.ok && r.objects) {
        setStructure(r.objects);
        setLoaded(true);
      } else {
        clearStore();
      }
    })();
    return () => { disposed = true; };
  }, [modelLoaded, modelRevision, platform.runtime, setStructure, setLoaded, clearStore]);

  useEffect(() => {
    if (!sceneInteraction) return;
    const update = () => setProjection(
      projectSelection(structure, sceneInteraction.selectedVolumes().map((v) => v.buffer), highlightLevel),
    );
    update();
    return sceneInteraction.subscribe(update);
  }, [sceneInteraction, structure, highlightLevel, setProjection]);

  useEffect(() => {
    if (!ctx) return;
    const onPointerDown = (event: PointerEvent) => {
      const el = event.target as Node;
      if (el instanceof Element && el.closest('[data-testid="objectlist-ctx-menu"]')) return;
      setCtx(null);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setCtx(null); };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown, true); document.removeEventListener('keydown', onKeyDown); };
  }, [ctx]);

  function openContextMenu(event: ReactMouseEvent, target: ObjectListCtxTarget) {
    event.preventDefault();
    setCtx({ target, point: { x: event.clientX, y: event.clientY } });
  }

  async function commitRename() {
    if (!renaming) return;
    const name = draftName.trim();
    if (name) {
      if (renaming.kind === 'object') await renameObjectInList(platform.runtime, renaming.id, name);
      else await renamePartInList(platform.runtime, renaming.id, name);
    }
    setRenaming(null);
  }

  const startRename = (kind: 'object' | 'part', id: number, currentName: string) => {
    setRenaming({ kind, id });
    setDraftName(currentName);
  };

  /** The volume IDs a row selects, re-anchoring a part row to the selection's
   *  single instance (Orca: a part is never selected across all instances). */
  function rowVolumeIds(row: SelectableRow, anchor: number): string[] {
    if (row.kind === 'part') return [`${row.target.objectIdx}:${row.target.volumeIdx}:${anchor}`];
    return row.volumeIds;
  }

  /** A multi-select range is valid (type-homogeneous, like Orca) only when all
   *  rows share the same kind, and part rows all belong to one object (so they
   *  stay within one instance's parts — MultipleVolume). Anything else is Orca's
   *  `Mixed` and must be refused. */
  function isHomogeneousRange(rows: SelectableRow[]): boolean {
    const kinds = new Set(rows.map((r) => r.kind));
    if (kinds.size !== 1) return false;
    if (rows[0].kind === 'part')
      return new Set(rows.map((r) => r.target.objectIdx)).size === 1;
    return true;
  }

  /** Ctrl toggle of a row is allowed only if it keeps the selection homogeneous —
   *  guarded by the controller (shared with the viewport). */
  function canToggleRow(row: SelectableRow, anchor: number): boolean {
    if (!sceneInteraction) return true;
    return sceneInteraction.canToggleVolumeIds(rowVolumeIds(row, anchor));
  }

  /** Shift+Ctrl union of `rows` is allowed only if the range is homogeneous and
   *  adding it keeps the selection homogeneous. */
  function canUnionRows(rows: SelectableRow[], anchor: number): boolean {
    if (!sceneInteraction) return false;
    if (!isHomogeneousRange(rows)) return false;
    return sceneInteraction.canAddVolumeIds(rows.flatMap((r) => rowVolumeIds(r, anchor)));
  }

  /** Row click with multi-select: Ctrl/Cmd toggles the row; Shift selects a
   *  contiguous range from the previous (non-shift) selection to this row. */
  function handleRowClick(row: SelectableRow, ctrl: boolean, shift: boolean) {
    if (!sceneInteraction) return;
    setHighlightLevel(row.target.objectIdx, row.kind);
    const anchor = sceneInteraction.getSelectionInstanceAnchor(row.target.objectIdx);
    if (shift && lastSelectedKey) {
      const lastIndex = flatRows.findIndex((r) => r.key === lastSelectedKey);
      const rowIndex = flatRows.findIndex((r) => r.key === row.key);
      if (lastIndex >= 0 && rowIndex >= 0) {
        const lo = Math.min(lastIndex, rowIndex);
        const hi = Math.max(lastIndex, rowIndex);
        const range = flatRows.slice(lo, hi + 1);
        if (ctrl ? !canUnionRows(range, anchor) : !isHomogeneousRange(range))
          // Invalid range, or a union that would create an invalid mix — refuse.
          return;
        const ids = range.flatMap((r) => rowVolumeIds(r, anchor));
        sceneInteraction.selectVolumeIds(ids, ctrl);
        // Keep the anchor so a repeated Shift extends from the same start.
        return;
      }
    }
    if (ctrl && !canToggleRow(row, anchor)) {
      // Ctrl+click that would create an invalid mix (Orca Mixed) — refuse.
      return;
    }
    sceneInteraction.selectComposite(
      row.target.objectIdx,
      row.target.volumeIdx,
      row.kind === 'part' ? anchor : row.target.instanceIdx,
      ctrl,
    );
    setLastSelectedKey(row.key);
  }

  /** Clicking the Instances group line selects every instance of the object
   *  (an instance is a full object at that level) and highlights them as the
   *  Instances group rather than collapsing the list. */
  function handleInstancesGroupClick(obj: ModelObjectStructure, ctrl: boolean) {
    if (!sceneInteraction) return;
    setHighlightLevel(obj.index, 'instances');
    sceneInteraction.selectComposite(obj.index, undefined, undefined, ctrl);
    // The group has no single-row anchor; clear the Shift range start.
    setLastSelectedKey(null);
  }

  /** The row's target volumes are already fully selected (the row shows
   *  highlighted)? Mirrors the scene's right-click guard, which keeps the
   *  selection when the clicked volume is already selected. */
  function rowFullySelected(row: SelectableRow, anchor: number): boolean {
    if (!sceneInteraction) return true;
    const ids = rowVolumeIds(row, anchor);
    if (ids.length === 0) return true;
    const selected = sceneInteraction.selectedVolumes();
    return ids.every((id) => selected.some((v) => v.id === id));
  }

  /** The context menu follows the selection, not the clicked line. When the
   *  clicked row is already part of the selection, promote the menu to the
   *  selection's most-relative fully-selected level: a fully-selected object
   *  (however it was selected — object row, Instances group, or scene) opens
   *  the object menu even when the click landed on one of its part/instance
   *  rows, and a fully-selected instance opens the instance menu from one of
   *  its part rows. Only when the right-click just replaced the selection with
   *  the row's own target (unselected row) does the menu stay row-scoped. */
  function selectionMenuTarget(row: SelectableRow, anchor: number): ObjectListCtxTarget | null {
    const obj = structure.find((o) => o.index === row.target.objectIdx);
    if (!obj || !sceneInteraction) return null;
    const selectedIds = sceneInteraction.selectedVolumes().map((v) => v.id);
    const objRow = flatRows.find((r) => r.kind === 'object' && r.target.objectIdx === obj.index);
    if (objRow && rowVolumeIds(objRow, 0).every((id) => selectedIds.includes(id)))
      return { kind: 'object', object: obj };
    if (row.kind === 'instance' && row.target.instanceIdx !== undefined) {
      const instance = obj.instances[row.target.instanceIdx];
      if (instance) return { kind: 'instance', object: obj, instance };
    }
    if (projection.instanceIds.size > 0) {
      const instance = obj.instances[anchor];
      if (instance) return { kind: 'instance', object: obj, instance };
    }
    if (row.kind === 'part' && row.target.volumeIdx !== undefined) {
      const volume = obj.volumes[row.target.volumeIdx];
      if (volume) return { kind: 'part', object: obj, volume };
    }
    return null;
  }

  /** Right-click selection, matching the scene (a scene right-click selects the
   *  clicked instance unless the clicked volume is already selected). At row
   *  granularity: select the row's target exactly like a left-click would, but
   *  leave the selection untouched when the row is already fully selected — a
   *  right-click never collapses a multi-selection. The menu opens afterwards
   *  (via `openContextMenu`) so its items see the freshly selected state. */
  function handleRowContextMenu(event: ReactMouseEvent, row: SelectableRow, target: ObjectListCtxTarget) {
    if (sceneInteraction) {
      const anchor = sceneInteraction.getSelectionInstanceAnchor(row.target.objectIdx);
      if (!rowFullySelected(row, anchor)) {
        setHighlightLevel(row.target.objectIdx, row.kind);
        sceneInteraction.selectComposite(
          row.target.objectIdx,
          row.target.volumeIdx,
          row.kind === 'part' ? anchor : row.target.instanceIdx,
          false,
        );
        setLastSelectedKey(row.key);
      } else {
        // The row is already part of the selection — the menu is the
        // selection's, not the clicked line's (a fully-selected object opens
        // the object menu wherever the click lands inside it).
        target = selectionMenuTarget(row, anchor) ?? target;
      }
    }
    openContextMenu(event, target);
  }

  /** Dropping onto the list's empty space (below the last row) moves the dragged
   *  object or part to the END of its list. Row drops are handled (and their
   *  propagation stopped) by the row itself and never reach here. */
  function handleListDropToEnd(event: ReactDragEvent) {
    event.preventDefault();
    let dragged: { kind?: string; objectId?: number; id?: number } | null = null;
    try { dragged = JSON.parse(event.dataTransfer.getData('text/plain')); } catch { /* ignore */ }
    if (dragged?.kind === 'object' && dragged.id !== undefined) {
      void reorderObjectsInList(platform.runtime, dragged.id, structure.length);
    } else if (dragged?.kind === 'part' && dragged.objectId !== undefined && dragged.id !== undefined) {
      const obj = structure.find((o) => o.id === dragged.objectId);
      if (obj) void reorderVolumesInList(platform.runtime, dragged.objectId, dragged.id, obj.volumes.length);
    }
  }

  if (!modelLoaded || !loaded) {
    return (
      <div data-testid="object-list" onContextMenu={(e) => openContextMenu(e, { kind: 'list' })} className="px-2 pb-2 text-xs text-muted-foreground">
        No objects
      </div>
    );
  }

  return (
    <div data-testid="object-list" className="max-h-56 overflow-y-auto border-b px-2 py-2"
      onContextMenu={(e) => { if (e.target === e.currentTarget) openContextMenu(e, { kind: 'list' }); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleListDropToEnd}>
      {structure.map((obj) => {
        const objectSelected = projection.objectIds.has(obj.id);
        const hasExpandable = obj.volumes.length > 1 || obj.instanceCount > 1;
        const isExpanded = hasExpandable && !!expanded[obj.id];
        const renamingObject = renaming?.kind === 'object' && renaming.id === obj.id;
        // A part row's native drag source is its nearest draggable ancestor —
        // the enclosing object row. Renaming a part must therefore freeze the
        // object row too, or the part drag silently reorders the object.
        const renamingPartInObject = renaming?.kind === 'part' && obj.volumes.some((vol) => vol.id === renaming.id);
        return (
          <div
            key={obj.id}
            data-testid={`object-${obj.id}`}
            draggable={!(renamingObject || renamingPartInObject)}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'object', id: obj.id }));
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.stopPropagation();
              e.preventDefault();
              let dragged: { kind: string; id: number } | null = null;
              try { dragged = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { /* ignore */ }
              if (dragged?.kind === 'object' && dragged.id !== obj.id) {
                void reorderObjectsInList(platform.runtime, dragged.id, obj.index);
              }
            }}
            onContextMenu={(e) => {
              const row = flatRows.find((r) => r.key === `obj:${obj.index}`);
              if (row) handleRowContextMenu(e, row, { kind: 'object', object: obj });
            }}
          >
            <Button
              variant="ghost"
              size="xs"
              className={`w-full justify-start ${objectSelected ? 'bg-accent text-accent-foreground data-[state=selected]:hover:bg-accent/85' : ''}`}
              data-state={objectSelected ? 'selected' : 'idle'}
              onClick={(e) => {
                const row = flatRows.find((r) => r.key === `obj:${obj.index}`);
                if (row) handleRowClick(row, e.ctrlKey || e.metaKey, e.shiftKey);
              }}
            >
              <span
                aria-hidden
                data-testid={hasExpandable ? `object-expand-${obj.id}` : undefined}
                className="mr-1 inline-block w-3 shrink-0 text-center text-xs"
                onClick={hasExpandable ? (e) => { e.stopPropagation(); toggleExpanded(obj.id); } : undefined}
              >
                {hasExpandable ? (isExpanded ? '▾' : '▸') : ''}
              </span>
              {renaming?.kind === 'object' && renaming.id === obj.id ? (
                <input
                  data-testid={`object-name-input-${obj.id}`}
                  value={draftName}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); }}
                  className="w-32 rounded border bg-background px-1 text-xs"
                />
              ) : obj.name}
            </Button>
            {isExpanded && (
              <div className="ml-4">
                {obj.volumes.length > 1 && obj.volumes.map((vol) => (
                  <div
                    key={vol.id}
                    data-testid={`part-${vol.id}`}
                    className="flex items-center gap-0.5"
                    draggable={!(renaming?.kind === 'part' && renaming.id === vol.id)}
                    onDragStart={(e) => {
                      e.stopPropagation();
                      e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'part', objectId: obj.id, id: vol.id }));
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      let dragged: { kind: string; objectId: number; id: number } | null = null;
                      try { dragged = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { /* ignore */ }
                      if (dragged?.kind === 'part' && dragged.objectId === obj.id && dragged.id !== vol.id) {
                        void reorderVolumesInList(platform.runtime, obj.id, dragged.id, vol.index);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.stopPropagation();
                      const row = flatRows.find((r) => r.key === `vol:${obj.index}:${vol.index}`);
                      if (row) handleRowContextMenu(e, row, { kind: 'part', object: obj, volume: vol });
                    }}
                  >
                    <Button
                      variant="ghost"
                      size="xs"
                      className={`flex-1 justify-start pl-5 ${projection.volumeIds.has(vol.id) ? 'bg-accent text-accent-foreground data-[state=selected]:hover:bg-accent/85' : ''}`}
                      data-state={projection.volumeIds.has(vol.id) ? 'selected' : 'idle'}
                      onClick={(e) => {
                        const row = flatRows.find((r) => r.key === `vol:${obj.index}:${vol.index}`);
                        if (row) handleRowClick(row, e.ctrlKey || e.metaKey, e.shiftKey);
                      }}
                    >
                      {renaming?.kind === 'part' && renaming.id === vol.id ? (
                        <input
                          data-testid={`part-name-input-${vol.id}`}
                          value={draftName}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setDraftName(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); }}
                          className="w-28 rounded border bg-background px-1 text-xs"
                        />
                      ) : vol.name}
                    </Button>
                  </div>
                ))}
                {obj.instanceCount > 1 && (
                  <div data-testid={`instances-${obj.id}`} className="border-l pl-2">
                    <Button
                      size="xs"
                      variant="ghost"
                      data-testid={`instances-select-${obj.id}`}
                      onContextMenu={(e) => {
                        // Select all instances like the group's click does
                        // (guarded like the rows: never collapse a selection
                        // that already holds them), then open the selection's
                        // menu — with the whole object selected that is the
                        // object menu, as for one of its instance rows.
                        e.stopPropagation();
                        if (!sceneInteraction) return;
                        const objRow = flatRows.find((r) => r.key === `obj:${obj.index}`);
                        if (objRow && !rowFullySelected(objRow, 0)) {
                          setHighlightLevel(obj.index, 'instances');
                          sceneInteraction.selectComposite(obj.index, undefined, undefined, false);
                          setLastSelectedKey(null);
                        }
                        openContextMenu(e, { kind: 'object', object: obj });
                      }}
                      className={`w-full justify-start ${obj.instances.every((inst) => projection.instanceIds.has(inst.id)) ? 'bg-accent text-accent-foreground data-[state=selected]:hover:bg-accent/85' : ''}`}
                      data-state={obj.instances.every((inst) => projection.instanceIds.has(inst.id)) ? 'selected' : 'idle'}
                      onClick={(e) => handleInstancesGroupClick(obj, e.ctrlKey || e.metaKey)}
                    >
                      <span
                        aria-hidden
                        data-testid={`instances-toggle-${obj.id}`}
                        className="mr-1 inline-block w-3 shrink-0 text-center text-xs"
                        onClick={(e) => { e.stopPropagation(); toggleInstancesCollapsed(obj.id); }}
                      >
                        {collapsedInstances[obj.id] ? '▸' : '▾'}
                      </span>
                      Instances
                    </Button>
                    {!collapsedInstances[obj.id] && obj.instances.map((inst) => (
                      <div
                        key={inst.id}
                        data-testid={`instance-${inst.id}`}
                        className="flex items-center gap-0.5"
                        onContextMenu={(e) => {
                          e.stopPropagation();
                          const row = flatRows.find((r) => r.key === `inst:${obj.index}:${inst.index}`);
                          if (row) handleRowContextMenu(e, row, { kind: 'instance', object: obj, instance: inst });
                        }}
                      >
                        <Button
                          size="xs"
                          variant="ghost"
                          className={`flex-1 justify-start pl-5 ${projection.instanceIds.has(inst.id) ? 'bg-accent text-accent-foreground data-[state=selected]:hover:bg-accent/85' : ''}`}
                          data-state={projection.instanceIds.has(inst.id) ? 'selected' : 'idle'}
                          onClick={(e) => {
                            const row = flatRows.find((r) => r.key === `inst:${obj.index}:${inst.index}`);
                            if (row) handleRowClick(row, e.ctrlKey || e.metaKey, e.shiftKey);
                          }}
                        >
                          {`Instance ${inst.index + 1}`}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {ctx && (
        <ObjectListContextMenu target={ctx.target} point={ctx.point} onClose={() => setCtx(null)} onRename={startRename} />
      )}
    </div>
  );
}
