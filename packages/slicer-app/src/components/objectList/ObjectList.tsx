import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
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
  const collapsedInstances = useObjectListStore((s) => s.collapsedInstances);
  const projection = useObjectListStore((s) => s.projection);
  const setStructure = useObjectListStore((s) => s.setStructure);
  const setLoaded = useObjectListStore((s) => s.setLoaded);
  const setProjection = useObjectListStore((s) => s.setProjection);
  const toggleExpanded = useObjectListStore((s) => s.toggleExpanded);
  const toggleInstancesCollapsed = useObjectListStore((s) => s.toggleInstancesCollapsed);
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
      projectSelection(structure, sceneInteraction.selectedVolumes().map((v) => v.buffer)),
    );
    update();
    return sceneInteraction.subscribe(update);
  }, [sceneInteraction, structure, setProjection]);

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

  /** Row click with multi-select: Ctrl/Cmd toggles the row; Shift selects a
   *  contiguous range from the previous (non-shift) selection to this row. */
  function handleRowClick(row: SelectableRow, ctrl: boolean, shift: boolean) {
    if (!sceneInteraction) return;
    if (shift && lastSelectedKey) {
      const lastIndex = flatRows.findIndex((r) => r.key === lastSelectedKey);
      const rowIndex = flatRows.findIndex((r) => r.key === row.key);
      if (lastIndex >= 0 && rowIndex >= 0) {
        const lo = Math.min(lastIndex, rowIndex);
        const hi = Math.max(lastIndex, rowIndex);
        const ids = flatRows.slice(lo, hi + 1).flatMap((r) => r.volumeIds);
        sceneInteraction.selectVolumeIds(ids, ctrl);
        // Keep the anchor so a repeated Shift extends from the same start.
        return;
      }
    }
    sceneInteraction.selectComposite(
      row.target.objectIdx,
      row.target.volumeIdx,
      row.target.instanceIdx,
      ctrl,
    );
    setLastSelectedKey(row.key);
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
      onContextMenu={(e) => { if (e.target === e.currentTarget) openContextMenu(e, { kind: 'list' }); }}>
      {structure.map((obj) => {
        const objectSelected = projection.objectIds.has(obj.id);
        const hasExpandable = obj.volumes.length > 1 || obj.instanceCount > 1;
        const isExpanded = hasExpandable && !!expanded[obj.id];
        return (
          <div
            key={obj.id}
            data-testid={`object-${obj.id}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'object', id: obj.id }));
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              let dragged: { kind: string; id: number } | null = null;
              try { dragged = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { /* ignore */ }
              if (dragged?.kind === 'object' && dragged.id !== obj.id) {
                void reorderObjectsInList(platform.runtime, dragged.id, obj.id);
              }
            }}
            onContextMenu={(e) => openContextMenu(e, { kind: 'object', object: obj })}
          >
            <Button
              variant="ghost"
              size="xs"
              className={`w-full justify-start ${objectSelected ? 'bg-accent text-accent-foreground' : ''}`}
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
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'part', objectId: obj.id, id: vol.id }));
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      let dragged: { kind: string; objectId: number; id: number } | null = null;
                      try { dragged = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { /* ignore */ }
                      if (dragged?.kind === 'part' && dragged.objectId === obj.id && dragged.id !== vol.id) {
                        void reorderVolumesInList(platform.runtime, obj.id, dragged.id, vol.id);
                      }
                    }}
                    onContextMenu={(e) => { e.stopPropagation(); openContextMenu(e, { kind: 'part', object: obj, volume: vol }); }}
                  >
                    <Button
                      variant="ghost"
                      size="xs"
                      className={`flex-1 justify-start pl-5 ${projection.volumeIds.has(vol.id) ? 'bg-accent text-accent-foreground' : ''}`}
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
                    <button
                      type="button"
                      data-testid={`instances-toggle-${obj.id}`}
                      onClick={() => toggleInstancesCollapsed(obj.id)}
                      onContextMenu={(e) => e.stopPropagation()}
                      className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-[0.65rem] text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent"
                    >
                      <span aria-hidden className="text-xs">{collapsedInstances[obj.id] ? '▸' : '▾'}</span>
                      Instances
                    </button>
                    {!collapsedInstances[obj.id] && obj.instances.map((inst) => (
                      <div
                        key={inst.id}
                        data-testid={`instance-${inst.id}`}
                        className="flex items-center gap-0.5"
                        onContextMenu={(e) => { e.stopPropagation(); openContextMenu(e, { kind: 'instance', object: obj, instance: inst }); }}
                      >
                        <Button
                          size="xs"
                          variant="ghost"
                          className={`flex-1 justify-start pl-5 ${projection.instanceIds.has(inst.id) ? 'bg-accent text-accent-foreground' : ''}`}
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
