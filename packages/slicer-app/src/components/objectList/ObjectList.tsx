import { useEffect } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { Button } from '@/components/ui/button';
import { useObjectListStore } from './useObjectListStore';
import { projectSelection } from './projection';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';

/**
 * The Object List tree (spec §4/§6): objects, their parts, and an Instances
 * group for multi-instance objects, rendered above the SettingsPanel. The
 * viewport SceneInteractionController is the single source of truth for
 * selection; this component is a projection + command surface.
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

  if (!modelLoaded || !loaded) {
    return (
      <div data-testid="object-list" className="px-2 pb-2 text-xs text-muted-foreground">
        No objects
      </div>
    );
  }

  return (
    <div data-testid="object-list" className="max-h-56 overflow-y-auto border-b px-2 py-2">
      {structure.map((obj) => {
        const objectSelected = projection.objectIds.has(obj.id);
        const isExpanded = !!expanded[obj.id];
        return (
          <div key={obj.id} data-testid={`object-${obj.id}`}>
            <Button
              variant="ghost"
              size="xs"
              className="w-full justify-start"
              data-state={objectSelected ? 'selected' : 'idle'}
              onClick={() => sceneInteraction?.selectComposite(obj.index)}
            >
              <span aria-hidden className="mr-1 text-xs" onClick={() => toggleExpanded(obj.id)}>
                {isExpanded ? '▾' : '▸'}
              </span>
              {obj.name}
            </Button>
            {isExpanded && (
              <div className="ml-4">
                {obj.volumes.map((vol) => (
                  <Button
                    key={vol.id}
                    variant="ghost"
                    size="xs"
                    className="w-full justify-start pl-5"
                    data-state={projection.volumeIds.has(vol.id) ? 'selected' : 'idle'}
                    onClick={() => sceneInteraction?.selectComposite(obj.index, vol.index)}
                  >
                    {vol.name}
                  </Button>
                ))}
                {obj.instanceCount > 1 && (
                  <div data-testid={`instances-${obj.id}`} className="border-l pl-2">
                    <div className="px-2 py-1 text-[0.65rem] text-muted-foreground">Instances</div>
                    {obj.instances.map((inst) => (
                      <Button
                        key={inst.id}
                        size="xs"
                        variant="ghost"
                        className="w-full justify-start pl-5"
                        data-state={projection.instanceIds.has(inst.id) ? 'selected' : 'idle'}
                        onClick={() => sceneInteraction?.selectComposite(obj.index, undefined, inst.index)}
                      >
                        {`Instance ${inst.index + 1}`}
                      </Button>
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
