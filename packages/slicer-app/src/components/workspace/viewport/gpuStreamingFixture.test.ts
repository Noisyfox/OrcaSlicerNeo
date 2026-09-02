import { describe, expect, it } from 'vitest';
import {
  GPU_STREAM_EXTRUSION_MOVE_TYPE,
  GPU_STREAM_PAGE_TARGET,
  GPU_STREAM_SEGMENT_COUNTS,
  GPU_STREAM_TRAVEL_MOVE_TYPE,
  buildGpuStreamingPages,
  createGpuStreamingMetadata,
  rebuildGpuStreamingSelection,
} from './gpuStreamingFixture';

function bytesEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

describe('GPU streaming metadata fixture', () => {
  it.each(GPU_STREAM_SEGMENT_COUNTS)('is deterministic at %s segments', (segmentCount) => {
    const first = createGpuStreamingMetadata({ segmentCount });
    const second = createGpuStreamingMetadata({ segmentCount });

    expect(first.segmentCount).toBe(segmentCount);
    expect(first.layerCount).toBe(256);
    expect(first.seed).toBe(second.seed);
    expect(bytesEqual(first.layerIds, second.layerIds)).toBe(true);
    expect(bytesEqual(first.moveOrders, second.moveOrders)).toBe(true);
    expect(bytesEqual(first.features, second.features)).toBe(true);
    expect(bytesEqual(first.moveTypes, second.moveTypes)).toBe(true);
    expect(first.pages).toEqual(second.pages);
  });

  it.each(GPU_STREAM_SEGMENT_COUNTS)('covers every segment in contiguous layer-aligned pages at %s', (segmentCount) => {
    const metadata = createGpuStreamingMetadata({ segmentCount });
    let cursor = 0;
    for (const page of metadata.pages) {
      expect(page.firstSegment).toBe(cursor);
      expect(page.segmentCount).toBeGreaterThan(0);
      expect(page.firstLayer).toBe(metadata.layerIds[page.firstSegment]);
      expect(page.lastLayer).toBe(metadata.layerIds[page.firstSegment + page.segmentCount - 1]);
      // A page may contain several complete layers, but neither boundary may
      // cut through a normal layer.
      expect(page.firstSegment === 0 || metadata.layerIds[page.firstSegment - 1] !== page.firstLayer).toBe(true);
      expect(page.firstSegment + page.segmentCount === segmentCount || metadata.layerIds[page.firstSegment + page.segmentCount] !== page.lastLayer).toBe(true);
      if (page !== metadata.pages.at(-1)) expect(page.segmentCount).toBeLessThanOrEqual(GPU_STREAM_PAGE_TARGET);
      cursor += page.segmentCount;
    }
    expect(cursor).toBe(segmentCount);
  });

  it('keeps page boundaries layer-aligned when a prior page is near its target', () => {
    const layerIds = Uint32Array.from([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(buildGpuStreamingPages(layerIds, layerIds.length, 5)).toEqual([
      { firstSegment: 0, segmentCount: 4, firstLayer: 0, lastLayer: 1 },
      { firstSegment: 4, segmentCount: 4, firstLayer: 2, lastLayer: 3 },
    ]);
  });

  it('rebuilds an ordered enabled stream with inclusive layer and move semantics', () => {
    const metadata = createGpuStreamingMetadata({ segmentCount: 64, layerCount: 4, seed: 1 });
    const result = rebuildGpuStreamingSelection(metadata, {
      visibleLayerStart: 1,
      visibleLayerEnd: 2,
      activeMoveEnd: 3,
      showTravel: true,
    });
    expect(result.visitedSegments).toBe(64);
    expect(Array.from(result.indices)).toEqual(Array.from(result.indices).sort((a, b) => a - b));
    for (const index of result.indices) {
      const layer = metadata.layerIds[index];
      expect(layer).toBeGreaterThanOrEqual(1);
      expect(layer).toBeLessThanOrEqual(2);
      if (layer === 2) expect(metadata.moveOrders[index]).toBeLessThanOrEqual(3);
    }
  });

  it('applies global travel and feature hide semantics without geometry allocation', () => {
    const metadata = createGpuStreamingMetadata({ segmentCount: 512, layerCount: 8 });
    const result = rebuildGpuStreamingSelection(metadata, {
      visibleLayerStart: 0,
      visibleLayerEnd: 7,
      activeMoveEnd: Number.MAX_SAFE_INTEGER,
      showTravel: false,
      featureVisibility: { 1: false, 3: false },
    });
    expect(result.visitedSegments).toBe(metadata.segmentCount);
    for (const index of result.indices) {
      expect(metadata.moveTypes[index]).toBe(GPU_STREAM_EXTRUSION_MOVE_TYPE);
      expect([1, 3]).not.toContain(metadata.features[index]);
    }
    expect(metadata.moveTypes).toContain(GPU_STREAM_TRAVEL_MOVE_TYPE);
    expect(metadata.features).toContain(1);
    expect(metadata.features).toContain(3);
  });

  it.each(GPU_STREAM_SEGMENT_COUNTS)('has a linear visit contract at %s segments', (segmentCount) => {
    const metadata = createGpuStreamingMetadata({ segmentCount });
    const result = rebuildGpuStreamingSelection(metadata, {
      visibleLayerStart: 0,
      visibleLayerEnd: metadata.layerCount - 1,
      activeMoveEnd: Number.MAX_SAFE_INTEGER,
      showTravel: true,
    });
    // This is an algorithmic contract, not a wall-clock or FPS assertion.
    expect(result.visitedSegments).toBe(segmentCount);
    expect(result.emittedSegments).toBe(segmentCount);
    expect(result.indices.length).toBe(segmentCount);
    expect(result.indices[0]).toBe(0);
    expect(result.indices[segmentCount - 1]).toBe(segmentCount - 1);
  });
});
