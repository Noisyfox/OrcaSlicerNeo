import { useLayoutEffect, useRef } from 'react';
import { Outlines } from '@react-three/drei';
import * as THREE from 'three';

export const MODEL_OUTLINE_NAME = 'orca-model-selection-outline';
export const MODEL_OUTLINE_PIXELS = 3;
export const NO_OUTLINE_RAYCAST: THREE.Object3D['raycast'] = () => undefined;

/** Orca gouraud.fs/phong.fs getBackfaceColor, approximated from the fill colour
 * before lighting (drei has no access to the shaded surface fragments). */
export function modelOutlineColour(fill: string): string {
  const rgb = new THREE.Color(fill).getRGB(new THREE.Color(), THREE.SRGBColorSpace);
  const brightness = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return brightness > 0.75 ? '#1c2a35' : '#fcfcfc';
}

/** Must be a direct child of the visible model mesh, as required by drei. */
export function ModelSelectionOutline({ colour, opacity, transparent }: {
  colour: string; opacity: number; transparent: boolean;
}) {
  const group = useRef<THREE.Group | null>(null);
  const materials = useRef(new Set<THREE.Material>());
  // drei creates its inner mesh in a child layout effect. Disable that mesh's
  // picking after every commit, including source-geometry replacements.
  useLayoutEffect(() => {
    group.current?.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.raycast = NO_OUTLINE_RAYCAST;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        material.depthWrite = false;
        materials.current.add(material);
      }
    });
  });
  useLayoutEffect(() => () => {
    for (const material of materials.current) material.dispose();
    materials.current.clear();
  }, []);
  // In the installed drei version screenspace=false uses pixel offsets;
  // true uses world units. angle=0 reuses the existing indexed geometry.
  return <Outlines name={MODEL_OUTLINE_NAME} color={modelOutlineColour(colour)}
    opacity={opacity} transparent={transparent}
    thickness={MODEL_OUTLINE_PIXELS} screenspace={false} angle={0} toneMapped={false}
    onUpdate={object => { group.current = object; }} />;
}
