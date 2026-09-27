import { useEffect } from 'react';
import * as THREE from 'three';
import { registerOrcaE2eOwner } from './registerOrcaE2e';

interface TransformGizmoProbeProps {
  controlsRef: { readonly current: unknown };
}

export function TransformGizmoProbe({ controlsRef }: TransformGizmoProbeProps) {
  useEffect(() => {
    // The Scene probe owns this shared object. Do not publish gizmo hooks if
    // that owner has not installed it yet.
    if (!window.__orcaE2e) return;

    const readAxis = () => (controlsRef.current as { axis: string | null } | null)?.axis ?? null;
    const readAxisLineWorldPosition = () => {
      const controls = controlsRef.current as {
        gizmo?: { helper?: { rotate?: { children?: THREE.Object3D[] } } };
      } | null;
      const axis = controls?.gizmo?.helper?.rotate?.children?.find((child) => child.name === 'AXIS');
      if (!axis) return null;
      const world = new THREE.Vector3();
      axis.getWorldPosition(world);
      return [world.x, world.y, world.z] as [number, number, number];
    };

    return registerOrcaE2eOwner('transform-gizmo', {
      gizmoAxis: readAxis,
      gizmoAxisLineWorldPosition: readAxisLineWorldPosition,
    });
  }, [controlsRef]);

  return null;
}
