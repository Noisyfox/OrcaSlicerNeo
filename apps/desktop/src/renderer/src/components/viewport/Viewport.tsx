// apps/desktop/src/renderer/src/components/viewport/Viewport.tsx
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Scene } from './Scene';
import { LayerScrubber } from './LayerScrubber';
import { useSettingsStore } from '../../stores/useSettingsStore';

export function Viewport() {
  const setSelected = useSettingsStore((s) => s.setSelectedObject);
  return (
    <div className="absolute inset-0">
      <Canvas
        camera={{ position: [200, 160, 200], fov: 45 }}
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
      <LayerScrubber />
    </div>
  );
}
