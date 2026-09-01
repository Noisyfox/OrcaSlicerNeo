// packages/slicer-app/src/components/viewport/useSliceResult.ts
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ClientSliceResult } from '@slicer/client';
import {
  ToolpathBandCache,
  type ToolpathBandChunk,
} from './toolpathBandGeometry';

export interface ToolpathGeometry {
  /** Layer-aligned GPU chunks, stable across camera movement. */
  chunks: ToolpathBandChunk[];
  /** Per-layer [start, count] ranges into the source segment stream. */
  layerRanges: Array<[number, number]>;
  segmentCount: number;
  palette: ClientSliceResult['toolpath']['palette'];
  layerIds: Uint32Array;
  moveOrders: Uint32Array;
  features: Uint32Array;
  moveTypes: Uint8Array;
  ends: Float32Array;
  dispose: () => void;
}

export function useSliceResult() {
  const platform = usePlatform();
  const status = useSlicerStore((s) => s.status);
  const layers = useSlicerStore((s) => s.layers);
  const setLayers = useSlicerStore((s) => s.setLayers);
  const setMaxLayer = useSlicerStore((s) => s.setMaxLayer);
  const setLayer = useSlicerStore((s) => s.setLayer);
  const setPreviewBounds = useSlicerStore((s) => s.setPreviewBounds);
  const resetPreviewState = useSlicerStore((s) => s.resetPreviewState);
  const [result, setResult] = useState<ClientSliceResult | null>(null);
  const bandCache = useRef(new ToolpathBandCache());

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
      resetPreviewState();
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
        const activeLayer = Math.max(0, r.layers - 1);
        let maxMove = 0;
        for (let i = 0; i < r.toolpath.segmentCount; i++) {
          if (r.toolpath.layerIds[i] === activeLayer) maxMove = Math.max(maxMove, r.toolpath.moveOrders[i] ?? 0);
        }
        setPreviewBounds(Math.max(0, r.layers - 1), maxMove, r.metadata.resultId);
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
  }, [resetPreviewState, setLayers, setMaxLayer, setLayer, setPreviewBounds, status]);

  const toolpath = useMemo<ToolpathGeometry | null>(() => {
    if (!result) {
      bandCache.current.clear();
      return null;
    }
    const prepared = bandCache.current.prepare(result.toolpath);
    return prepared;
  }, [result]);

  // A result replacement owns the old GPU buffers until React commits the new
  // tree; clean them up after that transition without touching camera state.
  useEffect(() => () => toolpath?.dispose(), [toolpath]);

  return { result, toolpath };
}
