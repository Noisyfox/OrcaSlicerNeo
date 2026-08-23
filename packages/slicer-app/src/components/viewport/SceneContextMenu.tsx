// Right-click context menu for the empty 3D scene. A right-drag still pans
// the camera (OrbitControls RIGHT=PAN), so the menu opens only when the
// right button is pressed and released without meaningful movement (a
// click) — and only when that press did not start on a model body. The
// native host/browser context menu is suppressed for the whole canvas.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import * as THREE from 'three';
import type { RootState } from '@react-three/fiber';
import { Box, FolderPlus, Trash2 } from 'lucide-react';
import { usePlatform } from '@orca/platform-contract';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { addCube, addModel, clearScene } from '../toolbar/sceneActions';
import { BUILD_PLATE_RAYCAST, MODEL_BODY_RAYCAST } from './buildPlatePointerOcclusion';
import type { SceneInteractionController } from './SceneInteractionController';

const CLICK_MOVE_THRESHOLD_PX = 4;
// Rough menu footprint (min-w-36 + padding/border, four items + separator)
// used to keep a right-click near the window edges from opening off-screen.
const MENU_WIDTH_PX = 160;
const MENU_HEIGHT_PX = 132;

/**
 * Whether the ray under the cursor reaches a model body. Transient overlays
 * (toolpath lines, gizmo handles, selection box) have no raycast role and are
 * skipped, so a model body underneath them still counts as "on a body". The bed
 * plate is "empty space". This prevents a right-click on a part from opening the
 * empty-scene menu just because an overlay (e.g. the always-on-top toolpath)
 * happens to intersect in front of it, and lets a back-facing part be detected.
 */
function topmostHitIsModelBody(state: RootState, clientX: number, clientY: number): boolean {
  const dom = state.gl.domElement;
  const rect = dom.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return false;
  }
  state.raycaster.setFromCamera(
    new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    ),
    state.camera,
  );
  const hits = state.raycaster.intersectObjects(state.scene.children, true);
  for (const hit of hits) {
    const role = (hit.object.userData as { orcaRaycastRole?: string }).orcaRaycastRole;
    if (role === MODEL_BODY_RAYCAST) return true;
    if (role === BUILD_PLATE_RAYCAST) return false;
    // Objects without a role (toolpath, gizmo, …) are overlays — keep going.
  }
  return false;
}

export function SceneContextMenu({ sceneInteraction, sceneStateRef, children }: {
  sceneInteraction: SceneInteractionController | null;
  sceneStateRef: React.RefObject<RootState | null>;
  children: ReactNode;
}) {
  const platform = usePlatform();
  const busy = useSlicerStore((s) => s.status === 'slicing');
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<{ x: number; y: number; pointerId: number; hitModel: boolean } | null>(null);

  // Outside press (capture, so it wins over R3F), Escape, or selecting the
  // item closes the menu.
  useEffect(() => {
    if (!point) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setPoint(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPoint(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [point]);

  // This wrapper is pointer-events-none, so every contextmenu event reaching
  // it bubbles up from the canvas. Suppress the host/browser default menu for
  // the whole scene; our own menu opens on a clean right-click below, and a
  // right-drag keeps panning.
  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 2 || !sceneStateRef.current) return;
    pressRef.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      hitModel: topmostHitIsModelBody(sceneStateRef.current, event.clientX, event.clientY),
    };
  }, [sceneStateRef]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press || event.button !== 2 || event.pointerId !== press.pointerId || press.hitModel) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (dx * dx + dy * dy > CLICK_MOVE_THRESHOLD_PX * CLICK_MOVE_THRESHOLD_PX) return;
    setPoint({
      x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH_PX),
      y: Math.min(event.clientY, window.innerHeight - MENU_HEIGHT_PX),
    });
  }, []);

  const handlePointerCancel = useCallback(() => {
    pressRef.current = null;
  }, []);

  const handleClearScene = useCallback(() => {
    setPoint(null);
    void clearScene(platform, sceneInteraction);
  }, [platform, sceneInteraction]);

  const handleAddCube = useCallback(() => {
    setPoint(null);
    void addCube(platform, sceneInteraction);
  }, [platform, sceneInteraction]);

  const handleAddModel = useCallback(() => {
    setPoint(null);
    void addModel(platform, sceneInteraction);
  }, [platform, sceneInteraction]);

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      {children}
      {point && (
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
