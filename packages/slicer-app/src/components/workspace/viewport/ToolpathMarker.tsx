import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import type { ToolpathGeometry } from './useSliceResult';
import type { PresetInfo } from '@slicer/client';
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

export interface PreviewHotendManifest {
  version: 1;
  fallback: string;
  models: Record<string, Record<string, string>>;
}

const DEFAULT_HOTEND_MANIFEST = Object.freeze({ version: 1 as const, fallback: 'hotend.stl', models: {} }) as PreviewHotendManifest;
const HOTEND_MANIFEST_URL = 'preview/hotends.json';
const hotendManifestPromise = { value: null as Promise<PreviewHotendManifest> | null };
const hotendBytes = new Map<string, Promise<ArrayBuffer>>();

function safeHotendPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..');
}

export function resolveHotendAssetPath(
  printer: Pick<PresetInfo, 'vendor_id' | 'model'> | null,
  manifest: PreviewHotendManifest,
): string {
  const selected = printer && manifest.models[printer.vendor_id]?.[printer.model];
  return safeHotendPath(selected) ? selected : (safeHotendPath(manifest.fallback) ? manifest.fallback : 'hotend.stl');
}

function loadHotendManifest(): Promise<PreviewHotendManifest> {
  if (!hotendManifestPromise.value) {
    hotendManifestPromise.value = fetch(new URL(HOTEND_MANIFEST_URL, document.baseURI).href)
      .then(async (response) => {
        if (!response.ok) throw new Error(`hotend marker manifest fetch failed: ${response.status}`);
        const value = await response.json() as Partial<PreviewHotendManifest>;
        if (value.version !== 1 || !value.models || typeof value.models !== 'object') throw new Error('invalid hotend marker manifest');
        return { version: 1 as const, fallback: safeHotendPath(value.fallback) ? value.fallback : 'hotend.stl', models: value.models };
      })
      .catch((error) => {
        console.warn('[preview] hotend marker manifest unavailable:', error);
        return DEFAULT_HOTEND_MANIFEST;
      });
  }
  return hotendManifestPromise.value!;
}

function loadHotendBytes(path: string): Promise<ArrayBuffer> {
  let cached = hotendBytes.get(path);
  if (!cached) {
    cached = fetch(new URL(`preview/${path}`, document.baseURI).href).then((response) => {
      if (!response.ok) throw new Error(`hotend marker fetch failed: ${response.status}`);
      return response.arrayBuffer();
    });
    hotendBytes.set(path, cached);
  }
  return cached;
}

function useHotendGeometry(assetPath: string): THREE.BufferGeometry | null {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = loadHotendBytes(assetPath).catch((error) => {
      if (assetPath === DEFAULT_HOTEND_MANIFEST.fallback) throw error;
      console.warn('[preview] selected hotend marker unavailable; using fallback:', error);
      return loadHotendBytes(DEFAULT_HOTEND_MANIFEST.fallback);
    });
    void load.then((bytes) => {
      if (cancelled) return;
      const parsed = new STLLoader().parse(bytes.slice(0));
      parsed.computeVertexNormals();
      parsed.computeBoundingBox();
      setGeometry(parsed);
    }).catch((error) => {
      // The staged asset is required for production, but the marker should
      // not break the preview if a host is running without generated assets.
      console.warn('[preview] hotend marker unavailable:', error);
    });
    return () => { cancelled = true; };
  }, [assetPath]);
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
 * Native ToolMarker geometry is a downward arrow: its tip is at local z=0,
 * the cone base is z=4, and the cylindrical stem ends at z=12. Three's
 * primitives are Y-axis aligned, so both are rotated -90 degrees around X.
 */
export function ToolpathMarker({ data }: { data: ToolpathGeometry }) {
  const { visibleLayerEnd, activeMoveEnd } = useSlicerStore((s) => s.preview);
  const selectedPrinter = useSettingsStore((s) => s.printers.find((printer) => printer.name === s.selectedPrinter) ?? null);
  const [manifest, setManifest] = useState<PreviewHotendManifest>(DEFAULT_HOTEND_MANIFEST);
  useEffect(() => {
    let cancelled = false;
    void loadHotendManifest().then((value) => { if (!cancelled) setManifest(value); });
    return () => { cancelled = true; };
  }, []);
  const assetPath = resolveHotendAssetPath(selectedPrinter, manifest);
  const geometry = useHotendGeometry(assetPath);
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
