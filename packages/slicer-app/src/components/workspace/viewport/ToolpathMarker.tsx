import { useMemo } from 'react';
import * as THREE from 'three';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';
import { lastMovePosition, maxMoveOrderForLayer } from './previewSemantics';

/** Native libvgcode ToolMarker dimensions (millimetres). */
export const TOOL_MARKER_GEOMETRY = Object.freeze({
  radialSegments: 32,
  tipRadius: 2,
  tipHeight: 4,
  stemRadius: 1,
  stemHeight: 8,
  offsetZ: 0.5,
});

/** Native libvgcode's default marker appearance and render state. */
export const TOOL_MARKER_MATERIAL = Object.freeze({
  color: '#ffffff',
  transparent: true,
  opacity: 0.5,
  blending: THREE.NormalBlending,
  depthTest: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  // The native marker uses ambient + diffuse + specular lighting. These
  // values provide a comparable highlight with the shared Three lights.
  emissive: '#404040',
  emissiveIntensity: 0.625,
  specular: '#999999',
  shininess: 20,
});

export function toolMarkerAnchor(position: readonly [number, number, number]): [number, number, number] {
  return [position[0], position[1], position[2] + TOOL_MARKER_GEOMETRY.offsetZ];
}

/**
 * libvgcode omits the marker once the visible range reaches its enabled end.
 * The shared preview state has the same endpoint represented by the final
 * layer and that layer's final move.
 */
export function isFinalToolpathEndpoint(
  data: Pick<ToolpathGeometry, 'segmentCount' | 'layerIds' | 'moveOrders'>,
  layer: number,
  move: number,
): boolean {
  let maxLayer = -1;
  for (let i = 0; i < data.segmentCount; i++) {
    maxLayer = Math.max(maxLayer, data.layerIds[i] ?? -1);
  }
  if (maxLayer < 0 || layer !== maxLayer) return false;
  return move >= maxMoveOrderForLayer(data, maxLayer);
}

/**
 * Native ToolMarker geometry is a downward arrow: its tip is at local z=0,
 * the cone base is z=4, and the cylindrical stem ends at z=12. Three's
 * primitives are Y-axis aligned, so both are rotated -90 degrees around X.
 */
export function ToolpathMarker({ data }: { data: ToolpathGeometry }) {
  const { visibleLayerEnd, activeMoveEnd } = useSlicerStore((s) => s.preview);
  const currentPosition = useMemo(
    () => lastMovePosition(data, visibleLayerEnd, activeMoveEnd),
    [activeMoveEnd, data, visibleLayerEnd],
  );
  const markerPosition = currentPosition ? toolMarkerAnchor(currentPosition) : null;
  if (!markerPosition || isFinalToolpathEndpoint(data, visibleLayerEnd, activeMoveEnd)) return null;

  const { radialSegments, tipRadius, tipHeight, stemRadius, stemHeight } = TOOL_MARKER_GEOMETRY;
  return (
    <group name="preview-nozzle-marker" position={markerPosition} renderOrder={1100}>
      <mesh
        name="preview-nozzle-tip"
        position={[0, 0, tipHeight / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={1100}
      >
        <coneGeometry args={[tipRadius, tipHeight, radialSegments]} />
        <meshPhongMaterial {...TOOL_MARKER_MATERIAL} />
      </mesh>
      <mesh
        name="preview-nozzle-stem"
        position={[0, 0, tipHeight + stemHeight / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={1100}
      >
        <cylinderGeometry args={[stemRadius, stemRadius, stemHeight, radialSegments]} />
        <meshPhongMaterial {...TOOL_MARKER_MATERIAL} />
      </mesh>
    </group>
  );
}
