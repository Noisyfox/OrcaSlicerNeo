import { useCallback, useLayoutEffect, useRef } from 'react';
import { OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { PlateSessionSnapshot } from '@slicer/client';
import type { PrintableAreaBounds } from './BedPlate';
import type { SceneInteractionController } from './SceneInteractionController';
import { cameraOrbitPivot, installCameraOrbitPivot } from './cameraNavigation';

export function CameraControls(props: {
  enabled: boolean;
  mode: 'prepare' | 'preview';
  sceneInteraction: SceneInteractionController;
  bounds: PrintableAreaBounds;
  plateSession: PlateSessionSnapshot | null | undefined;
  onGestureActive: (active: boolean) => void;
}) {
  const canvas = useThree(state => state.gl.domElement);
  const latest = useRef(props); latest.current = props;
  const adapter = useRef<ReturnType<typeof installCameraOrbitPivot> | null>(null);
  const bind = useCallback((controls: OrbitControlsImpl | null) => {
    if (!controls) return;
    const installed = installCameraOrbitPivot(controls, canvas, () => {
      const { mode, sceneInteraction, bounds, plateSession } = latest.current;
      return cameraOrbitPivot(mode, sceneInteraction, bounds, plateSession);
    });
    adapter.current = installed;
    return () => { installed.dispose(); adapter.current = null; };
  }, [canvas]);
  // A mode/tool/framing handoff must never replay the previous gesture's
  // inertia through another camera owner. Ordinary selection/plate changes
  // only affect the next gesture and deliberately do not run this reset.
  useLayoutEffect(() => { adapter.current?.stop(); }, [props.enabled, props.mode, props.bounds.width, props.bounds.depth, props.bounds.centerX, props.bounds.centerY]);
  return <OrbitControls ref={bind} makeDefault enabled={props.enabled} enableDamping
    mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }}
    onStart={() => props.onGestureActive(true)} onEnd={() => props.onGestureActive(false)} />;
}
