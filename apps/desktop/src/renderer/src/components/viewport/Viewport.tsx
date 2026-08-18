// apps/desktop/src/renderer/src/components/viewport/Viewport.tsx
import { Component, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import { Scene } from './Scene';
import { LayerScrubber } from './LayerScrubber';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSceneInteraction } from './SceneInteractionContext';

// WebGL can be unavailable (old GPUs, VMs, headless GL stacks like Mesa
// llvmpipe under xvfb). If context creation fails, three.js throws out of
// the Canvas mount — with no boundary that would unmount the whole React
// root and blank the app. Catch it here so the rest of the app (open,
// slice, export) keeps working; the viewport degrades to a message.
class ViewportErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-slate-400">
          3D preview unavailable — WebGL could not be initialized
        </div>
      );
    }
    return this.props.children;
  }
}

export function Viewport() {
  const sceneInteraction = useSceneInteraction();
  const setSelected = useSettingsStore((s) => s.setSelectedObject);
  const setSelectedVolume = useSettingsStore((s) => s.setSelectedVolumeId);
  return (
    <div className="absolute inset-0" data-testid="viewport">
      <ViewportErrorBoundary>
        <Canvas
          // Render only when something invalidates the frame (camera change,
          // scene data update, resize) — never render continuously. See
          // doc/2026-08-16-demand-render-viewport.md. OrbitControls in demand
          // mode invalidates while interacting/damping; data-driven meshes
          // invalidate via React re-render.
          frameloop="demand"
          // Slicer convention: Z up (blue), X right, Y into screen. The camera
          // is born with up = (0,0,1) — THREE.Object3D.DefaultUp is set in
          // main.tsx before the Canvas mounts, and fiber's default camera
          // lookAt(0,0,0) uses this.up — so no per-camera up wiring here.
          // OrbitControls in three r185 takes its orbit axis from camera.up.
          // position in the front (+X, -Y) octant so the initial view reads
          // the convention: X right, Y into the screen, Z up.
          camera={{ position: [200, -200, 160], fov: 45 }}
          dpr={[1, 2]}
          onPointerMissed={() => {
            sceneInteraction.clearSelection();
            // Temporary sidebar compatibility during the move-panel migration.
            setSelected(null);
            setSelectedVolume(null);
          }}
        >
          <color attach="background" args={['#0f172a']} />
          <Scene />
          <OrbitControls
            makeDefault
            enableDamping
            // LEFT = orbit, RIGHT = pan, MIDDLE = zoom. Body/gizmo drags
            // (DragControls dragConfig, MoveGizmo) disable orbit for the
            // gesture's duration.
            mouseButtons={{
              LEFT: THREE.MOUSE.ROTATE,
              MIDDLE: THREE.MOUSE.DOLLY,
              RIGHT: THREE.MOUSE.PAN,
            }}
          />
          {/* Orientation gizmo (X/Y/Z axes), bottom-left corner. GizmoHelper
              renders the gizmo into an orthographic overlay (Hud portal);
              head clicks tween the main camera to look along that axis.
              Labels are plain X/Y/Z, so no Z-up remap is needed (unlike the
              viewcube's Y-up face names). See
              doc/2026-08-17-viewcube-gizmo.md. */}
          <GizmoHelper alignment="bottom-left" margin={[80, 80]}>
            <GizmoViewport />
          </GizmoHelper>
        </Canvas>
      </ViewportErrorBoundary>
      <LayerScrubber />
    </div>
  );
}
