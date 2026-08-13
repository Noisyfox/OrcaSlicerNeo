// apps/desktop/src/renderer/src/components/viewport/useSliceResult.ts
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { slicerClient } from '../../slicer/slicerClient';
import { useSlicerStore } from '../../stores/useSlicerStore';
import type { ClientSliceResult } from '@slicer/client';

export interface ToolpathGeometry {
  geometry: THREE.BufferGeometry;
  /** per-layer [start, count] index ranges into the geometry */
  layerRanges: Array<[number, number]>;
}

export interface SlicedMeshGeometry {
  geometry: THREE.BufferGeometry;
  layerRanges: Array<[number, number]>;
}

export function useSliceResult() {
  const status = useSlicerStore((s) => s.status);
  const layers = useSlicerStore((s) => s.layers);
  const setLayers = useSlicerStore((s) => s.setLayers);
  const setMaxLayer = useSlicerStore((s) => s.setMaxLayer);
  const [result, setResult] = useState<ClientSliceResult | null>(null);

  useEffect(() => {
    if (status !== 'done') return;
    let cancelled = false;
    (async () => {
      try {
        const r = await slicerClient.getSliceResult();
        if (!r.ok) throw new Error(r.error ?? 'getSliceResult failed');
        if (cancelled) return;
        setResult(r);
        setLayers(r.layers);
        setMaxLayer(Math.max(0, r.layers - 1));
      } catch (err) {
        console.error('slice result fetch failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [status, setLayers, setMaxLayer]);

  const toolpath = useMemo<ToolpathGeometry | null>(() => {
    if (!result) return null;
    const t = result.toolpath;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
    geometry.setDrawRange(0, 0); // scrubber controls visibility

    // vertex colors from the feature palette
    const colors = new Float32Array(t.vertexCount * 3);
    for (let i = 0; i < t.vertexCount; i++) {
      const c = t.palette[t.features[i] % t.palette.length]?.color ?? [255, 255, 255];
      colors[i * 3] = c[0] / 255;
      colors[i * 3 + 1] = c[1] / 255;
      colors[i * 3 + 2] = c[2] / 255;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Toolpath vertices are emitted in gcode order — layer-ascending and
    // contiguous per layer (GCodeProcessorResult.moves). One pass builds
    // per-layer [start, count] draw ranges (drawRange counts vertices);
    // O(n), safe for million-vertex toolpaths (no spread/scan-per-layer).
    const layerRanges: Array<[number, number]> = [];
    if (t.vertexCount > 0) {
      let start = 0;
      let cur = t.layers[0];
      for (let i = 1; i < t.vertexCount; i++) {
        if (t.layers[i] !== cur) {
          layerRanges[cur] = [start, i - start];
          start = i;
          cur = t.layers[i];
        }
      }
      layerRanges[cur] = [start, t.vertexCount - start];
    }
    return { geometry, layerRanges };
  }, [result]);

  const mesh = useMemo<SlicedMeshGeometry | null>(() => {
    if (!result) return null;
    const m = result.mesh;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(m.indices, 1));
    geometry.computeVertexNormals();
    geometry.setDrawRange(0, 0);

    // per-layer [start, count] over INDEX entries (indexed drawRange)
    const layerRanges: Array<[number, number]> = [];
    const triPerLayer = new Map<number, number>();
    for (let i = 0; i < m.layerRanges.length; i++) {
      triPerLayer.set(m.layerRanges[i], (triPerLayer.get(m.layerRanges[i]) ?? 0) + 1);
    }
    const maxLayer = Math.max(...triPerLayer.keys(), 0);
    let running = 0;
    for (let layer = 0; layer <= maxLayer; layer++) {
      const n = triPerLayer.get(layer) ?? 0;
      layerRanges.push([running, n * 3]);
      running += n * 3;
    }
    return { geometry, layerRanges };
  }, [result]);

  return { result, toolpath, mesh };
}
