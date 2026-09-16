// packages/slicer-app/src/components/viewport/useSliceResult.ts
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import type { ClientSliceResult, PreviewMetadata, PreviewToolpathMetrics, PreviewPaletteEntry, PreviewAnalysis, SliceResultReceipt } from '@slicer/client';
import { createPreviewSourceLineIndex, maxMoveOrderForLayer, type PreviewSourceLineIndex } from './previewSemantics';
import { deriveLogicalMoveOrders } from './gpuStreamingPlanner';

export interface ToolpathGeometry {
  /** Immutable source arrays consumed by the native SegmentTemplate renderer. */
  segmentCount: number;
  palette: ClientSliceResult['toolpath']['palette'];
  layerIds: Uint32Array;
  moveOrders: Uint32Array;
  features: Uint32Array;
  moveTypes: Uint8Array;
  ends: Float32Array;
  /** Optional source identifiers used by the read-only Phase-C inspector. */
  gcodeIds?: Uint32Array;
  /** Prevalidated processor ordering; lets the text window use binary lookup. */
  sourceLineOrderValid?: boolean;
  /** Result-local source index built once while the slice result is created. */
  sourceLineIndex?: PreviewSourceLineIndex;
  extruderIds: Uint8Array;
  metrics: PreviewToolpathMetrics;
  extruderPalette?: readonly PreviewPaletteEntry[];
  analysis?: PreviewAnalysis;
  /** Immutable source retained for the optional indexed streaming backend. */
  source?: ClientSliceResult['toolpath'];
  /** The plate-owned local G-code used by the source-text inspector. */
  sourceTextBytes?: Uint8Array;
  metadata?: PreviewMetadata;
  dispose: () => void;
}

export type PreviewProjectionStatus = 'needs-slicing' | 'loading' | 'ready' | 'failed';

interface ProjectedResult {
  receipt: SliceResultReceipt;
  result: ClientSliceResult;
}

function sameReceipt(left: SliceResultReceipt | undefined, right: SliceResultReceipt | undefined): boolean {
  return left !== undefined && right !== undefined && left.plateId === right.plateId &&
    left.inputStamp === right.inputStamp && left.sliceTaskId === right.sliceTaskId;
}

