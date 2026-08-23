import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { VolumeType } from '@slicer/client';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { Button } from '@/components/ui/button';
import { useObjectListStore } from './useObjectListStore';
import { projectSelection } from './projection';
import {
  changePartTypeInList,
  renameObjectInList,
  renamePartInList,
  setInstancePrintableInList,
  setObjectPrintableInList,
} from './actions';
import {
  assembleObjectsInList,
  cloneObjectsInList,
  deleteObjectsInList,
  deleteVolumeInList,
  separateInstancesInList,
  reorderObjectsInList,
  reorderVolumesInList,
  splitObjectToObjectsInList,
  splitVolumeToPartsInList,
} from './structuralActions';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';

const VOLUME_TYPES: VolumeType[] = [
  'model_part', 'negative_volume', 'parameter_modifier',
  'support_blocker', 'support_enforcer',
];

type RenamingTarget = { kind: 'object'; id: number } | { kind: 'part'; id: number } | null;

/**
 * The Object List tree (spec §4/§6): objects, their parts, and an Instances
 * group for multi-instance objects, rendered above the SettingsPanel. The
 * viewport SceneInteractionController is the single source of truth for
 * selection; this component is a projection + command surface. Step 7 wires the
 * non-destructive metadata actions (rename, part type, printable) through the
 * bridge via the unified post-mutation refresh in actions.ts.
 */
