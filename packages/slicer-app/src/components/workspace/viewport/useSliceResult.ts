// packages/slicer-app/src/components/viewport/useSliceResult.ts
import { useEffect, useMemo, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ClientSliceResult, PreviewMetadata } from '@slicer/client';

export interface ToolpathGeometry {
  /** Immutable source arrays consumed by the native SegmentTemplate renderer. */
  segmentCount: number;
  palette: ClientSliceResult['toolpath']['palette'];
  layerIds: Uint32Array;
  moveOrders: Uint32Array;
  features: Uint32Array;
  moveTypes: Uint8Array;
  ends: Float32Array;
  /** Immutable source retained for the optional indexed streaming backend. */
  source?: ClientSliceResult['toolpath'];
  metadata?: PreviewMetadata;
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
    if (!result) return null;
    const source = result.toolpath;
    return {
      segmentCount: source.segmentCount,
      palette: source.palette,
      layerIds: source.layerIds,
      moveOrders: source.moveOrders,
      features: source.features,
      moveTypes: source.moveTypes,
      ends: source.ends,
      source,
      metadata: result.metadata,
      // The source buffers are owned by the slice result and released by the
      // runtime. The renderer owns and disposes only its GPU resources.
      dispose: () => {},
    };
  }, [result]);

  // A result replacement owns the old GPU buffers until React commits the new
  // tree; clean them up after that transition without touching camera state.
  useEffect(() => () => toolpath?.dispose(), [toolpath]);

  return { result, toolpath };
}