export function useSliceResult(enabled = true) {
  const platform = usePlatform();
  const status = useSlicerStore((s) => s.status);
  const sliceTarget = useSlicerStore((s) => s.sliceTarget);
  const plateResults = useSlicerStore((s) => s.plateResults);
  const currentPlateId = usePlateSessionStore((s) => s.snapshot?.currentPlateId ?? null);
  const layers = useSlicerStore((s) => s.layers);
  const setLayers = useSlicerStore((s) => s.setLayers);
  const setMaxLayer = useSlicerStore((s) => s.setMaxLayer);
  const setLayer = useSlicerStore((s) => s.setLayer);
  const setPreviewBounds = useSlicerStore((s) => s.setPreviewBounds);
  const resetPreviewState = useSlicerStore((s) => s.resetPreviewState);
  const activeResult = currentPlateId && sliceTarget?.plateId === currentPlateId
    ? plateResults[currentPlateId]
    : undefined;
  const expectedReceipt = activeResult?.receipt;
  const projectionEpoch = useRef(0);
  const [projection, setProjection] = useState<ProjectedResult | null>(null);
  const [projectionStatus, setProjectionStatus] = useState<PreviewProjectionStatus>('needs-slicing');

  useEffect(() => {
    const epoch = ++projectionEpoch.current;
    setProjection(null);
    if (!enabled || status !== 'done' || !expectedReceipt || expectedReceipt.plateId !== currentPlateId) {
      setProjectionStatus('needs-slicing');
      setLayer(0);
      setMaxLayer(0);
      resetPreviewState();
      return;
    }
    const requestedReceipt = expectedReceipt;
    setProjectionStatus('loading');
    setLayer(0);
    setMaxLayer(0);
    resetPreviewState();
    let cancelled = false;
    (async () => {
      try {
        const r = await platform.runtime.getSliceResult(requestedReceipt);
        if (cancelled || projectionEpoch.current !== epoch) return;
        const live = useSlicerStore.getState();
        const current = usePlateSessionStore.getState().snapshot?.currentPlateId;
        const liveReceipt = live.plateResults[requestedReceipt.plateId]?.receipt;
        const liveTarget = live.sliceTarget;
        if (current !== requestedReceipt.plateId || live.status !== 'done' ||
            liveTarget?.plateId !== requestedReceipt.plateId ||
            liveTarget?.inputRevision !== requestedReceipt.inputStamp ||
            !sameReceipt(liveReceipt, requestedReceipt)) return;
        if (!r.ok) {
          if (r.status === 'stale') return;
          if (r.status === 'unavailable') {
            live.discardPlateResult(requestedReceipt.plateId);
            setProjectionStatus('needs-slicing');
            return;
          }
          setProjectionStatus('failed');
          console.error('slice result projection failed:', r.error ?? 'unknown projection failure');
          return;
        }
        if (!sameReceipt(r.receipt, requestedReceipt)) return;
        // bridge_buffers supplies a raw per-segment stream. Canonicalize it
        // once here so arc tessellation is one logical move for all consumers;
        // the enriched result/source then retains this array by reference.
        const moveOrders = deriveLogicalMoveOrders(r.toolpath.layerIds, r.toolpath.gcodeIds, r.toolpath.segmentCount);
        const result = { ...r, toolpath: { ...r.toolpath, moveOrders } };
        setProjection({ receipt: requestedReceipt, result });
        setProjectionStatus('ready');
        setLayers(r.layers);
        setMaxLayer(Math.max(0, r.layers - 1));
        const activeLayer = Math.max(0, r.layers - 1);
        const maxMove = maxMoveOrderForLayer({ ...result.toolpath, metadata: r.metadata }, activeLayer);
        setPreviewBounds(Math.max(0, r.layers - 1), maxMove, r.metadata.resultId);
      } catch (err) {
        if (cancelled || projectionEpoch.current !== epoch) return;
        // Projection failure is local and retryable from the retained native
        // cache. It must not turn a completed Slice into a global slice error.
        setProjectionStatus('failed');
        console.error('slice result projection failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [currentPlateId, expectedReceipt?.inputStamp, expectedReceipt?.plateId,
    enabled, expectedReceipt?.sliceTaskId, resetPreviewState, setLayers, setMaxLayer,
    setLayer, setPreviewBounds, status]);

  const result = projection && sameReceipt(projection.receipt, expectedReceipt) &&
      enabled && currentPlateId === projection.receipt.plateId && status === 'done'
    ? projection.result : null;

  const toolpath = useMemo<ToolpathGeometry | null>(() => {
    if (!result) return null;
    const source = result.toolpath;
    return {
      segmentCount: source.segmentCount,
      palette: source.palette,
      layerIds: source.layerIds,
      // The effect canonicalizes bridge orders once; keep the result-owned
      // logical array by reference through the UI and streaming planner.
      moveOrders: source.moveOrders,
      features: source.features,
      moveTypes: source.moveTypes,
      ends: source.ends,
      gcodeIds: source.gcodeIds,
      sourceLineOrderValid: source.sourceLineOrderValid,
      sourceLineIndex: createPreviewSourceLineIndex({
        segmentCount: source.segmentCount,
        gcodeIds: source.gcodeIds,
        sourceLineOrderValid: source.sourceLineOrderValid,
        metadata: result.metadata,
      }),
      extruderIds: source.extruderIds,
      metrics: source.metrics,
      ...(result.metadata.extruderPalette ? { extruderPalette: result.metadata.extruderPalette } : {}),
      ...(result.metadata.analysis ? { analysis: result.metadata.analysis } : {}),
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

  return { result, toolpath, projectionStatus };
}