export function ObjectList({ sceneInteraction }: { sceneInteraction: SceneInteractionController | null }) {
  const platform = usePlatform();
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const modelRevision = useSettingsStore((s) => s.modelRevision);
  const structure = useObjectListStore((s) => s.structure);
  const loaded = useObjectListStore((s) => s.loaded);
  const expanded = useObjectListStore((s) => s.expanded);
  const projection = useObjectListStore((s) => s.projection);
  const setStructure = useObjectListStore((s) => s.setStructure);
  const setLoaded = useObjectListStore((s) => s.setLoaded);
  const setProjection = useObjectListStore((s) => s.setProjection);
  const toggleExpanded = useObjectListStore((s) => s.toggleExpanded);
  const clearStore = useObjectListStore((s) => s.clear);
  const [renaming, setRenaming] = useState<RenamingTarget>(null);
  const [draftName, setDraftName] = useState('');

  // Read the structure when the model loads or a revision bump occurs.
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

  // Two-way sync: recompute the selection projection whenever the controller
  // emits a selection change. The controller stays the source of truth.
  useEffect(() => {
    if (!sceneInteraction) return;
    const update = () => setProjection(
      projectSelection(structure, sceneInteraction.selectedVolumes().map((v) => v.buffer)),
    );
    update();
    return sceneInteraction.subscribe(update);
  }, [sceneInteraction, structure, setProjection]);

  async function commitRename() {
    if (!renaming) return;
    const name = draftName.trim();
    if (name) {
      if (renaming.kind === 'object') await renameObjectInList(platform.runtime, renaming.id, name);
      else await renamePartInList(platform.runtime, renaming.id, name);
    }
    setRenaming(null);
  }

  if (!modelLoaded || !loaded) {
    return (
      <div data-testid="object-list" className="px-2 pb-2 text-xs text-muted-foreground">
        No objects
      </div>
    );
  }

  return (
    <div data-testid="object-list" className="max-h-56 overflow-y-auto border-b px-2 py-2">
      <Button
        size="xs"
        variant="outline"
        data-testid="objectlist-assemble"
        className="mb-1 w-full"
        onClick={() => void assembleObjectsInList(platform.runtime, structure.map((o) => o.id))}
      >
        Assemble all
      </Button>
      {structure.map((obj) => {
        const objectSelected = projection.objectIds.has(obj.id);
        const isExpanded = !!expanded[obj.id];
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
          >
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="xs"
                className="flex-1 justify-start"
                data-state={objectSelected ? 'selected' : 'idle'}
                onClick={() => sceneInteraction?.selectComposite(obj.index)}
              >
                <span
                  aria-hidden
                  data-testid={`object-expand-${obj.id}`}
                  className="mr-1 text-xs"
                  onClick={(e) => { e.stopPropagation(); toggleExpanded(obj.id); }}
                >
                  {isExpanded ? '▾' : '▸'}
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
              <button
                data-testid={`object-printable-${obj.id}`}
                aria-pressed={obj.printable}
                onClick={() => void setObjectPrintableInList(platform.runtime, obj.id, !obj.printable)}
                className="rounded border px-1 text-[0.6rem]"
                title={obj.printable ? 'Printable' : 'Unprintable'}
              >
                {obj.printable ? 'P' : 'U'}
              </button>
              <button
                data-testid={`object-rename-${obj.id}`}
                onClick={() => { setRenaming({ kind: 'object', id: obj.id }); setDraftName(obj.name); }}
                className="rounded border px-1 text-[0.6rem]"
                title="Rename"
              >
                ✎
              </button>
              <button
                data-testid={`object-delete-${obj.id}`}
                onClick={() => void deleteObjectsInList(platform.runtime, [obj.id])}
                className="rounded border px-1 text-[0.6rem]"
                title="Delete"
              >
                ⌫
              </button>
              <button
                data-testid={`object-clone-${obj.id}`}
                onClick={() => void cloneObjectsInList(platform.runtime, [obj.id])}
                className="rounded border px-1 text-[0.6rem]"
                title="Clone"
              >
                ⧉
              </button>
              <button
                data-testid={`object-split-objects-${obj.id}`}
                onClick={() => void splitObjectToObjectsInList(platform.runtime, obj.id)}
                className="rounded border px-1 text-[0.6rem]"
                title="Split to objects"
              >
                ⤢
              </button>
              <button
                data-testid={`object-separate-${obj.id}`}
                onClick={() => void separateInstancesInList(platform.runtime, obj.id, obj.instances.map((i) => i.id))}
                className="rounded border px-1 text-[0.6rem]"
                title="Separate instances"
              >
                ⊞
              </button>
            </div>
            {isExpanded && (
              <div className="ml-4">
                {obj.volumes.map((vol) => (
                  <div
                    key={vol.id}
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
                  >
                    <Button
                      variant="ghost"
                      size="xs"
                      className="flex-1 justify-start pl-5"
                      data-state={projection.volumeIds.has(vol.id) ? 'selected' : 'idle'}
                      onClick={() => sceneInteraction?.selectComposite(obj.index, vol.index)}
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
                    <select
                      data-testid={`part-type-${vol.id}`}
                      value={vol.type}
                      onChange={(e) => void changePartTypeInList(platform.runtime, vol.id, e.target.value as VolumeType)}
                      className="h-5 rounded border bg-background px-0.5 text-[0.6rem]"
                    >
                      {VOLUME_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <button
                      data-testid={`part-rename-${vol.id}`}
                      onClick={() => { setRenaming({ kind: 'part', id: vol.id }); setDraftName(vol.name); }}
                      className="rounded border px-1 text-[0.6rem]"
                      title="Rename"
                    >
                      ✎
                    </button>
                    <button
                      data-testid={`part-split-${vol.id}`}
                      onClick={() => void splitVolumeToPartsInList(platform.runtime, vol.id)}
                      className="rounded border px-1 text-[0.6rem]"
                      title="Split to parts"
                    >
                      ⤢
                    </button>
                    <button
                      data-testid={`part-delete-${vol.id}`}
                      onClick={() => void deleteVolumeInList(platform.runtime, vol.id)}
                      className="rounded border px-1 text-[0.6rem]"
                      title="Delete part"
                    >
                      ⌫
                    </button>
                  </div>
                ))}
                {obj.instanceCount > 1 && (
                  <div data-testid={`instances-${obj.id}`} className="border-l pl-2">
                    <div className="px-2 py-1 text-[0.65rem] text-muted-foreground">Instances</div>
                    {obj.instances.map((inst) => (
                      <div key={inst.id} className="flex items-center gap-0.5">
                        <Button
                          size="xs"
                          variant="ghost"
                          className="flex-1 justify-start pl-5"
                          data-state={projection.instanceIds.has(inst.id) ? 'selected' : 'idle'}
                          onClick={() => sceneInteraction?.selectComposite(obj.index, undefined, inst.index)}
                        >
                          {`Instance ${inst.index + 1}`}
                        </Button>
                        <button
                          data-testid={`instance-printable-${inst.id}`}
                          aria-pressed={inst.printable}
                          onClick={() => void setInstancePrintableInList(platform.runtime, inst.id, !inst.printable)}
                          className="rounded border px-1 text-[0.6rem]"
                          title={inst.printable ? 'Printable' : 'Unprintable'}
                        >
                          {inst.printable ? 'P' : 'U'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
