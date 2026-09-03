import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import type { ToolpathGeometry } from './useSliceResult';
import type { PresetInfo } from '@slicer/client';
import { usePlatform, type ProfileSource } from '@orca/platform-contract';
import { lastMovePosition, maxMoveOrderForLayer } from './previewSemantics';

/** OrcaSlicer's native Marker::render state for the hotend STL. */
export const TOOL_MARKER_MATERIAL = Object.freeze({
  color: '#ffffff',
  transparent: true,
  opacity: 0.5,
  blending: THREE.NormalBlending,
  depthTest: true,
  depthWrite: true,
  side: THREE.FrontSide,
  // The native marker is rendered with Orca's gouraud_light shader. Keep the
  // Three material un-emissive so the shared lights produce the same shaded
  // translucent white appearance.
  emissive: '#000000',
  emissiveIntensity: 0,
  specular: '#ffffff',
  shininess: 20,
});

/** Orca's fixed separation from the current tool position. */
export const TOOL_MARKER_Z_OFFSET = 0.5;

/**
 * Match GCodeViewer::SequentialView::Marker::render exactly:
 * T(position + 0.5 Z) · T(bbox.size.z Z) · R(PI, X) · S(1).
 * The hotend STL's upper Z face therefore ends at the current tool point,
 * while the body extends downward from it.
 */
export function toolMarkerModelTransform(
  position: readonly [number, number, number],
  bounds: THREE.Box3,
): { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } {
  return {
    position: [position[0], position[1], position[2] + TOOL_MARKER_Z_OFFSET + bounds.getSize(new THREE.Vector3()).z],
    rotation: [Math.PI, 0, 0],
    scale: [1, 1, 1],
  };
}

const hotendBytes = new WeakMap<object, Map<string, Promise<ArrayBuffer | null>>>();
const readHotendProfileAsset = import('@orca/slicer-runtime').then((runtime) => runtime.readHotendProfileAsset);

function loadHotendBytes(
  profiles: ProfileSource,
  printer: Pick<PresetInfo, 'vendor_id' | 'model'> | null,
): Promise<ArrayBuffer | null> {
  const cacheKey = printer ? `${printer.vendor_id}\u0000${printer.model}` : '';
  let cache = hotendBytes.get(profiles as object);
  if (!cache) { cache = new Map(); hotendBytes.set(profiles as object, cache); }
  let cached = cache.get(cacheKey);
  if (!cached) {
    cached = readHotendProfileAsset.then((read) => read(profiles, printer)).then((bytes) => bytes
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      : null);
    cache.set(cacheKey, cached);
  }
  return cached;
}

function useHotendGeometry(
  profiles: ProfileSource,
  printer: Pick<PresetInfo, 'vendor_id' | 'model'> | null,
): THREE.BufferGeometry | null {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = loadHotendBytes(profiles, printer);
    void load.then((bytes) => {
      if (cancelled || !bytes) return;
      const parsed = new STLLoader().parse(bytes.slice(0));
      parsed.computeVertexNormals();
      parsed.computeBoundingBox();
      setGeometry(parsed);
    }).catch((error) => {
      // Profile archives are required for the production marker, but a
      // missing or incomplete archive must not break the preview.
      console.warn('[preview] hotend marker unavailable:', error);
    });
    return () => { cancelled = true; };
  }, [profiles, printer]);
  return geometry;
}

/**
 * Orca omits the marker once the visible range reaches its enabled end. The
 * shared preview state has the same endpoint represented by the final layer
 * and that layer's final move.
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
 * The marker is Orca's translucent hotend STL loaded from the selected
 * profile archive. It is intentionally not a separately staged preview asset.
 */
export function ToolpathMarker({ data }: { data: ToolpathGeometry }) {
  const { visibleLayerEnd, activeMoveEnd } = useSlicerStore((s) => s.preview);
  const platform = usePlatform();
  const selectedPrinter = useSettingsStore((s) => s.printers.find((printer) => printer.name === s.selectedPrinter) ?? null);
  const geometry = useHotendGeometry(platform.profiles, selectedPrinter);
  const currentPosition = useMemo(
    () => lastMovePosition(data, visibleLayerEnd, activeMoveEnd),
    [activeMoveEnd, data, visibleLayerEnd],
  );
  if (!geometry || !currentPosition || isFinalToolpathEndpoint(data, visibleLayerEnd, activeMoveEnd)) return null;
  // STLLoader computes a stable local bounding box once. Orca uses the model
  // bounding-box Z size for its translation before the 180° X flip.
  const transform = toolMarkerModelTransform(currentPosition, geometry.boundingBox ?? new THREE.Box3());
  return (
    <group name="preview-nozzle-marker" position={transform.position} rotation={transform.rotation} scale={transform.scale} renderOrder={1100}>
      <mesh name="preview-nozzle-model" geometry={geometry} renderOrder={1100}>
        <meshPhongMaterial {...TOOL_MARKER_MATERIAL} />
      </mesh>
    </group>
  );
}
