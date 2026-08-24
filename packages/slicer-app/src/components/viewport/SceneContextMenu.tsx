// Right-click context menu for the 3D scene. A right-drag still pans the
// camera (OrbitControls RIGHT=PAN), so a menu opens only when the right
// button is pressed and released without meaningful movement (a click).
// A click that starts on a model body opens the object context menu (the
// same menu as the object list's object rows, minus Rename — the viewport
// has no inline editor for it) and selects the clicked instance — the same
// granularity as a plain left-click (selection mode "instance"), so on a
// multi-instance object only the clicked instance is selected. The selection
// is left untouched when the clicked volume is already selected (a plain
// left-click on an existing selection member keeps the group).
// Any other click opens the empty-scene menu. The native host/browser
// context menu is suppressed for the whole canvas.
import {
  useCallback,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { RootState } from '@react-three/fiber';
import {
  Box, Circle, Cone, Cylinder, Disc3, Donut, FolderPlus, Shapes, Trash2,
  type LucideIcon,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { usePlatform } from '@orca/platform-contract';
import type { ModelObjectStructure } from '@slicer/client';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import {
  addModel, addPrimitive, clearScene, PRIMITIVE_TYPES, type PrimitiveType,
} from '../toolbar/sceneActions';
import { ObjectListContextMenu } from '../objectList/ObjectListContextMenu';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { pickTopmostModelVolume } from './buildPlatePointerOcclusion';
import type { SceneInteractionController } from './SceneInteractionController';

// Icon per primitive matching the engine's label; the labels equal the
// shapes' type strings (OrcaSlicer's menu items are the localized labels).
const PRIMITIVE_ICONS: Record<PrimitiveType, LucideIcon> = {
  Cube: Box,
  Cylinder: Cylinder,
  Sphere: Circle,
  Cone: Cone,
  Disc: Disc3,
  Torus: Donut,
};

export function SceneContextMenu({ sceneInteraction, sceneStateRef, children }: {
  sceneInteraction: SceneInteractionController | null;
  sceneStateRef: React.RefObject<RootState | null>;
  children: ReactNode;
}) {
  const platform = usePlatform();
  const busy = useSlicerStore((s) => s.status === 'slicing');
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuObject, setMenuObject] = useState<ModelObjectStructure | null>(null);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
  }, []);

  // The ContextMenuTrigger owns native right-click anchoring and only opens on
  // the contextmenu gesture, so OrbitControls can still use right-drag for
  // panning. Resolve the hit at the same point so a body click opens the
  // object menu and preserves the existing selection behavior.
  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const state = sceneStateRef.current;
    const rect = state?.gl.domElement.getBoundingClientRect();
    const hitVolume = state && rect ? pickTopmostModelVolume(state, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    }) : null;
    if (hitVolume) {
      // Resolve the hit GLVolume's object from the structure (objectIdx is the
      // positional index); the menu logic is identical to the object list's
      // object-row menu.
      const obj = useObjectListStore.getState().structure.find(
        (o) => o.index === hitVolume.buffer.objectIdx,
      );
      if (obj) {
        // Right-click selects the clicked instance only (same granularity as
        // a plain left-click) — unless the clicked volume is already
        // selected, in which case the selection is left untouched (a plain
        // left-click on an existing selection member keeps the group, so a
        // right-click never collapses a multi-selection). For a single
        // instance this equals the whole object.
        const hit = hitVolume;
        const clickedSelected = sceneInteraction?.selectedVolumes().some((v) =>
          v.buffer.objectIdx === hit.buffer.objectIdx
          && v.buffer.volumeIdx === hit.buffer.volumeIdx
          && v.buffer.instanceIdx === hit.buffer.instanceIdx,
        );
        if (sceneInteraction && !clickedSelected) {
          sceneInteraction.selectComposite(hit.buffer.objectIdx, undefined, hit.buffer.instanceIdx, false);
        }
        setMenuObject(obj);
      } else {
        setMenuObject(null);
      }
    } else {
      setMenuObject(null);
    }
    setMenuOpen(true);
  }, [sceneInteraction, sceneStateRef]);

  const handleClearScene = useCallback(() => {
    closeMenu();
    void clearScene(platform, sceneInteraction);
  }, [platform, sceneInteraction, closeMenu]);

  const handleAddPrimitive = useCallback((type: PrimitiveType) => {
    closeMenu();
    void addPrimitive(platform, sceneInteraction, type);
  }, [platform, sceneInteraction, closeMenu]);

  const handleAddModel = useCallback(() => {
    closeMenu();
    void addModel(platform, sceneInteraction);
  }, [platform, sceneInteraction, closeMenu]);

  const handleMenuOpenChange = useCallback((open: boolean) => {
    setMenuOpen(open);
  }, []);

  const handleMenuOpenChangeComplete = useCallback((open: boolean) => {
    if (!open) setMenuObject(null);
  }, []);

  return (
    <ContextMenu
      open={menuOpen}
      onOpenChange={handleMenuOpenChange}
      onOpenChangeComplete={handleMenuOpenChangeComplete}
    >
      <ContextMenuTrigger
        className="absolute inset-0 pointer-events-none"
        onContextMenu={handleContextMenu}
      >
      {children}
      </ContextMenuTrigger>
      {menuOpen && menuObject && (
        <ObjectListContextMenu
          target={{ kind: 'object', object: menuObject }}
          onClose={closeMenu}
          showRename={false}
        />
      )}
      {menuOpen && !menuObject && (
        <ContextMenuContent data-testid="ctx-menu" className="min-w-36">
          <ContextMenuItem
            data-testid="btn-clear-scene"
            disabled={busy || !modelLoaded}
            onClick={handleClearScene}
          >
            <Trash2 /> Clear Scene
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* Add Primitive mirrors OrcaSlicer's generic primitive submenu. */}
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="btn-add-primitive" disabled={busy}>
              <Shapes /> Add Primitive
            </ContextMenuSubTrigger>
            <ContextMenuSubContent data-testid="ctx-primitive-menu" className="min-w-36">
              {PRIMITIVE_TYPES.map((type) => {
                const Icon = PRIMITIVE_ICONS[type];
                return (
                  <ContextMenuItem
                    key={type}
                    data-testid={`btn-add-${type.toLowerCase()}`}
                    disabled={busy}
                    onClick={() => handleAddPrimitive(type)}
                  >
                    <Icon /> {type}
                  </ContextMenuItem>
                );
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem
            data-testid="btn-ctx-add-model"
            disabled={busy}
            onClick={handleAddModel}
          >
            <FolderPlus /> Add Model
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}
