// The sidebar/scene split: owns the resizable divider between the settings
// sidebar and the 3D scene, and the scene interaction controller the two
// halves share. AppShell stacks this between the toolbar and status rows.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { usePlatform } from '@orca/platform-contract';
import { ObjectList } from './objectList/ObjectList';
import { SettingsPanel } from './settings/SettingsPanel';
import { Viewport } from './viewport/Viewport';
import type { SceneInteractionController } from './viewport/SceneInteractionController';

const DEFAULT_SIDEBAR_WIDTH = 288; // matches the previous `w-72` (18rem)
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 560;
function clampSidebarWidth(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value!));
}

export function Workspace({ onSceneInteractionChange }: {
  // The scene controller lives here, but the menu command dispatcher needs it
  // too; this hands it up without making the owner re-render on every change.
  onSceneInteractionChange?: (controller: SceneInteractionController | null) => void;
}) {
  const platform = usePlatform();
  const [sceneInteraction, setSceneInteraction] = useState<SceneInteractionController | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const sidebarWidthRef = useRef(sidebarWidth);
  const resizeActiveRef = useRef(false);
  const stopResizeRef = useRef<(() => void) | null>(null);

  const handleSceneInteractionChange = useCallback((controller: SceneInteractionController | null) => {
    setSceneInteraction(controller);
    onSceneInteractionChange?.(controller);
  }, [onSceneInteractionChange]);

  useEffect(() => {
    let active = true;
    void platform.preferences.load().then((prefs) => {
      if (active) {
        const width = clampSidebarWidth(prefs.ui.sidebarWidth);
        sidebarWidthRef.current = width;
        setSidebarWidth(width);
      }
    });
    return () => { active = false; stopResizeRef.current?.(); };
  }, [platform.preferences]);

  function persistSidebarWidth(width: number) {
    void platform.preferences.load().then((prefs) => platform.preferences.save({
      ...prefs,
      ui: { ...prefs.ui, sidebarWidth: width },
    })).catch(() => undefined);
  }

  function beginResize(clientX: number) {
    if (resizeActiveRef.current) return;
    resizeActiveRef.current = true;

    const startX = clientX;
    const startWidth = sidebarWidthRef.current;
    let active = true;

    const applyClientX = (nextClientX: number) => {
      if (!active) return;
      const nextWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + nextClientX - startX),
      );
      sidebarWidthRef.current = nextWidth;
      setSidebarWidth(nextWidth);
    };

    const onPointerMove = (moveEvent: PointerEvent) => applyClientX(moveEvent.clientX);
    const onMouseMove = (moveEvent: MouseEvent) => applyClientX(moveEvent.clientX);

    const stop = () => {
      if (!active) return;
      active = false;
      stopResizeRef.current = null;
      resizeActiveRef.current = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('pointercancel', stop);
      persistSidebarWidth(sidebarWidthRef.current);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    stopResizeRef.current = stop;

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('mouseup', stop);
    window.addEventListener('pointercancel', stop);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    if (typeof handle.setPointerCapture === 'function') {
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Some test/jsdom environments do not implement pointer capture.
      }
    }
    beginResize(event.clientX);
  }

  function handleResizeMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    beginResize(event.clientX);
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? -16 : 16;
    const nextWidth = Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, sidebarWidthRef.current + delta),
    );
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    persistSidebarWidth(nextWidth);
  }

  return (
    <div className="flex flex-1 min-h-0">
      <aside
        className="shrink-0 overflow-hidden rounded-md border bg-card"
        style={{
          width: `${sidebarWidth}px`,
          minWidth: `${MIN_SIDEBAR_WIDTH}px`,
          maxWidth: `${MAX_SIDEBAR_WIDTH}px`,
        }}
      >
        {/* The aside itself is overflow-hidden so its border-radius clips
            the inner scroller's custom webkit scrollbar (Chromium draws
            ::-webkit-scrollbar chrome as a rectangle, ignoring the
            scroller's rounded corners). */}
        <div className="h-full overflow-y-auto">
          <ObjectList sceneInteraction={sceneInteraction} />
          <SettingsPanel sceneInteraction={sceneInteraction} />
        </div>
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={sidebarWidth}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        tabIndex={0}
        data-testid="sidebar-resizer"
        onPointerDown={handleResizePointerDown}
        onMouseDown={handleResizeMouseDown}
        onKeyDown={handleResizeKeyDown}
        className="w-1.5 shrink-0 cursor-ew-resize touch-none self-stretch rounded-full bg-clip-content px-px transition-colors hover:bg-accent/20 focus-visible:bg-accent/30 focus-visible:outline-none"
      />
      <main className="relative min-w-0 flex-1 overflow-hidden rounded-md border bg-card">
        <Viewport
          onSceneInteractionChange={handleSceneInteractionChange}
          sceneInteraction={sceneInteraction}
        />
      </main>
    </div>
  );
}
