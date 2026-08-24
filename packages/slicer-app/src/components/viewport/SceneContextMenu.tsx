// Right-click context menu for the 3D scene. A right-drag still pans the
// camera (OrbitControls RIGHT=PAN), so a menu opens only when the right
// button is pressed and released without meaningful movement (a click).
// A click that starts on a model body opens the object context menu (the
// same menu as the object list's object rows, minus Rename — the viewport
// has no inline editor for it); any other click opens the empty-scene menu.
// The native host/browser context menu is suppressed for the whole canvas.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { RootState } from '@react-three/fiber';
import { Box, FolderPlus, Trash2 } from 'lucide-react';
import { usePlatform } from '@orca/platform-contract';
import type { ModelObjectStructure } from '@slicer/client';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { addCube, addModel, clearScene } from '../toolbar/sceneActions';
import { ObjectListContextMenu } from '../objectList/ObjectListContextMenu';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { pickTopmostModelVolume } from './buildPlatePointerOcclusion';
import type { GLVolume } from './GLVolume';
import type { SceneInteractionController } from './SceneInteractionController';

const CLICK_MOVE_THRESHOLD_PX = 4;
// Rough menu footprints (min-w + padding/border, items + separator) used to
// keep a right-click near the window edges from opening off-screen.
const MENU_WIDTH_PX = 160;
const MENU_HEIGHT_PX = 132;
const OBJECT_MENU_HEIGHT_PX = 300;

export function SceneContextMenu({ sceneInteraction, sceneStateRef, children }: {
  sceneInteraction: SceneInteractionController | null;
  sceneStateRef: React.RefObject<RootState | null>;
  children: ReactNode;
}) {
  const platform = usePlatform();
  const busy = useSlicerStore((s) => s.status === 'slicing');
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [menuObject, setMenuObject] = useState<ModelObjectStructure | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<{ x: number; y: number; pointerId: number; hitVolume: GLVolume | null } | null>(null);

  const closeMenu = useCallback(() => {
    setPoint(null);
    setMenuObject(null);
  }, []);

  // Outside press (capture, so it wins over R3F), Escape, or selecting the
  // item closes the menu.
  useEffect(() => {
    if (!point) return;
    const onPointerDown = (event: PointerEvent) => {
      const el = event.target as Node;
      if (el instanceof Element
        && el.closest('[data-testid="ctx-menu"], [data-testid="objectlist-ctx-menu"]')) return;
      if (menuRef.current?.contains(el)) return;
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [point, closeMenu]);

  // This wrapper is pointer-events-none, so every contextmenu event reaching
  // it bubbles up from the canvas. Suppress the host/browser default menu for
  // the whole scene; our own menu opens on a clean right-click below, and a
  // right-drag keeps panning.
  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 2 || !sceneStateRef.current) return;
    const rect = sceneStateRef.current.gl.domElement.getBoundingClientRect();
    pressRef.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      hitVolume: pickTopmostModelVolume(sceneStateRef.current, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      }),
    };
  }, [sceneStateRef]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press || event.button !== 2 || event.pointerId !== press.pointerId) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (dx * dx + dy * dy > CLICK_MOVE_THRESHOLD_PX * CLICK_MOVE_THRESHOLD_PX) return;
    const clampedPoint = {
      x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH_PX),
      y: Math.min(event.clientY, window.innerHeight - (press.hitVolume ? OBJECT_MENU_HEIGHT_PX : MENU_HEIGHT_PX)),
    };
    if (press.hitVolume) {
      // Resolve the hit GLVolume's object from the structure (objectIdx is the
      // positional index); the menu logic is identical to the object list's
      // object-row menu. Right-clicking never changes the selection.
      const obj = useObjectListStore.getState().structure.find(
        (o) => o.index === press.hitVolume!.buffer.objectIdx,
      );
      if (obj) {
        setMenuObject(obj);
        setPoint(clampedPoint);
        return;
      }
    }
    setMenuObject(null);
    setPoint(clampedPoint);
  }, []);

  const handlePointerCancel = useCallback(() => {
    pressRef.current = null;
  }, []);

  const handleClearScene = useCallback(() => {
    closeMenu();
    void clearScene(platform, sceneInteraction);
  }, [platform, sceneInteraction, closeMenu]);

  const handleAddCube = useCallback(() => {
    closeMenu();
    void addCube(platform, sceneInteraction);
  }, [platform, sceneInteraction, closeMenu]);

  const handleAddModel = useCallback(() => {
    closeMenu();
    void addModel(platform, sceneInteraction);
  }, [platform, sceneInteraction, closeMenu]);

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      {children}
      {point && menuObject && (
        <ObjectListContextMenu
          target={{ kind: 'object', object: menuObject }}
          point={point}
          onClose={closeMenu}
          showRename={false}
        />
      )}
      {point && !menuObject && (
        <div
          ref={menuRef}
          role="menu"
          data-testid="ctx-menu"
          className="pointer-events-auto fixed z-50 min-w-36 rounded-md border bg-card p-1 shadow-md"
          style={{ left: point.x, top: point.y }}
        >
          <button
            type="button"
            role="menuitem"
            data-testid="btn-clear-scene"
            disabled={busy || !modelLoaded}
            onClick={handleClearScene}
            className="flex h-7 w-full cursor-default items-center gap-2 rounded-sm px-2 text-left text-xs/relaxed text-foreground select-none outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <Trash2 className="size-3.5" /> Clear Scene
          </button>
          <div role="separator" className="my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            data-testid="btn-add-cube"
            disabled={busy}
            onClick={handleAddCube}
            className="flex h-7 w-full cursor-default items-center gap-2 rounded-sm px-2 text-left text-xs/relaxed text-foreground select-none outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <Box className="size-3.5" /> Add Cube
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="btn-ctx-add-model"
            disabled={busy}
            onClick={handleAddModel}
            className="flex h-7 w-full cursor-default items-center gap-2 rounded-sm px-2 text-left text-xs/relaxed text-foreground select-none outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <FolderPlus className="size-3.5" /> Add Model
          </button>
        </div>
      )}
    </div>
  );
}
