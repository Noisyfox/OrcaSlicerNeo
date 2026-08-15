// apps/desktop/src/renderer/src/components/viewport/Viewport.tsx
import { Component, type ReactNode } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Scene } from './Scene';
import { LayerScrubber } from './LayerScrubber';
import { useSettingsStore } from '../../stores/useSettingsStore';

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
  const setSelected = useSettingsStore((s) => s.setSelectedObject);
  return (
    <div className="absolute inset-0" data-testid="viewport">
      <ViewportErrorBoundary>
        <Canvas
          // Slicer convention: Z up (blue), X right, Y into screen. OrbitControls
          // in three r185 takes its orbit axis from camera.up, so setting it
          // here is all the wiring needed.
          // position in the front (+X, -Y) octant so the initial view reads
          // the convention: X right, Y into the screen, Z up.
          camera={{ position: [200, -200, 160], fov: 45, up: [0, 0, 1] }}
          dpr={[1, 2]}
          onPointerMissed={() => setSelected(null)}
        >
          <color attach="background" args={['#0f172a']} />
          <Scene />
          <OrbitControls
            makeDefault
            enableDamping
            // LEFT = orbit, RIGHT = pan, MIDDLE = zoom: select-drag is handled
            // on the mesh (ModelMesh onPointerDown), so orbit stays on left
            // only when NOT starting on a selected object.
            mouseButtons={{
              LEFT: THREE.MOUSE.ROTATE,
              MIDDLE: THREE.MOUSE.DOLLY,
              RIGHT: THREE.MOUSE.PAN,
            }}
          />
        </Canvas>
      </ViewportErrorBoundary>
      <LayerScrubber />
    </div>
  );
}
