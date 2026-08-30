// packages/slicer-app/src/components/viewport/useSliceResult.ts
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { usePlatform } from '@orca/platform-contract';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ClientSliceResult } from '@slicer/client';

export interface ToolpathGeometry {
  geometry: THREE.BufferGeometry;
  /** per-layer [start, count] index ranges into the geometry */
  layerRanges: Array<[number, number]>;
}

export function useSliceResult() {
  const platform = usePlatform();
  const status = useSlicerStore((s) => s.status);
  const layers = useSlicerStore((s) => s.layers);
  const setLayers = useSlicerStore((s) => s.setLayers);
  const setMaxLayer = useSlicerStore((s) => s.setMaxLayer);
  const setLayer = useSlicerStore((s) => s.setLayer);
  const [result, setResult] = useState<ClientSliceResult | null>(null);

  useEffect(() => {
    if (status !== 'done') {
      // Any change to the slice inputs invalidates the completed Print (the
      // bridge already cleared its C++ result). Drop the cached toolpath so
      // the stale G-code preview leaves the scene, and reset the scrubber
      // state so it hides until the next result is fetched (spec §8:
      // "On invalidation the toolpath and layer state are immediately
      // cleared... Stale preview data is never rendered.").
      setResult(null);
      setLayer(0);
      setMaxLayer(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
      const r = await platform.runtime.getSliceResult();
        if (!r.ok) throw new Error(r.error ?? 'getSliceResult failed');
        if (cancelled) return;
        setResult(r);
        setLayers(r.layers);
        setMaxLayer(Math.max(0, r.layers - 1));
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.error('slice result fetch failed:', err);
        // Slicing and preview extraction are separate worker calls.  Do not
        // leave a failed extraction looking like a completed slice with an
        // empty viewport; surface its bridge error through the same status
        // path as an orc_slice failure.
        const slicer = useSlicerStore.getState();
        slicer.setStatus('error');
        slicer.setError(`preview: ${message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [status, setLayers, setMaxLayer, setLayer]);

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

  return { result, toolpath };
}
